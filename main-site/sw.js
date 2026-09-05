const CACHE = "sg-bikes-v5";

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
  '/manifest.json'
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
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
        caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
    );
    return;
  }

  // Static: cache first
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});