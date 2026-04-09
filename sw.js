/**
 * Shwari Finance - Enhanced Service Worker v5
 * Massive offline caching with aggressive cache strategies
 */

const CACHE_NAME = 'shwari-pay-v5';
const DATA_CACHE_NAME = 'shwari-data-v5';
const IMAGE_CACHE_NAME = 'shwari-images-v5';
const APP_VERSION = '5.0.0';

// Core app assets - always cached
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/sw.js'
];

// External CDN assets
const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/webfonts/fa-solid-900.woff2',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/webfonts/fa-regular-400.woff2',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap'
];

// Icon assets
const ICON_ASSETS = [
  'https://cdn-icons-png.flaticon.com/128/1077/1077114.png',
  'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSpxUalu5VVwbs1UNYjhK-3aJ5Uwcy--A1Vlg&s'
];

// Background image
const BACKGROUND_ASSETS = [
  'https://shwarimoversandcleaners.co.ke/wp-content/uploads/2022/02/BOB_1049.jpg'
];

// Combine all cache assets
const CACHE_ASSETS = [...CORE_ASSETS, ...CDN_ASSETS, ...ICON_ASSETS];

// =========================================
// INSTALL EVENT - Cache core assets
// =========================================
self.addEventListener('install', (event) => {
  console.log(`[Service Worker v${APP_VERSION}] Installing...`);
  
  event.waitUntil(
    Promise.all([
      // Cache core assets
      caches.open(CACHE_NAME).then((cache) => {
        console.log(`[Service Worker v${APP_VERSION}] Caching core assets`);
        return cache.addAll(CACHE_ASSETS);
      }),
      
      // Cache background image separately
      caches.open(IMAGE_CACHE_NAME).then((cache) => {
        console.log(`[Service Worker v${APP_VERSION}] Caching images`);
        return cache.addAll(BACKGROUND_ASSETS);
      }),
      
      // Pre-cache Google Fonts
      caches.open(CACHE_NAME).then((cache) => {
        return fetch('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap')
          .then(response => {
            if (response.ok) {
              return cache.put('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap', response);
            }
          })
          .catch(err => console.log('Font pre-cache failed:', err));
      })
    ])
    .then(() => {
      console.log(`[Service Worker v${APP_VERSION}] Install complete`);
      return self.skipWaiting();
    })
    .catch((error) => {
      console.error(`[Service Worker v${APP_VERSION}] Install failed:`, error);
    })
  );
});

// =========================================
// ACTIVATE EVENT - Clean up old caches
// =========================================
self.addEventListener('activate', (event) => {
  console.log(`[Service Worker v${APP_VERSION}] Activating...`);
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          // Delete old version caches
          if (!cache.includes(APP_VERSION.split('.')[0])) {
            console.log(`[Service Worker v${APP_VERSION}] Deleting old cache:`, cache);
            return caches.delete(cache);
          }
        })
      );
    })
    .then(() => {
      console.log(`[Service Worker v${APP_VERSION}] Activation complete`);
      // Force all clients to verify their version and state immediately upon activation
      self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({ type: 'FORCE_DUPLICATE_VERIFICATION', version: APP_VERSION }));
      });
      return self.clients.claim();
    })
  );
});

// =========================================
// FETCH EVENT - Advanced caching strategies
// =========================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Skip non-GET requests
  if (request.method !== 'GET') return;
  
  // Skip Google Apps Script - never cache
  if (url.href.includes('script.google.com') || 
      url.href.includes('googleusercontent.com')) {
    return;
  }

  // =========================================
  // Strategy 1: Network First for HTML
  // =========================================
  if (request.mode === 'navigate' || request.headers.get('accept').includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          // Update cache with fresh version
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
          return networkResponse;
        })
        .catch(() => {
          console.log('[Service Worker] Network failed, serving HTML from cache');
          return caches.match(request);
        })
    );
    return;
  }

  // =========================================
  // Strategy 2: Cache First for Images
  // =========================================
  if (request.destination === 'image' || 
      url.href.includes('.jpg') || 
      url.href.includes('.png') || 
      url.href.includes('.webp') ||
      url.href.includes('.gif')) {
    event.respondWith(
      caches.open(IMAGE_CACHE_NAME).then((cache) => {
        return cache.match(request).then((cachedResponse) => {
          if (cachedResponse) {
            // Return cached and update in background
            fetch(request).then((networkResponse) => {
              if (networkResponse.ok) {
                cache.put(request, networkResponse);
              }
            }).catch(() => {});
            return cachedResponse;
          }
          
          // Not in cache, fetch and store
          return fetch(request).then((networkResponse) => {
            if (networkResponse.ok) {
              cache.put(request, networkResponse.clone());
            }
            return networkResponse;
          });
        });
      })
    );
    return;
  }

  // =========================================
  // Strategy 3: Stale While Revalidate for CSS/JS/Fonts
  // =========================================
  if (request.destination === 'style' || 
      request.destination === 'script' || 
      request.destination === 'font' ||
      url.href.includes('cdnjs') ||
      url.href.includes('fonts.googleapis') ||
      url.href.includes('fonts.gstatic')) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(request).then((cachedResponse) => {
          const fetchPromise = fetch(request).then((networkResponse) => {
            if (networkResponse.ok) {
              cache.put(request, networkResponse.clone());
            }
            return networkResponse;
          }).catch(() => {
            console.log('[Service Worker] Network failed for asset:', url.href);
          });
          
          return cachedResponse || fetchPromise;
        });
      })
    );
    return;
  }

  // =========================================
  // Strategy 4: Default - Network with Cache Fallback
  // =========================================
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        // Cache valid responses
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          const isCacheable = 
            url.origin === self.location.origin ||
            url.href.includes('cdnjs') ||
            url.href.includes('flaticon') ||
            url.href.includes('gstatic') ||
            url.href.includes('googleapis') ||
            url.href.includes('shwarimoversandcleaners');
          
          if (isCacheable) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(request);
      })
  );
});

// =========================================
// BACKGROUND SYNC - Queue failed requests
// =========================================
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-data') {
    event.waitUntil(syncData());
  }
});

async function syncData() {
  // Implement background sync logic here
  console.log('[Service Worker] Background sync triggered');
}

// =========================================
// PUSH NOTIFICATIONS
// =========================================
self.addEventListener('push', (event) => {
  const options = {
    body: event.data ? event.data.text() : 'New notification from Shwari Finance',
    icon: 'https://cdn-icons-png.flaticon.com/128/1077/1077114.png',
    badge: 'https://cdn-icons-png.flaticon.com/128/1077/1077114.png',
    vibrate: [100, 50, 100],
    data: {
      url: '/'
    }
  };
  
  event.waitUntil(
    self.registration.showNotification('Shwari Finance', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url)
  );
});

// =========================================
// MESSAGE HANDLING - Communication with main thread & Anti-Duplicate Security
// =========================================
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
  
  if (event.data === 'getVersion') {
    event.ports[0].postMessage({ version: APP_VERSION });
  }
  
  if (event.data === 'clearCache') {
    event.waitUntil(
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cache) => caches.delete(cache))
        );
      })
    );
  }

  // --- NEW: ANTI-DUPLICATE SYSTEM INTERFACE ---
  if (event.data && event.data.type === 'CHECK_DUPLICATE_INSTALL') {
      self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(windowClients => {
          // Reports back to the requesting tab how many instances are actively attached to this worker
          if (event.ports && event.ports[0]) {
              event.ports[0].postMessage({
                  clientCount: windowClients.length,
                  activeVersion: APP_VERSION
              });
          }
      });
  }
});

console.log(`[Service Worker v${APP_VERSION}] Loaded successfully`);
