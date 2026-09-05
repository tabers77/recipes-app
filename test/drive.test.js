/* Tests for the sync engine in public/drive.js -- node test/drive.test.js
 *
 * The parts worth asserting are the merge rules and the orchestration around
 * them, and neither should need a Google account to run. Both are written to
 * take their Drive calls as an argument, so this drives them with an in-memory
 * fake: a revision counter, a JSON blob, and a store that can be changed behind
 * the engine's back to stage a conflict.
 *
 * What is NOT covered here: OAuth, and the shape of the real Drive HTTP calls.
 * Those need the live API and a browser.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const DRIVE_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'drive.js'), 'utf8');
const DB_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'db.js'), 'utf8');

const T0 = Date.parse('2026-09-05T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- the module
function loadDrive() {
  const sandbox = {
    window: {}, document: { createElement: () => ({}), head: { appendChild() {} } },
    navigator: { onLine: true }, fetch: () => { throw new Error('no network in tests'); },
    Date, Math, Map, JSON, Promise, console, setTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(DRIVE_SRC, sandbox);
  return sandbox.window.Drive.__test;
}

// ------------------------------------------------------------------- fake db
/* An in-memory stand-in with the three methods runSync uses. Simpler than the
   IndexedDB fake in db.test.js and sufficient: db.js itself is tested there. */
function fakeDb(records) {
  const rows = new Map((records || []).map((r) => [r.id, r]));
  const meta = new Map();
  return {
    allRaw: async () => [...rows.values()].map((r) => Object.assign({}, r)),
    saveMany: async (list) => { for (const r of list) rows.set(r.id, r); return list.length; },
    metaGet: async (k, fallback) => (meta.has(k) ? meta.get(k) : (fallback === undefined ? null : fallback)),
    metaSet: async (k, v) => { meta.set(k, v); },
    _rows: rows,
    _meta: meta
  };
}

// ---------------------------------------------------------------- fake drive
function fakeDrive(initial) {
  const store = {
    exists: initial !== undefined,
    id: 'file_1',
    revision: 'rev1',
    records: initial || [],
    writes: 0,
    reads: 0,
    // Set to a function to mutate the store between the engine's read and its
    // write, which is how a mid-sync conflict is staged.
    beforeWrite: null
  };

  const api = {
    locate: async () => (store.exists ? store.id : null),
    readFile: async (id) => { store.reads++; return store.records.map((r) => Object.assign({}, r)); },
    revisionOf: async (id) => {
      if (store.beforeWrite) { const f = store.beforeWrite; store.beforeWrite = null; f(store); }
      return store.exists ? store.revision : null;
    },
    writeFile: async (id, payload) => {
      store.writes++;
      store.records = payload.recipes;
      store.revision = 'rev' + (store.writes + 1);
      return store.revision;
    },
    createFile: async (payload) => {
      store.exists = true;
      store.writes++;
      store.records = payload.recipes;
      store.revision = 'rev1';
      return { id: store.id, revision: store.revision };
    }
  };
  return { api, store };
}

function recipe(id, title, updatedAt, deletedAt) {
  return {
    id, title,
    categories: [], ingredients: [], steps: [], links: [], notes: '',
    createdAt: updatedAt, updatedAt, deletedAt: deletedAt || null
  };
}

/* Values built inside the vm sandbox carry that realm's Array/Object
   prototype, so assert.deepStrictEqual reports "same structure but not
   reference-equal" on a plain array of strings. The JSON round-trip brings the
   value back into this realm and keeps the comparison strict on values. */
function sameShape(actual, expected, message) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
}

// -------------------------------------------------------------------- runner
let passed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed++; }
  catch (err) { failures.push(name + '\n    ' + (err && err.message)); }
}

// --------------------------------------------------------------------- tests
(async () => {
  const { mergeRecords, purgeOldTombstones, runSync } = loadDrive();

  // ------------------------------------------------------------------ merge
  await test('merge takes the union when there is no overlap', () => {
    const out = mergeRecords([recipe('a', 'A', '2026-01-01T00:00:00Z')],
                             [recipe('b', 'B', '2026-01-01T00:00:00Z')]);
    sameShape(out.map((r) => r.id).sort(), ['a', 'b']);
  });

  await test('merge keeps the later edit, whichever side it is on', () => {
    const older = recipe('a', 'old', '2026-01-01T00:00:00Z');
    const newer = recipe('a', 'new', '2026-06-01T00:00:00Z');
    assert.strictEqual(mergeRecords([older], [newer])[0].title, 'new');
    assert.strictEqual(mergeRecords([newer], [older])[0].title, 'new');
  });

  await test('a tombstone beats an older edit', () => {
    const edit = recipe('a', 'edited', '2026-01-01T00:00:00Z');
    const gone = recipe('a', 'edited', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z');
    assert.ok(mergeRecords([edit], [gone])[0].deletedAt, 'the delete was lost');
  });

  await test('a newer edit beats an older tombstone', () => {
    // Deliberate: re-creating something you deleted must stick.
    const gone = recipe('a', 'x', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    const edit = recipe('a', 'back again', '2026-06-01T00:00:00Z');
    assert.strictEqual(mergeRecords([gone], [edit])[0].deletedAt, null);
  });

  await test('on an exact timestamp tie the tombstone wins', () => {
    const stamp = '2026-06-01T00:00:00Z';
    const edit = recipe('a', 'edited', stamp);
    const gone = recipe('a', 'gone', stamp, stamp);
    assert.ok(mergeRecords([edit], [gone])[0].deletedAt, 'local-first order resurrected it');
    assert.ok(mergeRecords([gone], [edit])[0].deletedAt, 'remote-first order resurrected it');
  });

  await test('merge ignores records with no id rather than crashing', () => {
    const out = mergeRecords([null, {}, recipe('a', 'A', '2026-01-01T00:00:00Z')], []);
    sameShape(out.map((r) => r.id), ['a']);
  });

  // ------------------------------------------------------------- tombstones
  await test('tombstones are kept while any device might still be unaware', () => {
    const recent = recipe('a', 'x', 'i', new Date(T0 - 10 * DAY).toISOString());
    assert.strictEqual(purgeOldTombstones([recent], T0).length, 1);
  });

  await test('tombstones older than 90 days are dropped', () => {
    const ancient = recipe('a', 'x', 'i', new Date(T0 - 91 * DAY).toISOString());
    assert.strictEqual(purgeOldTombstones([ancient], T0).length, 0);
  });

  await test('live records are never purged', () => {
    const live = recipe('a', 'x', '2020-01-01T00:00:00Z');
    assert.strictEqual(purgeOldTombstones([live], T0).length, 1);
  });

  // ---------------------------------------------------------------- runSync
  await test('first sync with nothing in Drive creates the file', async () => {
    const db = fakeDb([recipe('a', 'Carbonara', '2026-09-01T00:00:00Z')]);
    const { api, store } = fakeDrive();          // no remote file
    const result = await runSync(api, db, T0);

    assert.strictEqual(store.exists, true, 'no file was created');
    assert.strictEqual(store.records.length, 1);
    assert.strictEqual(result.fileId, 'file_1');
    assert.strictEqual(await db.metaGet('driveFileId'), 'file_1');
    assert.strictEqual(await db.metaGet('driveRevision'), 'rev1');
  });

  await test('a remote-only recipe is pulled into the local store', async () => {
    const db = fakeDb([]);
    const { api } = fakeDrive([recipe('b', 'From the laptop', '2026-09-01T00:00:00Z')]);
    const result = await runSync(api, db, T0);
    assert.strictEqual(result.pulled, 1);
    assert.ok(db._rows.has('b'), 'the remote recipe never landed locally');
  });

  await test('a local-only recipe is pushed to Drive', async () => {
    const db = fakeDb([recipe('a', 'From the phone', '2026-09-01T00:00:00Z')]);
    const { api, store } = fakeDrive([]);
    await runSync(api, db, T0);
    sameShape(store.records.map((r) => r.id), ['a']);
  });

  await test('both sides survive a two-device merge', async () => {
    const db = fakeDb([recipe('a', 'phone', '2026-09-01T00:00:00Z')]);
    const { api, store } = fakeDrive([recipe('b', 'laptop', '2026-09-02T00:00:00Z')]);
    await runSync(api, db, T0);
    sameShape([...db._rows.keys()].sort(), ['a', 'b']);
    sameShape(store.records.map((r) => r.id).sort(), ['a', 'b']);
  });

  await test('a delete on one device removes it from the other', async () => {
    const db = fakeDb([recipe('a', 'doomed', '2026-09-01T00:00:00Z')]);
    const gone = recipe('a', 'doomed', '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z');
    const { api } = fakeDrive([gone]);
    await runSync(api, db, T0);
    assert.ok(db._rows.get('a').deletedAt, 'the local copy was not tombstoned');
  });

  await test('an unchanged revision does not re-read the file', async () => {
    const db = fakeDb([recipe('a', 'x', '2026-09-01T00:00:00Z')]);
    const { api, store } = fakeDrive([]);
    await runSync(api, db, T0);            // binds and records the revision
    const readsAfterFirst = store.reads;
    await runSync(api, db, T0 + 1000);     // nothing changed remotely
    assert.strictEqual(store.reads, readsAfterFirst,
      're-downloaded the whole file with no remote change');
  });

  await test('a remote write between our read and our write aborts the push', async () => {
    const db = fakeDb([recipe('a', 'mine', '2026-09-01T00:00:00Z')]);
    const { api, store } = fakeDrive([]);
    await runSync(api, db, T0);            // bind

    db._rows.set('a', recipe('a', 'edited on the phone', '2026-09-04T00:00:00Z'));
    let calls = 0;
    store.beforeWrite = null;
    const originalRevisionOf = api.revisionOf;
    api.revisionOf = async (id) => {
      calls++;
      // The second call is the pre-write re-check; move the revision there, as
      // the other device writing at that instant would.
      if (calls === 2) store.revision = 'rev_from_the_laptop';
      return originalRevisionOf(id);
    };

    const writesBefore = store.writes;
    const result = await runSync(api, db, T0 + 2000);
    assert.strictEqual(store.writes, writesBefore, 'overwrote a concurrent remote change');
    assert.ok(result.skipped, 'the skip was not reported');
    api.revisionOf = originalRevisionOf;
  });

  await test('a deleted remote file is rebound rather than treated as an error', async () => {
    const db = fakeDb([recipe('a', 'x', '2026-09-01T00:00:00Z')]);
    const { api, store } = fakeDrive([]);
    await runSync(api, db, T0);

    store.exists = false;                  // deleted in Drive by hand
    const result = await runSync(api, db, T0 + 1000);
    assert.strictEqual(store.exists, true, 'the file was not recreated');
    assert.ok(result.fileId, 'no file id after rebinding');
    sameShape(store.records.map((r) => r.id), ['a'],
      'local recipes were lost when the remote file vanished');
  });

  await test('the local merge is applied even when the push is skipped', async () => {
    // The device must keep what it learned; only the upload is deferred.
    const db = fakeDb([]);
    const { api, store } = fakeDrive([recipe('b', 'remote', '2026-09-02T00:00:00Z')]);
    let calls = 0;
    const original = api.revisionOf;
    api.revisionOf = async (id) => {
      calls++;
      if (calls === 2) store.revision = 'moved';
      return original(id);
    };
    await runSync(api, db, T0);
    assert.ok(db._rows.has('b'), 'the pulled record was dropped along with the push');
  });

  await test('an old tombstone is dropped from Drive but the file is still written', async () => {
    const ancient = recipe('a', 'x', new Date(T0 - 100 * DAY).toISOString(),
                                     new Date(T0 - 100 * DAY).toISOString());
    const db = fakeDb([ancient, recipe('b', 'live', '2026-09-01T00:00:00Z')]);
    const { api, store } = fakeDrive([]);
    await runSync(api, db, T0);
    sameShape(store.records.map((r) => r.id), ['b']);
  });

  await test('syncing twice with no changes is stable', async () => {
    const db = fakeDb([recipe('a', 'x', '2026-09-01T00:00:00Z')]);
    const { api, store } = fakeDrive([]);
    await runSync(api, db, T0);
    const first = JSON.stringify(store.records);
    const second = await runSync(api, db, T0 + 5000);
    assert.strictEqual(JSON.stringify(store.records), first, 'the file churned on a no-op sync');
    assert.strictEqual(second.pulled, 0, 'a no-op sync claimed to pull records');
  });

  // ------------------------------------------------------------------ report
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  for (const f of failures) console.log('  FAIL  ' + f);
  process.exit(failures.length ? 1 : 0);
})();
