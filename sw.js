// Bumped version to v2 to force users' phones to update the service worker
const CACHE_NAME = 'shwari-pay-v2';

// Added Google Fonts and the new Manifest Icons to the pre-cache list
const CACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap',
  'https://cdn-icons-png.flaticon.com/128/1077/1077114.png',
  'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSpxUalu5VVwbs1UNYjhK-3aJ5Uwcy--A1Vlg&s' 
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

// 3. Fetch Event: Stale-While-Revalidate Strategy
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // CRITICAL: Bypass cache entirely for Google Apps Script to prevent security token errors
  if (event.request.url.includes('script.google.com') || event.request.url.includes('googleusercontent.com')) {
      return; 
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      
      // Background Fetch: Always fetch the latest version from the network in the background
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        
        // Ensure we only cache valid responses from our allowed domains
        if (networkResponse && networkResponse.status === 200) {
            const url = event.request.url;
            if (url.startsWith(self.location.origin) || 
                url.includes('cdnjs') || 
                url.includes('flaticon') ||
                url.includes('gstatic') ||       // Allows Google Fonts & Icons
                url.includes('googleapis') ||    // Allows Google Fonts CSS
                url.includes('dreamstime')) {    // Allows Manifest Screenshots
              
              const resClone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, resClone);
              });
            }
        }
        return networkResponse;
      }).catch(() => {
         console.log('[Service Worker] Network failed, relying strictly on cache.');
      });

      // INSTANT LOAD: If we have it in cache, return it immediately! 
      // The background fetch will quietly update the cache for the next time they open the app.
      return cachedResponse || fetchPromise;
    })
  );
});
