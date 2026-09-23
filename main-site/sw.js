// The version constant, and the only thing that makes a deploy reach anybody.
// The browser compares this file byte for byte, so bump it on every change to
// anything the site serves, however small. An unbumped version is an update
// bar nobody ever sees.
const CACHE = "sg-bikes-v6";

// Parking API responses, kept for offline use. Deliberately unversioned so a
// reader who accepts an update does not lose the results they had offline.
const API_CACHE = "sg-bikes-api";

// addAll is all or nothing, so a path that 404s takes the whole install down
// with it. Keep this list in step with the script tags in index.html.
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/map.js',
  '/js/icons.js',
  '/js/ui.js',
  '/js/theme.js',
  '/js/sync.js',
  '/js/update.js',
  '/manifest.json'
];

// No skipWaiting here. A new worker installs and then waits until the reader
// presses Reload on the update bar (js/update.js).
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Past the HTTP cache, so a new version never precaches the old files.
      cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
});

// No clients.claim here either: claiming on activation is doing silently what
// the update bar exists to ask about.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE && key !== API_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
});

self.addEventListener('message', (event) => {
  const type = typeof event.data === 'string' ? event.data : event.data?.type;

  // The only place either of these is ever called.
  if (type === 'skip-waiting') {
    event.waitUntil(self.skipWaiting().then(() => self.clients.claim()));
  }
});

// Fetch: network first for API, cache first for static
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Sync endpoints are per device and must never be cached or replayed.
  if (
    url.pathname === '/api/favourites' ||
    url.pathname === '/api/device' ||
    url.pathname === '/api/link' ||
    url.pathname === '/api/backup-codes'
  ) {
    return;
  }

  // API calls: network first, fall back to cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(API_CACHE).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.open(API_CACHE).then((cache) => cache.match(event.request)))
    );
    return;
  }

  // Static: cache first, from this version's cache only. While a new worker
  // waits, its cache already exists, and caches.match() across every cache
  // would hand the page on screen a mix of old and new files.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;

      try {
        return await fetch(event.request);
      } catch (err) {
        // Offline on a URL that is not precached as written, such as the app
        // opened from a link carrying a query string: serve the app shell.
        if (event.request.mode === 'navigate') {
          const shell = await cache.match('/');
          if (shell) return shell;
        }
        throw err;
      }
    })
  );
});
