// File: sw.js
const CACHE_NAME = 'shwari-finance-v1';

// Files to save for offline use
// NOTE: We do not cache the video because it is too large.
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './logo.png', 
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'
];

// 1. INSTALL: Cache the website shell
self.addEventListener('install', (e) => {
  console.log('[Service Worker] Installed');
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Caching all assets');
      return cache.addAll(ASSETS);
    })
  );
});

// 2. FETCH: Serve from cache if available, otherwise go to network
self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => {
      return response || fetch(e.request);
    })
  );
});

// 3. ACTIVATE: Clean up old caches if you update the version
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
});
