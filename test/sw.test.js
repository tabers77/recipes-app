/* Tests for public/sw.js -- run with: node test/sw.test.js
 *
 * A service worker fails silently by design: a bad cache key means the phone
 * keeps serving last month's app and says nothing, and a cached login page
 * means the app is simply gone until site data is cleared. Neither shows up in
 * a browser until it is already too late, so both are asserted here instead.
 *
 * Cache Storage and fetch are stubbed; Response/Blob/URL are Node's own.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://recipes.example';

/* Real Cache Storage and fetch resolve a relative URL against the worker's
   scope before using it as a key, so './app.js' and https://origin/app.js are
   the same entry. The stubs below canonicalise through this for the same
   reason -- keying by the literal string would make cache hits depend on how
   the caller happened to spell the URL. */
const abs = (u) => new URL(typeof u === 'string' ? u : u.url, ORIGIN + '/').href;

// -------------------------------------------------------------- environment
function makeEnv(options) {
  const opts = options || {};
  const routes = opts.routes || {};          // url -> () => Response
  const caches_ = new Map();                 // cacheName -> Map(url -> Response)
  const fetched = [];
  const listeners = {};

  function cacheFor(name) {
    if (!caches_.has(name)) caches_.set(name, new Map());
    return caches_.get(name);
  }

  const cachesStub = {
    open: (name) => Promise.resolve(wrap(cacheFor(name))),
    keys: () => Promise.resolve([...caches_.keys()]),
    delete: (name) => Promise.resolve(caches_.delete(name)),
    match: (req) => {
      const url = abs(req);
      for (const store of caches_.values()) {
        if (store.has(url)) return Promise.resolve(store.get(url));
      }
      return Promise.resolve(undefined);
    }
  };

  function wrap(store) {
    return {
      put: (req, res) => { store.set(abs(req), res); return Promise.resolve(); },
      match: (req) => Promise.resolve(store.get(abs(req)))
    };
  }

  const self_ = {
    location: { origin: ORIGIN },
    skipWaitingCalled: false,
    claimCalled: false,
    skipWaiting() { self_.skipWaitingCalled = true; },
    clients: { claim: () => { self_.claimCalled = true; return Promise.resolve(); } },
    addEventListener: (type, fn) => { listeners[type] = fn; }
  };

  const sandbox = {
    self: self_,
    caches: cachesStub,
    Response,
    Request,
    Blob,
    URL,
    Promise,
    // sw.js calls fetch() with a URL string when precaching and with a Request
    // in the fetch handler; both must resolve to the same route.
    fetch: (target) => {
      const url = abs(target);
      fetched.push(url);
      const make = routes[url];
      if (!make) return Promise.resolve(new Response('not found', { status: 404 }));
      return Promise.resolve(make());
    },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  return { self: self_, caches: caches_, cachesStub, fetched, listeners, wrap };
}

/* Every shell file resolves to a plausible asset. */
function okRoutes(overrides) {
  const files = ['./', './app.js', './db.js', './style.css', './manifest.webmanifest',
    './icons/icon-192.png', './icons/icon-512.png',
    './icons/icon-192-maskable.png', './icons/icon-512-maskable.png'];
  const routes = {};
  for (const f of files) {
    const type = f.endsWith('.js') ? 'text/javascript'
      : f.endsWith('.css') ? 'text/css'
      : f.endsWith('.png') ? 'image/png'
      : f.endsWith('.webmanifest') ? 'application/manifest+json'
      : 'text/html';
    routes[abs(f)] = () => new Response('body of ' + f, { status: 200, headers: { 'content-type': type } });
  }
  for (const [k, v] of Object.entries(overrides || {})) routes[abs(k)] = v;
  return routes;
}

function fireInstall(env) {
  let promise;
  env.listeners.install({ waitUntil: (p) => { promise = p; } });
  return promise;
}

function fireActivate(env) {
  let promise;
  env.listeners.activate({ waitUntil: (p) => { promise = p; } });
  return promise;
}

function fireFetch(env, request) {
  let responded = null;
  env.listeners.fetch({ request, respondWith: (p) => { responded = p; } });
  return responded;                 // null means "passed through untouched"
}

// -------------------------------------------------------------------- runner
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
  await test('install precaches every shell file', async () => {
    const env = makeEnv({ routes: okRoutes() });
    await fireInstall(env);
    const shell = env.caches.get('recipes-shell-v1');
    assert.ok(shell, 'shell cache was not created');
    assert.strictEqual(shell.size, 9, 'cached ' + shell.size + ' of 9 shell files');
    assert.ok(shell.has(abs('./')), "'./' was not precached");
  });

  await test("install precaches './' and never './index.html'", async () => {
    const env = makeEnv({ routes: okRoutes() });
    await fireInstall(env);
    assert.ok(!env.fetched.includes(abs('./index.html')),
      'fetched ./index.html, whose 308 to / cannot answer a navigation');
  });

  await test('install stores a rebuilt response, not the fetched one', async () => {
    // A response carried straight from fetch keeps its `redirected` flag, and
    // answering a navigation with one fails the navigation outright.
    const original = new Response('x', { status: 200, headers: { 'content-type': 'text/html' } });
    const env = makeEnv({ routes: okRoutes({ './': () => original }) });
    await fireInstall(env);
    const stored = env.caches.get('recipes-shell-v1').get(abs('./'));
    assert.notStrictEqual(stored, original, 'the fetched Response was cached as-is');
    assert.strictEqual(await stored.text(), 'x', 'the rebuilt body does not match');
    assert.strictEqual(stored.headers.get('content-type'), 'text/html');
  });

  await test('install fails rather than caching a login page as a script', async () => {
    // The Phase 3 password gate answers an expired session with 200 + HTML.
    const env = makeEnv({
      routes: okRoutes({
        './app.js': () => new Response('<html>sign in</html>',
          { status: 200, headers: { 'content-type': 'text/html' } })
      })
    });
    await assert.rejects(fireInstall(env), /auth page/);
  });

  await test('install fails rather than caching a 404', async () => {
    const env = makeEnv({
      routes: okRoutes({ './style.css': () => new Response('nope', { status: 404 }) })
    });
    await assert.rejects(fireInstall(env), /precache failed \(404\)/);
  });

  await test('install does NOT skipWaiting', async () => {
    const env = makeEnv({ routes: okRoutes() });
    await fireInstall(env);
    assert.strictEqual(env.self.skipWaitingCalled, false,
      'a new worker took over without asking, which can swap the app out mid-edit');
  });

  await test('activate drops stale shell caches and claims clients', async () => {
    const env = makeEnv({ routes: okRoutes() });
    env.caches.set('recipes-shell-v0', new Map([[abs('./'), 'old']]));
    env.caches.set('recipes-shell-v1', new Map());
    await fireActivate(env);
    assert.ok(!env.caches.has('recipes-shell-v0'), 'the old shell cache survived');
    assert.ok(env.caches.has('recipes-shell-v1'), 'the current shell cache was deleted');
    assert.strictEqual(env.self.claimCalled, true, 'clients.claim() was not called');
  });

  await test('activate leaves caches belonging to something else alone', async () => {
    const env = makeEnv({ routes: okRoutes() });
    env.caches.set('some-other-app', new Map([['x', 'y']]));
    await fireActivate(env);
    assert.ok(env.caches.has('some-other-app'), 'deleted a cache this app does not own');
  });

  await test('a skip-waiting message calls skipWaiting', async () => {
    const env = makeEnv({ routes: okRoutes() });
    env.listeners.message({ data: 'skip-waiting' });
    assert.strictEqual(env.self.skipWaitingCalled, true);
  });

  await test('an unrelated message does not call skipWaiting', async () => {
    const env = makeEnv({ routes: okRoutes() });
    env.listeners.message({ data: 'hello' });
    assert.strictEqual(env.self.skipWaitingCalled, false);
  });

  await test('non-GET requests pass through untouched', async () => {
    const env = makeEnv({ routes: okRoutes() });
    const r = fireFetch(env, { method: 'POST', url: ORIGIN + '/x', mode: 'cors' });
    assert.strictEqual(r, null, 'respondWith was called for a POST');
  });

  await test('cross-origin requests pass through untouched', async () => {
    const env = makeEnv({ routes: okRoutes() });
    const r = fireFetch(env, { method: 'GET', url: 'https://elsewhere.test/a.js', mode: 'cors' });
    assert.strictEqual(r, null, 'respondWith was called for another origin');
  });

  await test('a navigation is answered from the cached shell', async () => {
    const env = makeEnv({ routes: okRoutes() });
    await fireInstall(env);
    const before = env.fetched.length;
    // A deep link the server never had a file for -- the SPA hash lives here.
    const res = await fireFetch(env, {
      method: 'GET', url: ORIGIN + '/#/r/r_abc', mode: 'navigate'
    });
    assert.strictEqual(await res.text(), 'body of ./');
    assert.strictEqual(env.fetched.length, before, 'a navigation hit the network');
  });

  await test('a cached shell asset is served with zero network', async () => {
    const env = makeEnv({ routes: okRoutes() });
    await fireInstall(env);
    const before = env.fetched.length;
    const res = await fireFetch(env, {
      method: 'GET', url: ORIGIN + '/app.js', mode: 'no-cors'
    });
    assert.strictEqual(await res.text(), 'body of ./app.js');
    assert.strictEqual(env.fetched.length, before, 'a cached asset still hit the network');
  });

  await test('an uncached same-origin asset is fetched and then stored', async () => {
    const env = makeEnv({
      routes: okRoutes({
        [ORIGIN + '/late.js']: () => new Response('late',
          { status: 200, headers: { 'content-type': 'text/javascript' } })
      })
    });
    await fireInstall(env);
    const req = { method: 'GET', url: ORIGIN + '/late.js', mode: 'no-cors' };
    assert.strictEqual(await (await fireFetch(env, req)).text(), 'late');
    await new Promise((r) => setTimeout(r, 0));      // the put is not awaited
    assert.ok(env.caches.get('recipes-shell-v1').has(abs('/late.js')),
      'the fetched asset was not cached');
  });

  await test('a login page returned for an asset is served but never cached', async () => {
    const env = makeEnv({
      routes: okRoutes({
        [ORIGIN + '/late.js']: () => new Response('<html>sign in</html>',
          { status: 200, headers: { 'content-type': 'text/html' } })
      })
    });
    await fireInstall(env);
    const req = { method: 'GET', url: ORIGIN + '/late.js', mode: 'no-cors' };
    await fireFetch(env, req);
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(!env.caches.get('recipes-shell-v1').has(abs('/late.js')),
      'a login page was cached in place of the asset');
  });

  await test('SHELL_FILES covers every file actually in public/', () => {
    // Drift guard. Adding a file to public/ and forgetting to list it in sw.js
    // breaks offline for that asset only -- which looks fine on a desktop with
    // a network and fails on a phone in a kitchen.
    const listed = new Set(SRC.match(/'\.\/[^']*'/g).map((q) => q.slice(1, -1)));
    const root = path.join(__dirname, '..', 'public');
    const onDisk = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        for (const f of fs.readdirSync(path.join(root, entry.name))) {
          onDisk.push('./' + entry.name + '/' + f);
        }
      } else {
        onDisk.push('./' + entry.name);
      }
    }
    const exempt = new Set([
      './sw.js',          // a service worker must not cache itself
      './index.html'      // precached as './' -- see the comment in sw.js
    ]);
    const missing = onDisk.filter((f) => !exempt.has(f) && !listed.has(f));
    assert.deepStrictEqual(missing, [],
      'in public/ but not in SHELL_FILES, so unavailable offline: ' + missing.join(', '));
  });

  // ------------------------------------------------------------------ report
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  for (const f of failures) console.log('  FAIL  ' + f);
  process.exit(failures.length ? 1 : 0);
})();
