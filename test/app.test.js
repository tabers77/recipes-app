/* End-to-end test of the app's own wiring -- node test/app.test.js
 *
 * db.test.js proves the storage layer and drive.test.js proves the merge, but
 * neither runs app.js. This does: it builds a DOM stub from the real
 * index.html, loads config.js + db.js + drive.js + app.js into it, and then
 * drives the actual user flow -- tap +, type a recipe, tap Save.
 *
 * The stub is deliberately strict. getElementById returns null for an id that
 * is not in index.html, exactly as a browser does, so a typo surfaces as the
 * same TypeError here that it would there.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PUB = path.join(__dirname, '..', 'public');
const HTML = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

// -------------------------------------------------------------------- DOM
function attrs(tagText) {
  const out = {};
  const re = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
  let m;
  re.exec(tagText);                       // skip the tag name
  while ((m = re.exec(tagText))) out[m[1]] = m[2] === undefined ? '' : m[2];
  return out;
}

/* Every element carrying an id or a name in index.html, with its tag and
   attributes. That is the whole surface app.js reaches for. */
function scanHtml() {
  const nodes = [];
  const re = /<([a-z0-9]+)((?:\s+[^>]*)?)>/gi;
  let m;
  while ((m = re.exec(HTML))) {
    const a = attrs(m[1] + m[2]);
    if (a.id || a.name) nodes.push({ tag: m[1].toLowerCase(), attrs: a });
  }
  return nodes;
}

function makeDom() {
  const byId = new Map();
  const all = [];

  function makeEl(tag, a) {
    const el = {
      tagName: tag.toUpperCase(),
      _attrs: Object.assign({}, a),
      _listeners: {},
      _children: [],
      value: '',
      textContent: '',
      innerHTML: '',
      className: a.class || '',
      dataset: {},
      style: {},
      files: [],
      hidden: Object.prototype.hasOwnProperty.call(a, 'hidden'),
      focus() { el._focused = true; },
      setAttribute(k, v) { el._attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
      addEventListener(type, fn) {
        (el._listeners[type] = el._listeners[type] || []).push(fn);
      },
      /* Real dispatch: the handler runs, and anything it throws propagates,
         which is the whole point of this harness. */
      dispatch(type, event) {
        const ev = Object.assign({ type, target: el, currentTarget: el,
                                   preventDefault() {} }, event || {});
        for (const fn of el._listeners[type] || []) fn(ev);
      },
      click() { el.dispatch('click'); },
      closest(sel) {
        const key = sel.replace(/[[\]]/g, '');
        return Object.prototype.hasOwnProperty.call(el._attrs, key) ? el : null;
      },
      querySelectorAll() { return []; },
      appendChild(child) { el._children.push(child); return child; }
    };
    if (a.id) byId.set(a.id, el);
    all.push(el);
    return el;
  }

  for (const node of scanHtml()) makeEl(node.tag, node.attrs);

  // A form exposes its named controls through .elements, which is how app.js
  // reaches the fields (never form.<name>, which collides with Element.title).
  const form = byId.get('editor');
  form.elements = {};
  for (const node of scanHtml()) {
    if (node.attrs.name) {
      form.elements[node.attrs.name] = byId.get(node.attrs.id) || makeEl(node.tag, node.attrs);
    }
  }

  const document = {
    getElementById: (id) => byId.get(id) || null,     // null, like a browser
    querySelectorAll: (sel) => {
      const key = sel.replace(/[[\]]/g, '');
      return all.filter((e) => Object.prototype.hasOwnProperty.call(e._attrs, key));
    },
    createElement: (tag) => makeEl(tag, {}),
    head: { appendChild() {} },
    body: { appendChild() {} }
  };
  return { document, byId };
}

// --------------------------------------------------------- fake IndexedDB
function makeFakeIndexedDB() {
  const stores = new Map([['recipes', new Map()], ['syncMeta', new Map()]]);

  function req(compute) {
    const r = { onsuccess: null, onerror: null };
    setTimeout(() => {
      try { r.result = compute(); if (r.onsuccess) r.onsuccess({ target: r }); }
      catch (e) { r.error = e; if (r.onerror) r.onerror({ target: r }); }
    }, 0);
    return r;
  }

  function store(data, tx) {
    const wrap = (fn) => {
      tx.pending++;
      const r = req(fn);
      setTimeout(() => { tx.pending--; }, 0);
      return r;
    };
    return {
      createIndex() {},
      get: (k) => wrap(() => data.get(k)),
      getAll: () => wrap(() => [...data.values()]),
      put: (rec) => wrap(() => {
        data.set(rec.id !== undefined ? rec.id : rec.key, JSON.parse(JSON.stringify(rec)));
        return true;
      })
    };
  }

  return {
    _stores: stores,
    open() {
      const r = { onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore: (n) => { stores.set(n, new Map()); return store(stores.get(n), { pending: 0 }); },
          transaction(name) {
            const tx = { pending: 0, oncomplete: null, onerror: null, onabort: null };
            tx.objectStore = () => store(stores.get(name), tx);
            const drain = () => {
              if (tx.pending > 0) { setTimeout(drain, 0); return; }
              if (tx.oncomplete) tx.oncomplete();
            };
            setTimeout(drain, 0);
            return tx;
          }
        };
        r.result = db;
        if (r.onsuccess) r.onsuccess({ target: r });
      }, 0);
      return r;
    }
  };
}

// ------------------------------------------------------------------ loader
function boot() {
  const { document, byId } = makeDom();
  const idb = makeFakeIndexedDB();
  const hashListeners = [];
  const location = {
    href: 'http://localhost:8080/', origin: 'http://localhost:8080',
    hash: '',
    replace(h) { location.hash = h; fireHash(); }
  };
  function fireHash() { for (const fn of hashListeners) fn(); }

  const sandbox = {
    document, location, indexedDB: idb,
    crypto: require('crypto').webcrypto,
    navigator: { onLine: true },      // no serviceWorker: registerWorker no-ops
    setTimeout, clearTimeout, console,
    URL, Blob, Response, Date, Math, JSON, Map, Set, Promise, Number, String,
    Array, Object, parseInt, isNaN, confirm: () => true, alert: () => {},
    addEventListener: (type, fn) => { if (type === 'hashchange') hashListeners.push(fn); },
    scrollTo() {}
  };
  /* window must BE the global object, not a property of it. In a browser
     `window.DB = ...` in db.js is what makes the bare identifier `DB` visible
     to app.js; a plain object here would silently break that and report a
     ReferenceError the real page never has. */
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  const errors = [];
  for (const file of ['config.js', 'db.js', 'drive.js', 'app.js']) {
    try {
      vm.runInContext(fs.readFileSync(path.join(PUB, file), 'utf8'), sandbox, { filename: file });
    } catch (err) {
      errors.push(file + ': ' + err.message);
    }
  }

  // location.hash assignment from app.js must trigger routing, as in a browser.
  let current = location.hash;
  const watch = setInterval(() => {
    if (location.hash !== current) { current = location.hash; fireHash(); }
  }, 1);
  watch.unref && watch.unref();

  return { sandbox, byId, idb, location, errors, stop: () => clearInterval(watch) };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

// -------------------------------------------------------------------- runner
let passed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed++; }
  catch (err) { failures.push(name + '\n    ' + (err && err.message)); }
}

// --------------------------------------------------------------------- tests
(async () => {
  await test('the app loads without throwing', async () => {
    const app = boot();
    await settle();
    assert.deepStrictEqual(app.errors, [], 'load-time error:\n      ' + app.errors.join('\n      '));
    app.stop();
  });

  await test('tapping + opens the editor', async () => {
    const app = boot();
    await settle();
    app.byId.get('btn-new').click();
    await settle();
    assert.strictEqual(app.byId.get('screen-editor').hidden, false, 'the editor stayed hidden');
    assert.strictEqual(app.byId.get('screen-list').hidden, true, 'the list stayed visible');
    app.stop();
  });

  await test('saving a new recipe writes it to storage', async () => {
    const app = boot();
    await settle();
    app.byId.get('btn-new').click();
    await settle();

    const f = app.byId.get('editor').elements;
    f.title.value = 'Carbonara';
    f.categories.value = 'Pasta, Quick';
    f.servings.value = '2';
    f.timeMinutes.value = '25';
    f.ingredients.value = '200g guanciale\n3 egg yolks';
    f.steps.value = 'Render the guanciale.\nFold in the eggs off the heat.';
    f.links.value = 'Video | https://example.com/carbonara';
    f.notes.value = 'Less salt than it says.';

    app.byId.get('btn-save').click();
    await settle();

    const rows = [...app.idb._stores.get('recipes').values()];
    assert.strictEqual(rows.length, 1, 'nothing was written to storage');
    const r = rows[0];
    assert.strictEqual(r.title, 'Carbonara');
    assert.deepStrictEqual(r.categories, ['Pasta', 'Quick']);
    assert.strictEqual(r.servings, 2);
    assert.strictEqual(r.ingredients.length, 2);
    assert.strictEqual(r.links[0].url, 'https://example.com/carbonara');
    app.stop();
  });

  await test('saving with no title is refused and says why', async () => {
    const app = boot();
    await settle();
    app.byId.get('btn-new').click();
    await settle();
    app.byId.get('btn-save').click();
    await settle();

    assert.strictEqual(app.byId.get('editor-error').hidden, false, 'no error was shown');
    assert.strictEqual([...app.idb._stores.get('recipes').values()].length, 0,
      'an untitled recipe was saved anyway');
    app.stop();
  });

  await test('a saved recipe appears in the list', async () => {
    const app = boot();
    await settle();
    app.byId.get('btn-new').click();
    await settle();
    app.byId.get('editor').elements.title.value = 'Tortilla';
    app.byId.get('btn-save').click();
    await settle();

    app.location.replace('#/');
    await settle();
    assert.ok(app.byId.get('list').innerHTML.includes('Tortilla'),
      'the list does not show the recipe just saved');
    app.stop();
  });

  // ------------------------------------------------------------------ report
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  for (const f of failures) console.log('  FAIL  ' + f);
  process.exit(failures.length ? 1 : 0);
})();
