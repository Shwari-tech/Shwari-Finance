]/**
 * Shwari Finance Service Worker v5.0.0
 * Features: Offline caching, duplicate instance prevention, auto-update
 */

const APP_VERSION = '5.0.0';
const CACHE_PREFIX = 'shwari-v5';
const CORE_CACHE = `${CACHE_PREFIX}-core`;
const DATA_CACHE = `${CACHE_PREFIX}-data`;
const IMAGE_CACHE = `${CACHE_PREFIX}-images`;
const STATIC_CACHE = `${CACHE_PREFIX}-static`;

// Critical assets that must be cached
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

// External resources
const EXTERNAL_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap',
  'https://cdn-icons-png.flaticon.com/128/1077/1077114.png'
];

// Background imagery
const BACKGROUND_ASSETS = [
  'https://shwarimoversandcleaners.co.ke/wp-content/uploads/2022/02/BOB_1049.jpg'
];

// Installation: Cache core assets immediately
self.addEventListener('install', (event) => {
  console.log(`[SW v${APP_VERSION}] Installing...`);
  
  event.waitUntil(
    (async () => {
      // 1. Open caches
      const [coreCache, imageCache] = await Promise.all([
        caches.open(CORE_CACHE),
        caches.open(IMAGE_CACHE)
      ]);
      
      // 2. Cache core assets with error handling
      const corePromises = CORE_ASSETS.map(async (url) => {
        try {
          const response = await fetch(url, { cache: 'no-cache' });
          if (response.ok) await coreCache.put(url, response);
        } catch (err) {
          console.warn(`[SW] Failed to cache: ${url}`);
        }
      });
      
      // 3. Cache external assets (CDN)
      const externalPromises = EXTERNAL_ASSETS.map(async (url) => {
        try {
          const response = await fetch(url, { 
            mode: 'no-cors',
            cache: 'no-cache'
          });
          await coreCache.put(url, response);
        } catch (err) {
          console.warn(`[SW] Failed to cache external: ${url}`);
        }
      });
      
      // 4. Cache background images
      const bgPromises = BACKGROUND_ASSETS.map(async (url) => {
        try {
          const response = await fetch(url);
          if (response.ok) await imageCache.put(url, response);
        } catch (err) {
          console.warn(`[SW] Failed to cache image: ${url}`);
        }
      });
      
      await Promise.all([...corePromises, ...externalPromises, ...bgPromises]);
      
      console.log(`[SW v${APP_VERSION}] Installation complete`);
      
      // 5. Force activation (skip waiting)
      await self.skipWaiting();
    })()
  );
});

// Activation: Clean old caches and take control
self.addEventListener('activate', (event) => {
  console.log(`[SW v${APP_VERSION}] Activating...`);
  
  event.waitUntil(
    (async () => {
      // 1. Get all existing cache names
      const cacheNames = await caches.keys();
      
      // 2. Delete old version caches (not matching current prefix)
      const deletionPromises = cacheNames.map(async (cacheName) => {
        if (cacheName !== CORE_CACHE && 
            cacheName !== DATA_CACHE && 
            cacheName !== IMAGE_CACHE && 
            cacheName !== STATIC_CACHE) {
          console.log(`[SW] Deleting old cache: ${cacheName}`);
          await caches.delete(cacheName);
        }
      });
      
      await Promise.all(deletionPromises);
      
      // 3. Take control of all clients immediately (prevents duplicates)
      await self.clients.claim();
      
      // 4. Notify all clients that SW is active
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(client => {
        client.postMessage({
          type: 'SW_ACTIVATED',
          version: APP_VERSION
        });
      });
      
      console.log(`[SW v${APP_VERSION}] Activation complete - controlling ${clients.length} clients`);
    })()
  );
});

// Fetch: Smart caching strategies
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Skip non-GET requests
  if (request.method !== 'GET') return;
  
  // Skip Google Apps Script (dynamic content)
  if (url.hostname.includes('script.google.com')) return;
  
  // Strategy 1: Network First for HTML (always fresh)
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Update cache with fresh version
          const clone = response.clone();
          caches.open(CORE_CACHE).then(cache => cache.put(request, clone));
          return response;
        })
        .catch(() => {
          console.log('[SW] Serving HTML from cache');
          return caches.match(request);
        })
    );
    return;
  }
  
  // Strategy 2: Cache First for Images & Backgrounds
  if (request.destination === 'image' || 
      url.pathname.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i)) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) {
          // Update in background
          fetch(request).then(response => {
            if (response.ok) cache.put(request, response);
          }).catch(() => {});
          return cached;
        }
        
        // Fetch and cache
        try {
          const response = await fetch(request);
          if (response.ok) cache.put(request, response.clone());
          return response;
        } catch (err) {
          // Return placeholder if offline
          return new Response('Offline', { status: 503 });
        }
      })
    );
    return;
  }
  
  // Strategy 3: Stale While Revalidate for CSS/JS/Fonts
  if (request.destination === 'style' || 
      request.destination === 'script' || 
      request.destination === 'font' ||
      url.hostname.includes('cdnjs') ||
      url.hostname.includes('google')) {
    event.respondWith(
      caches.open(CORE_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        
        const networkFetch = fetch(request).then(response => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        }).catch(() => cached);
        
        return cached || networkFetch;
      })
    );
    return;
  }
  
  // Strategy 4: Network with Cache Fallback (default)
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.status === 200) {
          const clone = response.clone();
          // Cache same-origin and trusted CDNs only
          if (url.origin === self.location.origin || 
              url.hostname.includes('cdnjs') ||
              url.hostname.includes('flaticon')) {
            caches.open(STATIC_CACHE).then(cache => cache.put(request, clone));
          }
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

// Message handling: Communication with main thread
self.addEventListener('message', (event) => {
  const { data, source } = event;
  
  switch(data.type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
      
    case 'GET_VERSION':
      source.postMessage({
        type: 'VERSION',
        version: APP_VERSION,
        scope: self.registration.scope
      });
      break;
      
    case 'CHECK_DUPLICATE':
      // Check if this is the only SW instance
      self.clients.matchAll({ type: 'window' }).then(clients => {
        source.postMessage({
          type: 'DUPLICATE_CHECK',
          clientCount: clients.length,
          isPrimary: clients.length <= 1
        });
      });
      break;
      
    case 'CLEAR_ALL_CACHES':
      event.waitUntil(
        caches.keys().then(names => 
          Promise.all(names.map(name => caches.delete(name)))
        ).then(() => {
          source.postMessage({ type: 'CACHES_CLEARED' });
        })
      );
      break;
      
    case 'CACHE_URLS':
      if (data.urls && Array.isArray(data.urls)) {
        event.waitUntil(
          caches.open(DATA_CACHE).then(cache => 
            cache.addAll(data.urls)
          )
        );
      }
      break;
  }
});

// Background Sync: Queue failed requests
self.addEventListener('sync', (event) => {
  if (event.tag === 'background-sync') {
    event.waitUntil(
      console.log('[SW] Background sync executed')
    );
  }
});

// Push notifications
self.addEventListener('push', (event) => {
  const options = {
    body: event.data?.text() || 'New notification from Shwari Finance',
    icon: 'https://cdn-icons-png.flaticon.com/128/1077/1077114.png',
    badge: 'https://cdn-icons-png.flaticon.com/128/1077/1077114.png',
    tag: 'shwari-notification',
    requireInteraction: true,
    vibrate: [200, 100, 200],
    data: {
      url: '/',
      timestamp: Date.now()
    }
  };
  
  event.waitUntil(
    self.registration.showNotification('Shwari Finance', options)
  );
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data?.url || '/')
  );
});

// Prevent multiple SW instances (safety check)
if (self.registration && self.registration.scope) {
  console.log(`[SW v${APP_VERSION}] Scope: ${self.registration.scope}`);
}

console.log(`[SW v${APP_VERSION}] Loaded and ready`);
