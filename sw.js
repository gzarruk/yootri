/* yootri's service worker: it keeps the app shell on the device so the page
   opens with no connection. That is all it does.

   What it touches: this site's own static files (GET only) and the two public,
   versioned things the page loads from a CDN — the Firebase SDK scripts and the
   Inter font. Everything else goes straight to the network, untouched and
   uncached: Firestore and sign-in, the coach's model calls, the Strava relay,
   the Garmin bridge on 127.0.0.1. Nothing a request carries or a response holds
   about the athlete is ever put in a cache here.

   Static files are answered from the cache and refreshed behind it, so a
   deploy shows on the next open without anyone bumping a number. VERSION only
   needs to change to drop files that no longer exist.

   Paths are relative to this file, so it works on a root host and on a
   project-page sub-path alike. */

const VERSION = 'v1';
const CACHE = 'yootri-shell-' + VERSION;

const SHELL = [
  './',
  'index.html',
  'privacy.html',
  'manifest.webmanifest',
  'favicon.ico',
  'assets/favicon.svg',
  'assets/apple-touch-icon.png',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/icon-maskable-512.png',
  'assets/nocturne.css',
  'assets/app-shell.css',
  'assets/privacy.js',
  'assets/example-plan.json',
  'assets/coach/actuals.js',
  'assets/coach/activities.js',
  'assets/coach/adapt.js',
  'assets/coach/agent.js',
  'assets/coach/athlete.js',
  'assets/coach/backplan.js',
  'assets/coach/calendar.js',
  'assets/coach/dates.js',
  'assets/coach/duration.js',
  'assets/coach/events.js',
  'assets/coach/fitness.js',
  'assets/coach/generate.js',
  'assets/coach/history.js',
  'assets/coach/legacy-plan.js',
  'assets/coach/load.js',
  'assets/coach/match.js',
  'assets/coach/migrate.js',
  'assets/coach/onboarding.js',
  'assets/coach/overnight.js',
  'assets/coach/paces.js',
  'assets/coach/plan.js',
  'assets/coach/portable.js',
  'assets/coach/preparation.js',
  'assets/coach/profile.js',
  'assets/coach/providers.js',
  'assets/coach/races.js',
  'assets/coach/review.js',
  'assets/coach/season.js',
  'assets/coach/shape.js',
  'assets/coach/startfit.js',
  'assets/coach/synced.js',
  'assets/coach/targets.js',
  'assets/coach/tools.js',
  'assets/coach/validate.js',
  'assets/coach/workout.js',
];

/* The only other origins whose responses may be kept: public code and fonts. */
const CDN = [
  ['https://www.gstatic.com', '/firebasejs/'],
  ['https://fonts.googleapis.com', '/'],
  ['https://fonts.gstatic.com', '/'],
];

const cdnAllowed = (url) => CDN.some(([origin, prefix]) => url.origin === origin && url.pathname.startsWith(prefix));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // `reload` so the first copy is never an older one from the HTTP cache.
      .then((cache) => cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('yootri-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.cache === 'no-store') return;
  if (req.headers.has('authorization')) return;

  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (!same && !cdnAllowed(url)) return;

  // A page address can carry a query (a Strava return, ?garmin=setup) that the
  // static file does not care about, so it is matched without one.
  const key = req.mode === 'navigate' ? new Request(url.origin + url.pathname) : req;
  event.respondWith(answer(req, key, req.mode === 'navigate'));
});

async function answer(req, key, navigating) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key, { ignoreSearch: navigating });

  const refresh = fetch(req).then((res) => {
    // Opaque is a cross-origin stylesheet or font; both are public.
    if (res && (res.status === 200 || res.type === 'opaque')) cache.put(key, res.clone());
    return res;
  });

  if (cached) {
    refresh.catch(() => {});        // offline: the copy on hand is the answer
    return cached;
  }
  try {
    return await refresh;
  } catch (e) {
    // A page the cache has never seen, opened offline: the app shell is the
    // best thing to show; any other file is simply missing.
    if (navigating) {
      const shell = await cache.match('index.html');
      if (shell) return shell;
    }
    return Response.error();
  }
}
