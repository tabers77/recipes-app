/* Password gate for the Recipes Pages project -- PLAN.md Phase 3.
 *
 * Adapted from the same gate used by the vault quiz app. Cloudflare Access was
 * not an option: Zero Trust requires a card on file and a standing charge
 * authorization before it can be enabled at all, even on the free plan.
 *
 * A `_worker.js` at the root of the deployed directory puts Pages into
 * "advanced mode": this script sees every request, and static files are served
 * through env.ASSETS. Nothing leaves the origin before authentication --
 * unlike a client-side password check, which ships the content first and is
 * decoration rather than protection.
 *
 * Configuration: one encrypted environment variable on the Pages project.
 *
 *     APP_PASSWORD   the shared password
 *
 * If it is unset the worker fails CLOSED with a 500. A missing secret must
 * never mean "serve everything to everyone".
 *
 * Cookie: rc_auth = "<expiry-ms>.<hex HMAC-SHA256(APP_PASSWORD, expiry-ms)>".
 * The password itself is never stored in the cookie, and the signature means a
 * client cannot extend its own expiry. 180 days, so a phone logs in about
 * twice a year. Rotating APP_PASSWORD invalidates every existing session,
 * since the signing key is the password.
 */

const COOKIE = 'rc_auth';
const MAX_AGE_S = 60 * 60 * 24 * 180;    // 180 days
const LOGIN_PATH = '/__login';

// ---------------------------------------------------------------- crypto
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* Length-independent comparison. Compares every byte so a wrong password does
   not leak its correct prefix through response timing. */
function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

// ---------------------------------------------------------------- token
async function issueToken(password) {
  const expiry = String(Date.now() + MAX_AGE_S * 1000);
  return expiry + '.' + (await hmacHex(password, expiry));
}

async function tokenIsValid(token, password) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const expiry = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[0-9]{1,15}$/.test(expiry)) return false;
  if (Number(expiry) <= Date.now()) return false;
  return constantTimeEqual(signature, await hmacHex(password, expiry));
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// ---------------------------------------------------------------- login page
function loginPage(message, status) {
  const body = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Recipes</title>
<style>
  :root { color-scheme: light dark; --bg:#faf7f2; --fg:#23201b; --muted:#6f675c;
          --surface:#fff; --border:#e3ddd2; --accent:#b4541f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1b1a17; --fg:#ece7de; --muted:#a49b8d;
            --surface:#24221e; --border:#3a362f; --accent:#e8834a; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center;
         justify-content:center; background:var(--bg); color:var(--fg); padding:24px;
         font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  form { width:100%; max-width:340px; }
  h1 { font-size:1.4rem; margin:0 0 6px; letter-spacing:-0.01em; }
  p  { margin:0 0 20px; color:var(--muted); font-size:0.9rem; }
  .err { color:var(--accent); font-weight:600; }
  input { width:100%; min-height:52px; padding:14px; margin-bottom:12px;
          background:var(--surface); color:var(--fg); border:1px solid var(--border);
          border-radius:14px; font:inherit; }
  button { width:100%; min-height:52px; border:0; border-radius:14px;
           background:var(--accent); color:#fff; font:inherit; font-weight:650; }
</style>
</head><body>
<form method="POST" action="${LOGIN_PATH}">
  <h1>Recipes</h1>
  <p class="${message ? 'err' : ''}">${message || 'Enter the password to continue.'}</p>
  <input type="password" name="password" autocomplete="current-password"
         autofocus required aria-label="Password">
  <button type="submit">Unlock</button>
</form>
</body></html>`;

  return new Response(body, {
    status: status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      // Lets the service worker recognise an auth challenge no matter which
      // path it arrives on. Sniffing content type is not enough: at '/' a
      // login page and the real app are both text/html.
      'x-recipes-auth': 'required',
    },
  });
}

// ---------------------------------------------------------------- handler
export default {
  async fetch(request, env) {
    const password = env.APP_PASSWORD;

    // Fail closed. An unset secret must not expose the whole app.
    if (!password) {
      return new Response(
        'APP_PASSWORD is not set on this Pages project. Add it under '
        + 'Settings > Environment variables (encrypted), then redeploy.',
        { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } }
      );
    }

    const url = new URL(request.url);

    if (url.pathname === LOGIN_PATH) {
      if (request.method !== 'POST') {
        return new Response(null, { status: 303, headers: { Location: '/' } });
      }
      let given = '';
      try {
        given = String((await request.formData()).get('password') || '');
      } catch (e) {
        given = '';
      }
      if (!constantTimeEqual(given, password)) {
        return loginPage('That password is not right.', 401);
      }
      const token = await issueToken(password);
      return new Response(null, {
        status: 303,
        headers: {
          Location: '/',
          'Set-Cookie': `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; `
            + `Path=/; Max-Age=${MAX_AGE_S}`,
          'cache-control': 'no-store',
        },
      });
    }

    if (await tokenIsValid(readCookie(request, COOKIE), password)) {
      return env.ASSETS.fetch(request);
    }

    // Unauthenticated. A document request gets the login form; anything else
    // gets a 401 with a NON-HTML body on purpose. The service worker treats a
    // non-ok response as "do not cache" and leaves its stored shell alone, so
    // an expired session can never replace the offline app with a login page.
    const accept = request.headers.get('accept') || '';
    if (request.method === 'GET' && accept.includes('text/html')) {
      return loginPage('', 200);
    }
    return new Response('unauthorized', {
      status: 401,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-recipes-auth': 'required',
      },
    });
  },
};
