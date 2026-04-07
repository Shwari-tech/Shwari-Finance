// Bumped version to v4 to aggressively force a cache clear and update
const CACHE_NAME = 'shwari-pay-v4';

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

// 1. Install Event: Cache the new application shell and force waiting SW to activate immediately
self.addEventListener('install', (event) => {
  console.log('[Service Worker v4] Installed');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker v4] Caching App Shell');
        return cache.addAll(CACHE_ASSETS);
      })
      .then(() => self.skipWaiting()) // Forces the SW to activate immediately without waiting for tabs to close
  );
});

// 2. Activate Event: Aggressively clean up ALL old caches
self.addEventListener('activate', (event) => {
  console.log('[Service Worker v4] Activated');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          // If the cache name doesn't match our current v4, delete it
          if (cache !== CACHE_NAME) {
            console.log('[Service Worker v4] Clearing Old Cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
  // Claim all clients to ensure the new SW controls all open pages immediately
  return self.clients.claim(); 
});

// 3. Fetch Event: Stale-While-Revalidate Strategy
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // CRITICAL: Bypass cache entirely for Google Apps Script to prevent security token errors
  if (event.request.url.includes('script.google.com') || event.request.url.includes('googleusercontent.com')) {
      return; 
  }

  // ADDED: Force "Network First" strictly for the HTML file. 
  // This guarantees that if you change the macro URL in index.html, it updates instantly.
  if (event.request.mode === 'navigate' || event.request.url.includes('index.html')) {
      event.respondWith(
          fetch(event.request).then((networkResponse) => {
              return caches.open(CACHE_NAME).then((cache) => {
                  cache.put(event.request, networkResponse.clone());
                  return networkResponse;
              });
          }).catch(() => {
              console.log('[Service Worker v4] Network failed, serving HTML from cache.');
              return caches.match(event.request);
          })
      );
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
         console.log('[Service Worker v4] Network failed, relying strictly on cache.');
      });

      // INSTANT LOAD: If we have it in cache, return it immediately! 
      // The background fetch will quietly update the cache for the next time they open the app.
      return cachedResponse || fetchPromise;
    })
  );
});
