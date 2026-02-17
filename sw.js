const CACHE_NAME = 'shwari-core-v4';

// Add the URLs of the files you want to cache for offline access
const CACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css',
  'https://cdn-icons-png.flaticon.com/512/2942/2942263.png'
];

// 1. Install Event: Cache the application shell
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installed');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Caching App Shell');
        return cache.addAll(CACHE_ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// 2. Activate Event: Clean up old caches if the version changes
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

// 3. Fetch Event: Intercept network requests and serve from cache if offline
self.addEventListener('fetch', (event) => {
  // We only want to handle GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // If the network request is successful, clone the response and update the cache
        const resClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          // Do not cache external cross-origin requests unless necessary, to save space
          if (event.request.url.startsWith(self.location.origin)) {
            cache.put(event.request, resClone);
          }
        });
        return response;
      })
      .catch(() => {
        // If network fails (offline), serve from cache
        console.log('[Service Worker] Network failed, serving from cache');
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // If the page isn't in the cache, default to the home page shell
          if (event.request.headers.get('accept').includes('text/html')) {
            return caches.match('/');
          }
        });
      })
  );
});
