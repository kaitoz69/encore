// Keeps the app opening fast and offline-tolerant. Audio is deliberately left alone:
// iOS needs real byte-range (206) responses to play media, and a service worker
// answering with a cached full file makes playback fail.
const CACHE = 'encore-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
const AUDIO = /\.(mp3|m4a|aac|wav|flac)$/i;
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (request.headers.has('range') || request.destination === 'audio' || AUDIO.test(url.pathname)) return;

  if (request.destination === 'image' && url.pathname.includes('/music/')) {
    event.respondWith(staleWhileRevalidate(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});

// App files and songs.json: use the newest version, fall back to the saved one when offline.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' })
    || (request.mode === 'navigate' ? await cache.match('index.html') : undefined);
  if (!cached) return network;

  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS));
  return Promise.race([network.catch(() => cached), timeout]);
}

// Cover art: show the saved copy instantly, refresh it in the background.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  if (cached) {
    network.catch(() => {});
    return cached;
  }
  return network;
}
