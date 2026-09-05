/* Recipes service worker -- PLAN.md Phase 2.
 *
 * The whole app is shell: HTML, CSS, two scripts, four icons. There is no data
 * file to keep fresh, because the recipes live in IndexedDB, which the service
 * worker never touches. So this is one cache, cache-first, versioned.
 *
 * SHELL_VERSION names the cache. Bumping it is what makes an installed phone
 * pick up new code -- an unchanged key means phones keep serving the old app
 * forever, silently. Phase 3 stamps this with the git commit in CI; until then
 * it is hand-edited, and forgetting to edit it is the failure mode to watch.
 */
'use strict';

var SHELL_VERSION = 'v1';
var SHELL_CACHE = 'recipes-shell-' + SHELL_VERSION;

/* './' only, deliberately NOT './index.html'. Cloudflare Pages canonicalises
   /index.html to / with a 308, and a cached redirected response cannot answer
   a navigation at all. './' is what both Pages and a local dev server serve. */
var SHELL_FILES = [
  './',
  './app.js',
  './db.js',
  './style.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png'
];

/* The app sits behind the password-gate worker (_worker.js), which answers an
   expired session with 200 + an HTML login page rather than a 401. Caching that
   would pin the login screen in place of the app until site data is cleared.
 *
 * Two independent detectors, because neither alone is enough:
 *
 *   isAuthChallenge  reads the header the gate stamps on every challenge. This
 *                    is the one that matters at './', where a login page and
 *                    the real app are both text/html and indistinguishable by
 *                    content type.
 *   isLoginPage      HTML where a script, stylesheet, icon or manifest was
 *                    asked for. A backstop for any hop that drops the header.
 */
function isAuthChallenge(response) {
  return response.headers.get('x-recipes-auth') === 'required';
}

function isLoginPage(url, response) {
  if (/\.(js|css|png|webmanifest)$/.test(url)) {
    var type = response.headers.get('content-type') || '';
    return type.indexOf('text/html') !== -1;
  }
  return false;
}

/* Rebuilt from the body rather than stored as-is, for two reasons:
     1. A navigation request has redirect mode "manual", and answering one with
        a response whose `redirected` flag is set fails the navigation outright.
        Rebuilding clears the flag.
     2. It gives isLoginPage() somewhere to reject before anything is stored.
   Only content-type is carried over: the body is already decoded, so copying a
   content-encoding header would misdescribe it. */
function precache(cache, url) {
  return fetch(url, { credentials: 'same-origin', redirect: 'follow' })
    .then(function (response) {
      if (!response || !response.ok) {
        throw new Error('precache failed (' + (response && response.status) + '): ' + url);
      }
      if (isAuthChallenge(response) || isLoginPage(url, response)) {
        throw new Error('precache got an auth page, not the asset: ' + url);
      }
      return response.blob().then(function (body) {
        var headers = {};
        var type = response.headers.get('content-type');
        if (type) headers['content-type'] = type;
        return cache.put(url, new Response(body, { status: 200, headers: headers }));
      });
    });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return Promise.all(SHELL_FILES.map(function (url) { return precache(cache, url); }));
    })
    // No skipWaiting(): a new worker waits until every tab of the old one is
    // gone, so a running session is never swapped out mid-edit. app.js tells
    // the user a new version is ready and lets them choose when.
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        // Everything this app owns is prefixed, so a stale cache from an older
        // SHELL_VERSION is dropped without touching anyone else's storage.
        if (name.indexOf('recipes-shell-') === 0 && name !== SHELL_CACHE) {
          return caches.delete(name);
        }
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  // Sent by app.js when the user accepts the update toast.
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  var request = event.request;

  // Never interfere with writes, and never cache another origin's responses.
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  // Navigations: serve the cached shell. The app is a single page, so any
  // in-app URL is answered by './' plus the hash the browser already has.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./').then(function (cached) {
        return cached || fetch(request);
      })
    );
    return;
  }

  // Shell assets: cache-first, zero network once installed.
  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        // Only same-origin successes are worth storing, and never a login page.
        if (response && response.ok &&
            !isAuthChallenge(response) && !isLoginPage(request.url, response)) {
          var copy = response.clone();
          caches.open(SHELL_CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      });
    })
  );
});
