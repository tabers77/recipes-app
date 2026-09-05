/* Tests for public/db.js -- run with: node test/db.test.js
 *
 * db.js is where the bugs that matter live: transaction completion, tombstone
 * handling, and the last-write-wins merge that Phase 4's Drive sync will reuse.
 * The UI on top of it is verified by opening it in a browser.
 *
 * IndexedDB is faked in-memory here rather than pulled from npm, because the
 * app itself has zero dependencies and a test-only npm tree is not worth it
 * for the handful of IDB calls db.js actually makes.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// ------------------------------------------------------------ fake IndexedDB
function makeFakeIndexedDB() {
  const databases = new Map();

  function makeRequest(compute) {
    const req = { onsuccess: null, onerror: null, result: undefined };
    // Async on purpose: real IDB never calls back synchronously, and code that
    // accidentally relies on synchronous results must fail here too.
    setTimeout(() => {
      try {
        req.result = compute();
        if (req.onsuccess) req.onsuccess({ target: req });
      } catch (err) {
        req.error = err;
        if (req.onerror) req.onerror({ target: req });
      }
    }, 0);
    return req;
  }

  function makeStore(data, tx) {
    return {
      createIndex() { /* indexes are not queried by db.js yet */ },
      get(key) {
        tx.pending++;
        const r = makeRequest(() => data.get(key));
        setTimeout(() => { tx.pending--; }, 0);
        return r;
      },
      getAll() {
        tx.pending++;
        const r = makeRequest(() => [...data.values()]);
        setTimeout(() => { tx.pending--; }, 0);
        return r;
      },
      put(record) {
        tx.pending++;
        const r = makeRequest(() => {
          data.set(record.id, JSON.parse(JSON.stringify(record)));
          return record.id;
        });
        setTimeout(() => { tx.pending--; }, 0);
        return r;
      }
    };
  }

  return {
    open(name, version) {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => {
        let db = databases.get(name);
        const fresh = !db;
        if (fresh) {
          db = { name, version, stores: new Map() };
          databases.set(name, db);
        }

        const dbHandle = {
          objectStoreNames: { contains: (n) => db.stores.has(n) },
          createObjectStore(n) {
            db.stores.set(n, new Map());
            return makeStore(db.stores.get(n), { pending: 0 });
          },
          transaction(storeName) {
            const tx = {
              pending: 0,
              oncomplete: null, onerror: null, onabort: null
            };
            tx.objectStore = () => makeStore(db.stores.get(storeName), tx);
            // Drain: fire oncomplete once every request issued on this
            // transaction has settled, mirroring real IDB ordering.
            const drain = () => {
              if (tx.pending > 0) { setTimeout(drain, 0); return; }
              if (tx.oncomplete) tx.oncomplete();
            };
            setTimeout(drain, 0);
            return tx;
          }
        };

        if (fresh && req.onupgradeneeded) {
          req.onupgradeneeded({ target: { result: dbHandle } });
        }
        req.result = dbHandle;
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    },
    _reset() { databases.clear(); }
  };
}

// ------------------------------------------------------------------- harness
function loadDB() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'db.js'), 'utf8');
  const fakeIdb = makeFakeIndexedDB();
  const sandbox = {
    window: {},
    indexedDB: fakeIdb,
    crypto: require('crypto').webcrypto,
    setTimeout,
    clearTimeout,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { DB: sandbox.window.DB, idb: fakeIdb };
}

/* Objects created inside the vm sandbox have that realm's Object prototype, so
   assert.deepStrictEqual reports "same structure but not reference-equal" on a
   plain array. The JSON round-trip brings the value back into this realm while
   keeping the comparison strict on values. */
function sameShape(actual, expected, message) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
}

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(name + '\n    ' + (err && err.message));
  }
}

// --------------------------------------------------------------------- tests
(async () => {
  await test('normalize fills defaults for an empty object', () => {
    const { DB } = loadDB();
    const r = DB.normalize({});
    assert.strictEqual(r.title, '');
    sameShape(r.categories, []);
    sameShape(r.links, []);
    assert.strictEqual(r.deletedAt, null);
    assert.ok(/^r_[0-9a-f]{12}$/.test(r.id), 'generated id: ' + r.id);
    assert.ok(r.createdAt && r.updatedAt);
  });

  await test('normalize coerces junk types instead of throwing', () => {
    const { DB } = loadDB();
    const r = DB.normalize({
      title: 42, categories: 'Pasta', ingredients: null,
      servings: 'two', links: [{ label: 'x' }, { url: 'https://a' }]
    });
    assert.strictEqual(r.title, '42');
    sameShape(r.categories, []);      // a string is not an array
    sameShape(r.ingredients, []);
    assert.strictEqual(r.servings, null);          // 'two' is not finite
    assert.strictEqual(r.links.length, 1);         // the entry with no url drops
    assert.strictEqual(r.links[0].url, 'https://a');
  });

  await test('normalize preserves an existing id and createdAt', () => {
    const { DB } = loadDB();
    const r = DB.normalize({ id: 'r_abc', createdAt: '2020-01-01T00:00:00.000Z' });
    assert.strictEqual(r.id, 'r_abc');
    assert.strictEqual(r.createdAt, '2020-01-01T00:00:00.000Z');
  });

  await test('newId does not collide over 5000 draws', () => {
    const { DB } = loadDB();
    const seen = new Set();
    for (let i = 0; i < 5000; i++) seen.add(DB.newId());
    assert.strictEqual(seen.size, 5000);
  });

  await test('save then get round-trips a recipe', async () => {
    const { DB } = loadDB();
    const saved = await DB.save({ title: 'Carbonara', categories: ['Pasta'] });
    const got = await DB.get(saved.id);
    assert.strictEqual(got.title, 'Carbonara');
    sameShape(got.categories, ['Pasta']);
  });

  await test('save always stamps updatedAt, even if the caller supplied an old one', async () => {
    const { DB } = loadDB();
    const saved = await DB.save({ title: 'x', updatedAt: '2000-01-01T00:00:00.000Z' });
    assert.ok(saved.updatedAt > '2020-01-01', 'updatedAt was not restamped: ' + saved.updatedAt);
  });

  await test('all() returns every live recipe', async () => {
    const { DB } = loadDB();
    await DB.save({ title: 'a' });
    await DB.save({ title: 'b' });
    const list = await DB.all();
    assert.strictEqual(list.length, 2);
  });

  await test('remove() soft-deletes: gone from all() and get(), kept in allRaw()', async () => {
    const { DB } = loadDB();
    const saved = await DB.save({ title: 'doomed' });
    await DB.remove(saved.id);

    assert.strictEqual((await DB.all()).length, 0, 'all() still shows it');
    assert.strictEqual(await DB.get(saved.id), null, 'get() still returns it');

    const raw = await DB.allRaw();
    assert.strictEqual(raw.length, 1, 'tombstone was not kept');
    assert.ok(raw[0].deletedAt, 'deletedAt not set');
  });

  await test('remove() on an unknown id is a no-op, not a crash', async () => {
    const { DB } = loadDB();
    await DB.remove('r_nope');
    assert.strictEqual((await DB.allRaw()).length, 0);
  });

  await test('import adds records that are not present locally', async () => {
    const { DB } = loadDB();
    const res = await DB.importAll([
      { id: 'r_1', title: 'One', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'r_2', title: 'Two', updatedAt: '2026-01-01T00:00:00.000Z' }
    ]);
    sameShape(res, { added: 2, updated: 0, skipped: 0 });
    assert.strictEqual((await DB.all()).length, 2);
  });

  await test('import does NOT clobber a newer local edit', async () => {
    const { DB } = loadDB();
    const mine = await DB.save({ title: 'my newer title' });   // updatedAt = now
    const res = await DB.importAll([
      { id: mine.id, title: 'stale backup title', updatedAt: '2020-01-01T00:00:00.000Z' }
    ]);
    sameShape(res, { added: 0, updated: 0, skipped: 1 });
    assert.strictEqual((await DB.get(mine.id)).title, 'my newer title');
  });

  await test('import DOES apply a newer incoming edit', async () => {
    const { DB } = loadDB();
    const mine = await DB.save({ title: 'old' });
    const res = await DB.importAll([
      { id: mine.id, title: 'newer', updatedAt: '2099-01-01T00:00:00.000Z' }
    ]);
    sameShape(res, { added: 0, updated: 1, skipped: 0 });
    assert.strictEqual((await DB.get(mine.id)).title, 'newer');
  });

  await test('importing a backup cannot resurrect a deleted recipe', async () => {
    const { DB } = loadDB();
    const saved = await DB.save({ title: 'deleted later' });
    // A backup taken BEFORE the delete, then re-imported after it.
    const backup = [{ ...saved, updatedAt: saved.updatedAt }];
    await DB.remove(saved.id);
    await DB.importAll(backup);
    assert.strictEqual((await DB.all()).length, 0, 'the tombstone lost to an older record');
  });

  await test('import tolerates an empty or missing list', async () => {
    const { DB } = loadDB();
    sameShape(await DB.importAll([]), { added: 0, updated: 0, skipped: 0 });
    sameShape(await DB.importAll(null), { added: 0, updated: 0, skipped: 0 });
  });

  // ------------------------------------------------------------------ report
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  for (const f of failures) console.log('  FAIL  ' + f);
  process.exit(failures.length ? 1 : 0);
})();
