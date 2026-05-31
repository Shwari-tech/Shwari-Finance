/**
 * Shwari Finance — Service Worker
 * Production-grade caching, silent offline macro injection, and background sync
 * Optimized for seamless M-Pesa style offline/online transitions.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS & VERSION CONTROL
// ─────────────────────────────────────────────────────────────────────────────

const APP_VERSION       = '7.4.0'; // Bumped for instant browser take-over
const CACHE_VERSION     = 'v11';   // Incremented to enforce clean data boundaries

const CACHE_STATIC      = `shwari-static-${CACHE_VERSION}`;
const CACHE_DYNAMIC     = `shwari-dynamic-${CACHE_VERSION}`;
const CACHE_IMAGES      = `shwari-images-${CACHE_VERSION}`;
const CACHE_MACRO       = `shwari-macro-${CACHE_VERSION}`; 

// All known cache names this SW manages — used for safe cleanup
const KNOWN_CACHES      = new Set([CACHE_STATIC, CACHE_DYNAMIC, CACHE_IMAGES, CACHE_MACRO]);

// Maximum items in each dynamic cache to prevent unbounded growth
const MAX_DYNAMIC_ITEMS = 80;
const MAX_IMAGE_ITEMS   = 60;

// M-PESA STYLE FAST FAIL: Shortened timeout threshold to intercept poor networks immediately
const NETWORK_TIMEOUT_MS = 4000;

// Stable key used to store the macro snapshot in the dedicated cache
const MACRO_CACHE_KEY = 'shwari-macro-snapshot';

// ─────────────────────────────────────────────────────────────────────────────
// STATIC ASSETS — Pre-cached on install
// ─────────────────────────────────────────────────────────────────────────────

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/webfonts/fa-solid-900.woff2',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/webfonts/fa-regular-400.woff2',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap',
];

const ICON_ASSETS = [
  'https://cdn-icons-png.flaticon.com/128/1077/1077114.png',
  'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSpxUalu5VVwbs1UNYjhK-3aJ5Uwcy--A1Vlg&s',
];

const IMAGE_ASSETS = [
  'https://shwarimoversandcleaners.co.ke/wp-content/uploads/2022/02/BOB_1049.jpg',
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS & INDEXEDDB MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

const log  = (...args) => console.log(`[SW ${APP_VERSION}]`, ...args);
const warn = (...args) => console.warn(`[SW ${APP_VERSION}]`, ...args);
const err  = (...args) => console.error(`[SW ${APP_VERSION}]`, ...args);

/**
 * IndexedDB Helper for SW to read AND WRITE ShwariDB offline payloads
 */
const SW_IDB = {
    open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('ShwariDB', 1);
            req.onupgradeneeded = e => e.target.result.createObjectStore('macro_cache', { keyPath: 'id' });
            req.onsuccess = e => resolve(e.target.result);
            req.onerror = e => reject(e);
        });
    },

    async get(id) {
        try {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction('macro_cache', 'readonly');
                const store = tx.objectStore('macro_cache');
                const req = store.get(id);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            return null;
        }
    },

    async save(html) {
        try {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction('macro_cache', 'readwrite');
                const store = tx.objectStore('macro_cache');
                store.put({ id: 'macro_html', html, timestamp: Date.now() });
                tx.oncomplete = () => {
                    log('Macro HTML saved to IDB from SW (', Math.round(html.length / 1024), 'KB)');
                    resolve();
                };
                tx.onerror = e => reject(e.error);
            });
        } catch (e) {
            warn('SW_IDB.save failed silently:', e.message || e);
        }
    }
};

async function cacheAllSafe(cacheName, urls) {
  const cache = await caches.open(cacheName);
  const results = await Promise.allSettled(
    urls.map(url =>
      cache.add(url).catch(e => {
        warn(`Failed to pre-cache ${url}:`, e.message);
      })
    )
  );
  const failed = results.filter(r => r.status === 'rejected').length;
  log(`Pre-cached ${urls.length - failed}/${urls.length} assets into "${cacheName}"`);
}

async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys  = await cache.keys();
  if (keys.length > maxItems) {
    const toDelete = keys.slice(0, keys.length - maxItems);
    await Promise.all(toDelete.map(k => cache.delete(k)));
    log(`Trimmed ${toDelete.length} items from "${cacheName}"`);
  }
}

function fetchWithTimeout(request, ms = NETWORK_TIMEOUT_MS) {
  if (!navigator.onLine) {
    return Promise.reject(new Error('Offline: Fast-failing network request to use cache.'));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const req = new Request(request, { signal: controller.signal });

  return fetch(req).finally(() => clearTimeout(timer));
}

function isNeverCache(url) {
  return (
    url.href.includes('accounts.google.com') ||
    url.pathname.startsWith('/api/')
  );
}

function isHtmlRequest(request) {
  return (
    request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'))
  );
}

function isImageRequest(request, url) {
  return (
    request.destination === 'image' ||
    /\.(jpe?g|png|gif|webp|svg|ico)(\?|$)/i.test(url.pathname) ||
    /\.(jpe?g|png|gif|webp|svg|ico)(\?|$)/i.test(url.href)
  );
}

function isStaticAsset(request, url) {
  return (
    request.destination === 'style' ||
    request.destination === 'script' ||
    request.destination === 'font' ||
    url.href.includes('cdnjs.cloudflare.com') ||
    url.href.includes('fonts.googleapis.com') ||
    url.href.includes('fonts.gstatic.com')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LIFECYCLE EVENTS
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  log('Installing…');
  event.waitUntil(
    Promise.all([
      cacheAllSafe(CACHE_STATIC, [...STATIC_ASSETS, ...CDN_ASSETS, ...ICON_ASSETS]),
      cacheAllSafe(CACHE_IMAGES, IMAGE_ASSETS),
    ])
    .then(() => {
      log('Install complete — activating immediately');
      return self.skipWaiting();
    })
    .catch(e => err('Install failed:', e))
  );
});

self.addEventListener('activate', (event) => {
  log('Activating…');
  event.waitUntil(
    caches.keys()
      .then(async (allCaches) => {
        const deletions = allCaches
          .filter(name => !KNOWN_CACHES.has(name))
          .map(name => {
            log('Deleting stale cache:', name);
            return caches.delete(name);
          });
        await Promise.all(deletions);
      })
      .then(() => {
        log('Activation complete — claiming all clients');
        return self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
          .then(clients => {
            clients.forEach(client =>
              client.postMessage({ type: 'SW_ACTIVATED', version: APP_VERSION })
            );
            return self.clients.claim();
          });
      })
      .catch(e => err('Activation failed:', e))
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// NETWORK STRATEGY INTERCEPTOR
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;
  if (request.url.startsWith('blob:') || request.url.startsWith('data:')) return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Google Scripts Macros — Overhauled for silent instant asset recovery
  if (url.hostname.includes('script.google.com') || url.hostname.includes('script.googleusercontent.com')) {
    event.respondWith(networkFirstMacro(request));
    return;
  }

  if (isNeverCache(url)) return;

  if (isHtmlRequest(request)) {
    event.respondWith(networkFirstHTML(request));
    return;
  }

  if (isImageRequest(request, url)) {
    event.respondWith(cacheFirstImage(request));
    return;
  }

  if (isStaticAsset(request, url)) {
    event.respondWith(staleWhileRevalidate(request, CACHE_STATIC));
    return;
  }

  event.respondWith(networkWithCacheFallback(request));
});

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY IMPLEMENTATIONS
// ─────────────────────────────────────────────────────────────────────────────

async function serveOfflineMacro() {
    try {
        const idbData = await SW_IDB.get('macro_html');
        if (idbData && idbData.html) {
            log('Serving macro from IndexedDB snapshot');
            return new Response(idbData.html, {
                status: 200,
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }
    } catch (e) {
        warn('IDB read failed, trying Cache API…');
    }

    try {
        const macroCache = await caches.open(CACHE_MACRO);
        const cached = await macroCache.match(MACRO_CACHE_KEY);
        if (cached) {
            log('Serving macro from CACHE_MACRO');
            return cached;
        }
    } catch (e) {
        warn('CACHE_MACRO read failed, trying CACHE_DYNAMIC…');
    }

    try {
        const dynCache = await caches.open(CACHE_DYNAMIC);
        const keys = await dynCache.keys();
        const macroKey = keys.find(k =>
            k.url.includes('script.google.com') || k.url.includes('script.googleusercontent.com')
        );
        if (macroKey) {
            const cached = await dynCache.match(macroKey);
            if (cached) {
                log('Serving macro from CACHE_DYNAMIC');
                return cached;
            }
        }
    } catch (e) {
        warn('CACHE_DYNAMIC read failed, serving built-in fallback.');
    }

    log('No cached macro found — forcing alternative network layout extraction context');
    return fetch(request).catch(() => buildOfflineFallbackResponse());
}

async function networkFirstMacro(request) {
    const urlObj   = new URL(request.url);
    const cleanUrl = urlObj.origin + urlObj.pathname;

    if (!navigator.onLine) {
        log('Device offline — serving macro from cache/IDB immediately');
        return serveOfflineMacro();
    }

    try {
        // M-PESA ULTRA RECOVERY: Replaced slow 20s timeout with strict 4s check to protect against Lie-Fi locks
        const networkRes = await fetchWithTimeout(request, 4000);

        if (!networkRes) throw new Error('Empty response from macro endpoint');

        const isGenuine = (networkRes.ok || networkRes.type === 'opaque' || networkRes.status === 302);

        if (isGenuine) {
            const htmlClone = networkRes.clone();

            caches.open(CACHE_DYNAMIC)
                .then(cache => cache.put(cleanUrl, networkRes.clone()))
                .catch(() => {});

            caches.open(CACHE_MACRO)
                .then(cache => cache.put(MACRO_CACHE_KEY, networkRes.clone()))
                .catch(() => {});

            htmlClone.text().then(html => {
                const isRealDashboard = (
                    html.length > 500 &&
                    !html.toLowerCase().includes('servicelogin') &&
                    !html.toLowerCase().includes('accounts.google.com/o/oauth')
                );
                if (isRealDashboard) {
                    // M-PESA ARCHITECTURE UPGRADE: Removed structural location reloads to prevent loop stuttering
                    const patch = `<script>(function(){var chain={withSuccessHandler:function(fn){chain._sh=fn;return chain;},withFailureHandler:function(fn){chain._fh=fn;return chain;},withUserObject:function(){return chain;}};var rp=new Proxy(chain,{get:function(t,p){if(p in t)return t[p];return function(){if(chain._fh)chain._fh(new Error('Offline'));return chain;};}});var n=function(){};window.google=window.google||{};window.google.script={run:rp,history:{push:n,replace:n},url:{getLocation:function(cb){cb&&cb({hash:'',parameter:{},parameters:{},pathname:'/',port:'443',protocol:'https:',toString:function(){return '';}});}},host:{close:n,setHeight:n,setWidth:n,editor:{focus:n}}};})();<\/script>`;
                    const patched = html.includes('<head>') ? html.replace('<head>', '<head>' + patch) : patch + html;
                    SW_IDB.save(patched);
                    log('Macro HTML patched & saved to IDB — full native execution layer enabled');
                } else {
                    warn('Macro response looks like a login/error page — NOT caching');
                }
            }).catch(() => {});
        }

        return networkRes;

    } catch (e) {
        log('Macro network fetch timed out or failed — dropping directly into offline cache storage structure');
        return serveOfflineMacro();
    }
}

function buildOfflineFallbackResponse() {
    const offlineHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Offline Dashboard</title>
    <style>
        body { background: #111827; color: #fff; font-family: 'Inter', system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; padding: 30px; box-sizing: border-box; }
        .icon { width: 90px; height: 90px; background: linear-gradient(135deg, #1f6e3f, #55d082); border-radius: 28px; display: flex; align-items: center; justify-content: center; margin-bottom: 24px; box-shadow: 0 15px 35px rgba(85,208,130,0.3); font-size: 44px; }
        h2 { font-size: 26px; font-weight: 800; margin-bottom: 12px; color: #55d082; letter-spacing: -0.5px; }
        p { font-size: 15px; color: #94a3b8; line-height: 1.6; max-width: 320px; margin-bottom: 30px; }
        .loader { width: 40px; height: 40px; border: 3px solid rgba(85,208,130,0.2); border-top: 3px solid #55d082; border-radius: 50%; animation: spin 1s linear infinite; }
        .status { margin-top: 16px; font-size: 12px; color: #4b5563; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="icon">🐘</div>
    <h2>Offline Mode</h2>
    <p>No connection detected. Shwari Finance will automatically reload your dashboard the moment you're back online.</p>
    <div class="loader"></div>
    <p class="status" id="status-text">Waiting for connection…</p>
    <script>
        let attempts = 0;
        function tryReload() {
            attempts++;
            document.getElementById('status-text').textContent = 'Attempt ' + attempts + '… checking connection';
            if (navigator.onLine) { window.location.reload(); return; }
            document.getElementById('status-text').textContent = 'Still offline. Retrying in 5s…';
        }
        window.addEventListener('online', () => window.location.reload());
        setInterval(tryReload, 5000);
    </script>
</body>
</html>`;

    return new Response(offlineHtml, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}

async function networkFirstHTML(request) {
  try {
    const networkRes = await fetchWithTimeout(request);
    if (networkRes.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, networkRes.clone());
    }
    return networkRes;
  } catch (e) {
    log('Network failed for HTML, serving from cache:', request.url);
    const cached = await caches.match(request, { ignoreSearch: true });
    return cached || caches.match('/index.html');
  }
}

async function cacheFirstImage(request) {
  const cache    = await caches.open(CACHE_IMAGES);
  const cached   = await cache.match(request);

  if (cached) {
    fetchAndCacheImage(cache, request);
    return cached;
  }
  return fetchAndCacheImage(cache, request);
}

async function fetchAndCacheImage(cache, request) {
  try {
    const networkRes = await fetch(request);
    if (networkRes.ok) {
      cache.put(request, networkRes.clone());
      trimCache(CACHE_IMAGES, MAX_IMAGE_ITEMS);
    }
    return networkRes;
  } catch (e) {
    warn('Image fetch failed:', request.url);
    return new Response(
      Uint8Array.from(atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
      ), c => c.charCodeAt(0)),
      { headers: { 'Content-Type': 'image/png' } }
    );
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);

  const networkPromise = fetch(request).then(res => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);

  return cached || networkPromise;
}

async function networkWithCacheFallback(request) {
  const url = new URL(request.url);

  try {
    const networkRes = await fetchWithTimeout(request);
    if (networkRes && networkRes.status === 200) {
      const isTrusted =
        url.origin === self.location.origin ||
        url.href.includes('cdnjs.cloudflare.com') ||
        url.href.includes('flaticon.com') ||
        url.href.includes('gstatic.com') ||
        url.href.includes('googleapis.com') ||
        url.href.includes('shwarimoversandcleaners.co.ke');

      if (isTrusted) {
        const cache = await caches.open(CACHE_DYNAMIC);
        cache.put(request, networkRes.clone());
        trimCache(CACHE_DYNAMIC, MAX_DYNAMIC_ITEMS);
      }
    }
    return networkRes;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;

    return new Response(
      JSON.stringify({ error: 'offline', message: 'You appear to be offline.' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM OVERLAYS & BACKGROUND BRIDGE
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('sync', (event) => {
  log('Background sync triggered:', event.tag);
  if (event.tag === 'sync-payroll-data') {
    event.waitUntil(syncPayrollData());
  }
});

async function syncPayrollData() {
  try {
    log('Syncing queued payroll data…');
  } catch (e) {
    err('Background sync failed:', e);
    throw e;
  }
}

self.addEventListener('push', (event) => {
  let payload = { title: 'Shwari Finance', body: 'You have a new update.' };
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload.body = event.data.text();
    }
  }

  const options = {
    body:    payload.body,
    icon:    'https://cdn-icons-png.flaticon.com/128/1077/1077114.png',
    badge:   'https://cdn-icons-png.flaticon.com/128/1077/1077114.png',
    vibrate: [100, 50, 100],
    tag:     payload.tag || 'shwari-notification',
    renotify: !!payload.tag,
    data:    { url: payload.url || '/' },
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Shwari Finance', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        const existing = clients.find(c => c.url.includes(targetUrl));
        if (existing) return existing.focus();
        return self.clients.openWindow(targetUrl);
      })
  );
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'refresh-payroll') {
    log('Periodic sync: refreshing payroll data');
    event.waitUntil(
      caches.open(CACHE_STATIC).then(cache => {
        return cache.delete('/index.html').then(() => {
          return fetch('/index.html').then(res => cache.put('/index.html', res));
        });
      }).catch(e => warn('Periodic sync failed:', e))
    );
  }
});

self.addEventListener('message', (event) => {
  const { data } = event;
  if (!data) return;

  const type = typeof data === 'string' ? data : data.type;

  switch (type) {
    case 'SKIP_WAITING':
    case 'skipWaiting':
      log('Received SKIP_WAITING — activating immediately');
      self.skipWaiting();
      break;

    case 'GET_VERSION':
    case 'getVersion':
      event.ports?.[0]?.postMessage({ version: APP_VERSION, caches: [...KNOWN_CACHES] });
      break;

    case 'CLEAR_CACHE':
    case 'clearCache':
      log('Clearing all caches on request');
      event.waitUntil(
        caches.keys().then(names =>
          Promise.all(names.map(n => caches.delete(n)))
        ).then(() => {
          event.ports?.[0]?.postMessage({ cleared: true });
          log('All caches cleared');
        })
      );
      break;

    case 'TRIM_CACHES':
      event.waitUntil(
        Promise.all([
          trimCache(CACHE_DYNAMIC, MAX_DYNAMIC_ITEMS),
          trimCache(CACHE_IMAGES, MAX_IMAGE_ITEMS),
        ])
      );
      break;

    case 'CHECK_DUPLICATE_INSTALL':
      self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
        .then(clients => {
          event.ports?.[0]?.postMessage({
            clientCount:   clients.length,
            activeVersion: APP_VERSION,
          });
        });
      break;

    case 'FORCE_MACRO_CACHE':
      if (data.html && data.html.length > 500) {
        event.waitUntil(SW_IDB.save(data.html));
      }
      break;

    default:
      warn('Unknown message type received:', type);
  }
});

log('Loaded successfully');
