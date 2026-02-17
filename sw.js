const CACHE_NAME = 'shwari-pay-v2-high-cache';

// Expanded core assets for high caching
const CACHE_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/webfonts/fa-solid-900.woff2',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/webfonts/fa-brands-400.woff2'
];

// 1. Install Event: Cache the application shell aggressively
self.addEventListener('install', (event) => {
    console.log('[Service Worker] Installed - High Cache Enabled');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[Service Worker] Caching Core App Shell');
                return cache.addAll(CACHE_ASSETS);
            })
            .then(() => self.skipWaiting())
    );
});

// 2. Activate Event: Clean up old caches
self.addEventListener('activate', (event) => {
    console.log('[Service Worker] Activated');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME) {
                        console.log('[Service Worker] Clearing Old Cache:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
    return self.clients.claim();
});

// 3. Fetch Event: High-performance Stale-While-Revalidate Strategy
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    // CRITICAL: Do not attempt to cache the Google Apps Script iframe.
    if (event.request.url.includes('script.google.com')) {
        return; 
    }

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            // Serve from cache immediately if available (High Speed)
            const fetchPromise = fetch(event.request).then((networkResponse) => {
                // Silently update the cache in the background
                caches.open(CACHE_NAME).then((cache) => {
                    if (event.request.url.startsWith(self.location.origin) || 
                        event.request.url.includes('cdnjs') || 
                        event.request.url.includes('flaticon')) {
                        cache.put(event.request, networkResponse.clone());
                    }
                });
                return networkResponse;
            }).catch(() => {
                console.log('[Service Worker] Offline, relying strictly on high cache.');
            });

            // Return cached response immediately, or wait for network if not in cache
            return cachedResponse || fetchPromise;
        })
    );
});
