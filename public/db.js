/* IndexedDB wrapper -- PLAN.md section 3.
 *
 * The source of truth on the device. Every write here is instant and works
 * offline; Drive sync (Phase 4) reconciles in the background and is never in
 * the path of a user action.
 *
 * Two object stores, both created at version 1:
 *   recipes   keyPath 'id'   -- the records themselves
 *   syncMeta  keyPath 'key'  -- unused until Phase 4, created now so that
 *                               adding sync needs no version bump / migration
 */
/* Scoped so nothing but window.DB reaches the global object. These are
   classic scripts sharing one global scope: db.js and app.js both wanted a
   top-level `save`, and drive.js and app.js both wanted `query` -- the
   second of which is a hard SyntaxError that stops app.js loading at all. */
(function () {
  'use strict';

  const DB_NAME = 'recipes-app';
  const DB_VERSION = 1;

  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('recipes')) {
          const store = db.createObjectStore('recipes', { keyPath: 'id' });
          // Sync pulls "everything changed since X", so updatedAt is indexed.
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('syncMeta')) {
          db.createObjectStore('syncMeta', { keyPath: 'key' });
        }
      };

      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  /* Writes. Resolves on transaction completion, not on request success: a
     request can succeed and the transaction still abort, and resolving then
     would report a durable write that never happened. */
  function write(storeName, work) {
    return open().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      work(transaction.objectStore(storeName));
    }));
  }

  /* Reads. A read transaction has nothing to roll back, so the request result
     is the answer. */
  function read(storeName, work) {
    return open().then((db) => {
      const store = db.transaction(storeName, 'readonly').objectStore(storeName);
      return request(work(store));
    });
  }

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---------------------------------------------------------------- ids
  /* Client-generated so a recipe has an identity before it ever reaches Drive.
     crypto.randomUUID is not available on every browser/context we care about,
     so this uses getRandomValues, which is. */
  function newId() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return 'r_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function nowIso() {
    return new Date().toISOString();
  }

  // ---------------------------------------------------------------- records
  /* One place that decides what a recipe record looks like. Anything reading a
     record -- the UI, an import, a Drive pull -- goes through this, so a file
     written by an older version of the app still loads with sane defaults. */
  function normalize(raw) {
    const r = raw || {};
    return {
      id: r.id || newId(),
      title: String(r.title || '').trim(),
      categories: Array.isArray(r.categories) ? r.categories.filter(Boolean) : [],
      servings: Number.isFinite(r.servings) ? r.servings : null,
      timeMinutes: Number.isFinite(r.timeMinutes) ? r.timeMinutes : null,
      ingredients: Array.isArray(r.ingredients) ? r.ingredients.filter(Boolean) : [],
      steps: Array.isArray(r.steps) ? r.steps.filter(Boolean) : [],
      links: Array.isArray(r.links)
        ? r.links.filter((l) => l && l.url).map((l) => ({
            url: String(l.url),
            label: String(l.label || '')
          }))
        : [],
      notes: String(r.notes || ''),
      imageIds: Array.isArray(r.imageIds) ? r.imageIds : [],   // reserved, Phase 5
      createdAt: r.createdAt || nowIso(),
      updatedAt: r.updatedAt || nowIso(),
      deletedAt: r.deletedAt || null
    };
  }

  // ---------------------------------------------------------------- api
  /* Returns live recipes only. Tombstones exist for sync (PLAN.md section 4) and
     must never surface in the UI. */
  async function all() {
    const rows = await read('recipes', (store) => store.getAll());
    return rows.filter((r) => !r.deletedAt).map(normalize);
  }

  /* Including tombstones. For export and, later, for the sync engine. */
  async function allRaw() {
    const rows = await read('recipes', (store) => store.getAll());
    return rows.map(normalize);
  }

  async function get(id) {
    const row = await read('recipes', (store) => store.get(id));
    return row && !row.deletedAt ? normalize(row) : null;
  }

  /* Create or update. Always stamps updatedAt -- that timestamp is what the sync
     merge compares, so a write that skipped it would silently lose to the remote. */
  async function save(recipe) {
    const record = normalize(recipe);
    record.updatedAt = nowIso();
    await write('recipes', (store) => { store.put(record); });
    return record;
  }

  /* Soft delete. A hard delete cannot be synced: the other device would see a
     record it has and we don't, and helpfully re-add it. */
  async function remove(id) {
    const row = await read('recipes', (store) => store.get(id));
    if (!row) return;
    const record = normalize(row);
    record.deletedAt = nowIso();
    record.updatedAt = record.deletedAt;
    await write('recipes', (store) => { store.put(record); });
  }

  /* Import merges rather than replaces, using the same last-write-wins rule the
     Drive sync will use. Importing an old export therefore cannot clobber newer
     local edits. */
  async function importAll(records) {
    const incoming = (records || []).map(normalize);
    const existing = new Map((await allRaw()).map((r) => [r.id, r]));
    let added = 0;
    let updated = 0;
    const toWrite = [];
    for (const rec of incoming) {
      const mine = existing.get(rec.id);
      if (!mine) { toWrite.push(rec); added++; continue; }
      if (rec.updatedAt > mine.updatedAt) { toWrite.push(rec); updated++; }
    }
    if (toWrite.length) {
      await write('recipes', (store) => {
        for (const rec of toWrite) store.put(rec);
      });
    }
    return { added, updated, skipped: incoming.length - added - updated };
  }

  // ---------------------------------------------------------------- sync meta
  /* Small durable key/value scratchpad for the sync engine: which Drive file we
     are bound to, its revision at our last pull, when we last succeeded. Kept in
     IndexedDB rather than localStorage so it cannot drift out of step with the
     records it describes -- both survive or neither does. */
  async function metaGet(key, fallback) {
    const row = await read('syncMeta', (store) => store.get(key));
    return row ? row.value : fallback;
  }

  function metaSet(key, value) {
    return write('syncMeta', (store) => { store.put({ key: key, value: value }); });
  }

  /* Write a merged set in one transaction. Used by the sync engine, where a
     half-applied merge would leave the local store disagreeing with the revision
     we are about to record as pulled. */
  function saveMany(records) {
    const normalized = (records || []).map(normalize);
    if (!normalized.length) return Promise.resolve(0);
    return write('recipes', (store) => {
      for (const rec of normalized) store.put(rec);
    }).then(() => normalized.length);
  }

  window.DB = {
    all, allRaw, get, save, saveMany, remove, importAll,
    metaGet, metaSet,
    normalize, newId, nowIso
  };
})();
