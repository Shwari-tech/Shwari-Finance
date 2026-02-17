const CACHE_NAME = 'shwari-pay-v2-high-cache';

// Core files for instant offline shell loading
const CACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css'
];

// 1. Install Event: Aggressively Cache App Shell
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installed (High Cache Version)');
  self.skipWaiting(); // Force the waiting service worker to become the active service worker.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Pre-caching Core Assets');
        return cache.addAll(CACHE_ASSETS);
      })
  );
});

// 2. Activate Event: Clean up old low-cache versions
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activated');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[Service Worker] Clearing Old Obsolete Cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
  return self.clients.claim(); // Take control of all clients immediately
});

// 3. Fetch Event: Stale-While-Revalidate (High Cache Strategy)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // CRITICAL: Do not attempt to cache the Google Apps Script iframe.
  if (event.request.url.includes('script.google.com')) {
      return; 
  }

  // Stale-While-Revalidate Strategy for high caching efficiency
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // Initiate the background fetch to update the cache
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        // Clone the response before putting it in cache
        const responseClone = networkResponse.clone();
        
        // Asynchronously update the cache
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });

        return networkResponse;
      }).catch(() => {
        // If network fails, just silently fail the background fetch
        console.log('[Service Worker] Network request failed for', event.request.url);
      });

      // Return the cached response IMMEDIATELY if we have it, otherwise wait for the network
      return cachedResponse || fetchPromise;
    }).catch(() => {
        // Fallback for HTML pages if completely offline and not in cache
        if (event.request.headers.get('accept').includes('text/html')) {
            return caches.match('/');
        }
    })
  );
});
