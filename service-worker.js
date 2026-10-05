const CACHE_NAME = 'gps-v1';
const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './trajet-waze.svg',
  './trajet-waze-192.png',
  './trajet-waze-512.png',
  './trajet-waze-maskable-512.png',
  './trajet-waze.png',
];
const CACHEABLE_EXTERNAL_HOSTS = ['unpkg.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('gps-') && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
        return response;
      })),
    );
    return;
  }

  if (CACHEABLE_EXTERNAL_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request).then((response) => {
          if (response.ok || response.type === 'opaque') {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone())).catch(() => {});
          }
          return response;
        });
        return cached || network;
      }),
    );
  }
});
