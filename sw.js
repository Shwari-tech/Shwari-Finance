{
  "name": "Shwari Finance Pay App",
  "short_name": "Shwari",
  "description": "Core portal for Shwari enterprise management and finance.",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#2c7a47",
  "orientation": "portrait",
  "icons": [
    {
      "src": "https://cdn-icons-png.flaticon.com/512/1077/1077114.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "https://cdn-icons-png.flaticon.com/512/1077/1077114.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ]
}


const CACHE_NAME = 'shwari-pay-v1';

// Add the URLs of the core files you want to cache for instant offline loading
const CACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css',
  'https://cdn-icons-png.flaticon.com/512/1077/1077114.png' // The new Apple Touch Icon
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

  // CRITICAL: Do not attempt to cache the Google Apps Script iframe.
  // Google's security tokens change constantly. Caching this will break the dashboard.
  if (event.request.url.includes('script.google.com')) {
      return; 
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // If the network request is successful, clone the response and update the cache
        const resClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          // Cache our own origin files and our specific external libraries (FontAwesome/Icons)
          if (event.request.url.startsWith(self.location.origin) || 
              event.request.url.includes('cdnjs') || 
              event.request.url.includes('flaticon')) {
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
