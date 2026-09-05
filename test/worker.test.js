/* Tests for public/_worker.js -- run with: node test/worker.test.js
 *
 * This is the only thing standing between the URL and the recipes, and every
 * way it can fail is silent: a gate that fails open serves everything and looks
 * perfectly normal, and a forged cookie that is accepted looks like a login.
 * So the rules are asserted rather than trusted.
 *
 * The worker is an ES module and this file is CommonJS, so the `export default`
 * is rewritten to an assignment before the source is run in a vm sandbox. That
 * is the only transform applied -- the code under test is otherwise verbatim.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', '_worker.js'), 'utf8');
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://recipes.example';

function loadWorker() {
  const assetReads = [];
  const sandbox = {
    crypto: require('crypto').webcrypto,
    TextEncoder, Response, Request, Headers, FormData, URL, Date, Math, Number,
    console,
    __exports: {}
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC.replace(/^export default /m, '__exports.worker = '), sandbox);

  const env = {
    APP_PASSWORD: PASSWORD,
    ASSETS: {
      fetch: (request) => {
        assetReads.push(request.url);
        return Promise.resolve(new Response('the real app', { status: 200 }));
      }
    }
  };
  return { worker: sandbox.__exports.worker, env, assetReads };
}

function get(url, headers) {
  return new Request(ORIGIN + url, { method: 'GET', headers: headers || {} });
}

function postLogin(password) {
  const body = new URLSearchParams();
  if (password !== undefined) body.set('password', password);
  return new Request(ORIGIN + '/__login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
}

/* Mirrors issueToken() so the tests can craft tokens the worker never issued --
   expired ones, forged ones, ones with a stretched expiry. */
async function sign(password, message) {
  const enc = new TextEncoder();
  const key = await require('crypto').webcrypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await require('crypto').webcrypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function validToken(password) {
  const expiry = String(Date.now() + 1000 * 60 * 60);
  return expiry + '.' + await sign(password, expiry);
}

function cookieHeader(token) {
  return { cookie: 'rc_auth=' + token };
}

const HTML = { accept: 'text/html,application/xhtml+xml' };

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

  // ------------------------------------------------------------ fail closed
  await test('an unset APP_PASSWORD fails closed with 500, serving nothing', async () => {
    const { worker, env, assetReads } = loadWorker();
    delete env.APP_PASSWORD;
    const res = await worker.fetch(get('/', HTML), env);
    assert.strictEqual(res.status, 500);
    assert.strictEqual(assetReads.length, 0, 'assets were read with no password configured');
  });

  await test('an empty APP_PASSWORD also fails closed', async () => {
    const { worker, env, assetReads } = loadWorker();
    env.APP_PASSWORD = '';
    const res = await worker.fetch(get('/', HTML), env);
    assert.strictEqual(res.status, 500);
    assert.strictEqual(assetReads.length, 0);
  });

  // --------------------------------------------------------- unauthenticated
  await test('an unauthenticated document request gets the login page, not the app', async () => {
    const { worker, env, assetReads } = loadWorker();
    const res = await worker.fetch(get('/', HTML), env);
    assert.strictEqual(res.status, 200);
    assert.ok((await res.text()).includes('type="password"'), 'not a login form');
    assert.strictEqual(assetReads.length, 0, 'the app was read before authentication');
  });

  await test('the login page is marked as an auth challenge for the service worker', async () => {
    const { worker, env } = loadWorker();
    const res = await worker.fetch(get('/', HTML), env);
    // At '/' a login page and the real app are both text/html, so the service
    // worker cannot tell them apart without this header -- and caching the
    // wrong one pins the login screen in place of the app.
    assert.strictEqual(res.headers.get('x-recipes-auth'), 'required');
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  });

  await test('an unauthenticated asset request gets 401 with a non-HTML body', async () => {
    const { worker, env, assetReads } = loadWorker();
    const res = await worker.fetch(get('/app.js', { accept: '*/*' }), env);
    assert.strictEqual(res.status, 401);
    assert.ok(!(res.headers.get('content-type') || '').includes('text/html'),
      'HTML served where a script was requested -- the SW could cache it as app.js');
    assert.strictEqual(res.headers.get('x-recipes-auth'), 'required');
    assert.strictEqual(assetReads.length, 0);
  });

  await test('no request reaches the assets without a valid cookie', async () => {
    const { worker, env, assetReads } = loadWorker();
    for (const p of ['/', '/app.js', '/db.js', '/style.css', '/icons/icon-192.png',
                     '/manifest.webmanifest', '/anything/at/all']) {
      await worker.fetch(get(p, HTML), env);
      await worker.fetch(get(p, { accept: '*/*' }), env);
    }
    assert.strictEqual(assetReads.length, 0,
      'reached assets for: ' + assetReads.join(', '));
  });

  // ------------------------------------------------------------------ login
  await test('GET on the login path redirects rather than rendering', async () => {
    const { worker, env } = loadWorker();
    const res = await worker.fetch(get('/__login', HTML), env);
    assert.strictEqual(res.status, 303);
    assert.strictEqual(res.headers.get('Location'), '/');
  });

  await test('a wrong password is rejected with 401', async () => {
    const { worker, env, assetReads } = loadWorker();
    const res = await worker.fetch(postLogin('hunter2'), env);
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.headers.get('set-cookie'), null, 'a cookie was issued anyway');
    assert.strictEqual(assetReads.length, 0);
  });

  await test('an absent password field is rejected, not treated as empty-equals-empty', async () => {
    const { worker, env } = loadWorker();
    const res = await worker.fetch(postLogin(undefined), env);
    assert.strictEqual(res.status, 401);
  });

  await test('a malformed login body is rejected rather than crashing', async () => {
    const { worker, env } = loadWorker();
    const req = new Request(ORIGIN + '/__login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"password":"' + PASSWORD + '"}'
    });
    const res = await worker.fetch(req, env);
    assert.strictEqual(res.status, 401, 'JSON was accepted as a form login');
  });

  await test('the right password issues a properly flagged session cookie', async () => {
    const { worker, env } = loadWorker();
    const res = await worker.fetch(postLogin(PASSWORD), env);
    assert.strictEqual(res.status, 303);
    const cookie = res.headers.get('set-cookie');
    assert.ok(cookie, 'no cookie issued');
    assert.ok(cookie.includes('HttpOnly'), 'missing HttpOnly -- script-readable');
    assert.ok(cookie.includes('Secure'), 'missing Secure -- sent over plain HTTP');
    assert.ok(cookie.includes('SameSite=Lax'), 'missing SameSite');
    assert.ok(cookie.includes('Max-Age=15552000'), 'not a 180-day session: ' + cookie);
  });

  await test('the cookie does not contain the password', async () => {
    const { worker, env } = loadWorker();
    const res = await worker.fetch(postLogin(PASSWORD), env);
    const cookie = res.headers.get('set-cookie');
    assert.ok(!cookie.includes(PASSWORD), 'the password is sitting in the cookie');
  });

  // ------------------------------------------------------------- valid token
  await test('a valid cookie is served the real app', async () => {
    const { worker, env, assetReads } = loadWorker();
    const res = await worker.fetch(get('/', cookieHeader(await validToken(PASSWORD))), env);
    assert.strictEqual(await res.text(), 'the real app');
    assert.strictEqual(assetReads.length, 1);
  });

  await test('the cookie is found among other cookies', async () => {
    const { worker, env, assetReads } = loadWorker();
    const token = await validToken(PASSWORD);
    const req = get('/', { cookie: 'ab=1; rc_auth=' + token + '; other=2' });
    await worker.fetch(req, env);
    assert.strictEqual(assetReads.length, 1, 'the cookie was not parsed out of the header');
  });

  // ------------------------------------------------------------ bad tokens
  const rejected = [
    ['no cookie at all', () => ({})],
    ['an empty cookie', () => cookieHeader('')],
    ['a cookie with no signature', () => cookieHeader(String(Date.now() + 99999))],
    ['a non-numeric expiry', async () => cookieHeader('soon.' + await sign(PASSWORD, 'soon'))],
    ['a leading dot', () => cookieHeader('.' + 'a'.repeat(64))],
    ['a forged signature', () => cookieHeader(String(Date.now() + 99999) + '.' + 'f'.repeat(64))],
    ['an expired but correctly signed token', async () => {
      const past = String(Date.now() - 1000);
      return cookieHeader(past + '.' + await sign(PASSWORD, past));
    }],
    ['a stretched expiry kept with the old signature', async () => {
      // The client tries to extend its own session by editing the expiry and
      // reusing the signature it was given.
      const original = String(Date.now() + 1000);
      const signature = await sign(PASSWORD, original);
      return cookieHeader(String(Date.now() + 99999999) + '.' + signature);
    }],
    ['a token signed with a different password', async () => {
      const expiry = String(Date.now() + 99999);
      return cookieHeader(expiry + '.' + await sign('the old password', expiry));
    }],
    ['a cookie under the wrong name', async () => ({ cookie: 'auth=' + await validToken(PASSWORD) })]
  ];

  for (const [label, build] of rejected) {
    await test('rejected: ' + label, async () => {
      const { worker, env, assetReads } = loadWorker();
      const res = await worker.fetch(get('/', Object.assign({}, HTML, await build())), env);
      assert.strictEqual(assetReads.length, 0, 'this reached the app');
      assert.ok((await res.text()).includes('type="password"'), 'no login form returned');
    });
  }

  await test('rotating the password invalidates every existing session', async () => {
    const { worker, env, assetReads } = loadWorker();
    const token = await validToken(PASSWORD);          // issued under the old one
    env.APP_PASSWORD = 'a brand new password';
    await worker.fetch(get('/', Object.assign({}, HTML, cookieHeader(token))), env);
    assert.strictEqual(assetReads.length, 0, 'an old session survived a password rotation');
  });

  // ------------------------------------------------------------------ report
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  for (const f of failures) console.log('  FAIL  ' + f);
  process.exit(failures.length ? 1 : 0);
})();
