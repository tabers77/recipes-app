/* Google Drive sync -- PLAN.md Phase 4.
 *
 * Drive is NOT the database. It has no queries and no partial writes, so every
 * edit would otherwise be a full-file round trip over the network. IndexedDB
 * stays the source of truth and this reconciles it with one JSON file in a
 * folder you can see in your own Drive.
 *
 * Nothing here is in the path of a user action. Saving a recipe writes to
 * IndexedDB and returns; sync happens afterwards, in the background, and its
 * failure is a status line rather than an error.
 *
 * Scope is drive.file -- the app can only touch files it created. That keeps
 * the folder visible in Drive (unlike appDataFolder) and avoids the review that
 * the broader scopes trigger. The consequence: if you delete or recreate
 * recipes.json by hand, the app loses access to it and rebinds to a new file.
 *
 * The OAuth client ID lives in config.js. It is public by design -- what
 * actually restricts it is the authorized JavaScript origins list on the Google
 * Cloud credential, not secrecy.
 */
'use strict';

var SCOPE = 'https://www.googleapis.com/auth/drive.file';
var FOLDER_NAME = 'Recipes';
var FILE_NAME = 'recipes.json';
var GIS_SRC = 'https://accounts.google.com/gsi/client';

var API = 'https://www.googleapis.com/drive/v3';
var UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/* Tombstones are kept long enough that every device has certainly synced, then
   dropped. Purging early is what resurrects a deleted recipe: a device that
   still holds the record and never saw the tombstone re-adds it as new. */
var TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------- merge
/* Last-write-wins per recipe, with one deliberate asymmetry: on an exact
   timestamp tie the tombstone wins. A tie means we cannot order the two edits,
   and re-deleting is recoverable from a backup whereas an un-noticed
   resurrection quietly undoes a deletion the user meant. */
function mergeRecords(local, remote) {
  var byId = new Map();

  function consider(record) {
    if (!record || !record.id) return;
    var existing = byId.get(record.id);
    if (!existing) { byId.set(record.id, record); return; }

    var mine = String(record.updatedAt || '');
    var theirs = String(existing.updatedAt || '');
    if (mine > theirs) { byId.set(record.id, record); return; }
    if (mine === theirs && record.deletedAt && !existing.deletedAt) {
      byId.set(record.id, record);
    }
  }

  (local || []).forEach(consider);
  (remote || []).forEach(consider);
  return [...byId.values()];
}

/* Applied only when writing to Drive. A tombstone that is still local-only has
   not necessarily reached the other device yet. */
function purgeOldTombstones(records, nowMs) {
  return records.filter(function (r) {
    if (!r.deletedAt) return true;
    return (nowMs - Date.parse(r.deletedAt)) < TOMBSTONE_TTL_MS;
  });
}

// -------------------------------------------------------------- sync engine
/* The orchestration, with the Drive HTTP calls injected. Written this way so
   the merge/conflict rules can be tested against a fake Drive rather than only
   against the real one.
 *
 * api:  { locate, readFile, revisionOf, writeFile, createFile }
 * db:   the DB module from db.js
 *
 * Returns { pulled, pushed, fileId, revision, skipped }.
 */
async function runSync(api, db, nowMs) {
  var fileId = await db.metaGet('driveFileId', null);
  var knownRevision = await db.metaGet('driveRevision', null);

  if (!fileId) {
    fileId = await api.locate();          // null when nothing exists yet
    knownRevision = null;
  }

  var local = await db.allRaw();
  var remote = [];
  var revision = null;

  if (fileId) {
    revision = await api.revisionOf(fileId);
    if (revision === null) {
      // The file is gone -- deleted or un-shared out from under us. Rebind
      // rather than fail, and treat local as authoritative.
      fileId = null;
      knownRevision = null;
    } else if (revision !== knownRevision) {
      // Somebody else wrote since our last pull. Only then is a read worth
      // the round trip.
      remote = await api.readFile(fileId);
    }
  }

  var merged = mergeRecords(local, remote);
  var toWrite = purgeOldTombstones(merged, nowMs);

  // Apply the merge locally first. If the upload then fails, the device still
  // has everything it learned, and the next sync retries the push.
  var incoming = merged.filter(function (r) {
    var mine = local.find(function (l) { return l.id === r.id; });
    return !mine || mine.updatedAt !== r.updatedAt;
  });
  if (incoming.length) await db.saveMany(incoming);

  var payload = {
    schemaVersion: 1,
    updatedAt: new Date(nowMs).toISOString(),
    recipes: toWrite
  };

  var newRevision;
  if (!fileId) {
    var created = await api.createFile(payload);
    fileId = created.id;
    newRevision = created.revision;
  } else {
    // Re-check immediately before writing. This narrows, but cannot close, the
    // window where the other device writes between our read and our write --
    // Drive has no compare-and-swap on upload. For one person with two devices
    // the residual race needs simultaneous edits on both, and the loser's
    // change survives in its own IndexedDB until its next sync.
    var current = await api.revisionOf(fileId);
    if (current !== null && current !== revision && current !== knownRevision) {
      return { pulled: incoming.length, pushed: 0, fileId: fileId,
               revision: knownRevision, skipped: 'remote changed mid-sync' };
    }
    newRevision = await api.writeFile(fileId, payload);
  }

  await db.metaSet('driveFileId', fileId);
  await db.metaSet('driveRevision', newRevision);
  await db.metaSet('lastSyncedAt', new Date(nowMs).toISOString());

  return { pulled: incoming.length, pushed: toWrite.length,
           fileId: fileId, revision: newRevision, skipped: null };
}

// --------------------------------------------------------------------- auth
var accessToken = null;       // in memory only, never persisted
var tokenExpiry = 0;
var tokenClient = null;

function clientId() {
  return (window.RECIPES_CONFIG && window.RECIPES_CONFIG.googleClientId) || '';
}

function isConfigured() {
  return Boolean(clientId());
}

function loadGis() {
  if (window.google && window.google.accounts) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    var script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = resolve;
    // Offline, or a blocked third-party script. Not an error worth a stack
    // trace: the app works, it just cannot sync right now.
    script.onerror = function () { reject(new Error('Google sign-in did not load')); };
    document.head.appendChild(script);
  });
}

/* interactive=false attempts a silent grant, which succeeds whenever there is a
   live Google session in this browser. Browser tokens last about an hour and
   there is no refresh token in this flow, so this runs often and mostly
   without the user seeing anything. */
function requestToken(interactive) {
  return loadGis().then(function () {
    return new Promise(function (resolve, reject) {
      if (!tokenClient) {
        tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId(),
          scope: SCOPE,
          callback: function (response) {
            if (response && response.access_token) {
              accessToken = response.access_token;
              tokenExpiry = Date.now() + (Number(response.expires_in || 3600) - 60) * 1000;
              resolve(accessToken);
            } else {
              reject(new Error((response && response.error) || 'no access token'));
            }
          },
          error_callback: function (err) {
            reject(new Error((err && err.type) || 'sign-in was dismissed'));
          }
        });
      } else {
        tokenClient.callback = function (response) {
          if (response && response.access_token) {
            accessToken = response.access_token;
            tokenExpiry = Date.now() + (Number(response.expires_in || 3600) - 60) * 1000;
            resolve(accessToken);
          } else {
            reject(new Error((response && response.error) || 'no access token'));
          }
        };
      }
      tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    });
  });
}

function token(interactive) {
  if (accessToken && Date.now() < tokenExpiry) return Promise.resolve(accessToken);
  return requestToken(Boolean(interactive));
}

// ---------------------------------------------------------------- drive api
async function call(path, options) {
  var opts = options || {};
  var response = await fetch(path, {
    method: opts.method || 'GET',
    headers: Object.assign(
      { Authorization: 'Bearer ' + (await token(false)) },
      opts.headers || {}
    ),
    body: opts.body
  });

  if (response.status === 401) {
    // The token expired mid-flight. One silent retry; if the Google session is
    // also gone, this surfaces and the user taps to sign in again.
    accessToken = null;
    response = await fetch(path, {
      method: opts.method || 'GET',
      headers: Object.assign(
        { Authorization: 'Bearer ' + (await token(false)) },
        opts.headers || {}
      ),
      body: opts.body
    });
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error('Drive ' + response.status + ' on ' + path.split('?')[0]);
  }
  return opts.raw ? response.text() : response.json();
}

function query(q) {
  return "?q=" + encodeURIComponent(q) + "&spaces=drive&fields=files(id,name)";
}

/* Only ever finds files this app created -- that is what drive.file means --
   so there is no risk of binding to somebody else's recipes.json. */
async function locate() {
  var found = await call(API + '/files' +
    query("name='" + FILE_NAME + "' and trashed=false"));
  return (found && found.files && found.files.length) ? found.files[0].id : null;
}

async function folderId() {
  var found = await call(API + '/files' + query(
    "mimeType='application/vnd.google-apps.folder' and name='" +
    FOLDER_NAME + "' and trashed=false"));
  if (found && found.files && found.files.length) return found.files[0].id;

  var created = await call(API + '/files?fields=id', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder'
    })
  });
  return created.id;
}

/* null means the file is gone, which the sync engine treats as "rebind", not
   as an error. */
async function revisionOf(id) {
  var meta = await call(API + '/files/' + id + '?fields=headRevisionId,modifiedTime');
  if (!meta) return null;
  // Not every Drive file exposes headRevisionId; modifiedTime is the fallback
  // and changes on every write, which is all this needs to detect.
  return meta.headRevisionId || meta.modifiedTime || null;
}

async function readFile(id) {
  var text = await call(API + '/files/' + id + '?alt=media', { raw: true });
  if (!text) return [];
  try {
    var parsed = JSON.parse(text);
    var list = Array.isArray(parsed) ? parsed : parsed.recipes;
    return Array.isArray(list) ? list : [];
  } catch (e) {
    // A corrupt remote file must not take the local data with it. Treat it as
    // empty; the merge then pushes the local set back over it.
    return [];
  }
}

async function writeFile(id, payload) {
  var meta = await call(UPLOAD + '/files/' + id +
    '?uploadType=media&fields=headRevisionId,modifiedTime', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  return (meta && (meta.headRevisionId || meta.modifiedTime)) || null;
}

async function createFile(payload) {
  var parent = await folderId();
  var boundary = 'rcp' + Math.random().toString(36).slice(2);
  var body =
    '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify({ name: FILE_NAME, parents: [parent] }) + '\r\n' +
    '--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' +
    JSON.stringify(payload) + '\r\n' +
    '--' + boundary + '--';

  var meta = await call(UPLOAD + '/files?uploadType=multipart&fields=id,headRevisionId,modifiedTime', {
    method: 'POST',
    headers: { 'content-type': 'multipart/related; boundary=' + boundary },
    body: body
  });
  return { id: meta.id, revision: meta.headRevisionId || meta.modifiedTime || null };
}

var realApi = {
  locate: locate,
  readFile: readFile,
  revisionOf: revisionOf,
  writeFile: writeFile,
  createFile: createFile
};

// -------------------------------------------------------------------- public
var state = { phase: 'idle', lastSyncedAt: null, error: null };
var inFlight = null;

function status() { return state; }

/* interactive: true is the "Connect" button -- it may open a Google popup.
   Everything else calls this with false, which stays silent or gives up. */
function sync(interactive) {
  if (inFlight) return inFlight;          // never two syncs at once
  if (!isConfigured()) {
    state = { phase: 'unconfigured', lastSyncedAt: state.lastSyncedAt, error: null };
    return Promise.resolve(state);
  }
  if (!navigator.onLine) {
    state = { phase: 'offline', lastSyncedAt: state.lastSyncedAt, error: null };
    return Promise.resolve(state);
  }

  state = { phase: 'syncing', lastSyncedAt: state.lastSyncedAt, error: null };

  inFlight = token(interactive)
    .then(function () { return runSync(realApi, window.DB, Date.now()); })
    .then(function (result) {
      state = {
        phase: result.skipped ? 'retry' : 'ok',
        lastSyncedAt: new Date().toISOString(),
        error: result.skipped || null
      };
      return state;
    })
    .catch(function (err) {
      state = {
        phase: 'error',
        lastSyncedAt: state.lastSyncedAt,
        error: (err && err.message) || 'sync failed'
      };
      return state;
    })
    .then(function (final) { inFlight = null; return final; });

  return inFlight;
}

window.Drive = {
  sync: sync,
  status: status,
  isConfigured: isConfigured,
  // Exposed for tests: the merge rules and the orchestration are the parts
  // worth asserting, and neither should need a real Google account to run.
  __test: { mergeRecords: mergeRecords, purgeOldTombstones: purgeOldTombstones, runSync: runSync }
};
