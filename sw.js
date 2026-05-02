/**
 * Shwari Finance — Service Worker v7
 * Production-grade caching, offline support, and background sync
 *
 * Strategies used:
 *  - HTML pages        → Network First  (freshness > speed)
 *  - Images            → Cache First    (stale-while-revalidate in BG)
 *  - CSS / JS / Fonts  → Stale-While-Revalidate
 *  - Macro / GAS calls → Network First  (with strict offline HTML fallback)
 *  - Everything else   → Network with Cache Fallback
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const APP_VERSION      = '7.0.0';
const CACHE_VERSION    = 'v7';

const CACHE_STATIC     = `shwari-static-${CACHE_VERSION}`;
const CACHE_DYNAMIC    = `shwari-dynamic-${CACHE_VERSION}`;
const CACHE_IMAGES     = `shwari-images-${CACHE_VERSION}`;
const CACHE_MACRO      = `shwari-macro-${CACHE_VERSION}`;   // ← dedicated macro cache

// All known cache names this SW manages — used for safe cleanup
const KNOWN_CACHES     = new Set([CACHE_STATIC, CACHE_DYNAMIC, CACHE_IMAGES, CACHE_MACRO]);

// Maximum items in each dynamic cache to prevent unbounded growth
const MAX_DYNAMIC_ITEMS = 80;
const MAX_IMAGE_ITEMS   = 60;

// Network request timeout (ms) before falling back to cache
const NETWORK_TIMEOUT_MS = 5000;

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
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Logs a message with version prefix.
 */
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

    /**
     * Saves the macro HTML snapshot to IndexedDB.
     * Called from the SW after every successful macro network fetch.
     * @param {string} html - The full HTML string of the macro page
     */
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

/**
 * Opens a cache and safely caches all URLs, skipping any that fail.
 * Using addAll would abort the entire batch if one URL fails.
 */
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

/**
 * Trims a cache to a maximum number of entries (oldest-first eviction).
 */
async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys  = await cache.keys();
  if (keys.length > maxItems) {
    const toDelete = keys.slice(0, keys.length - maxItems);
    await Promise.all(toDelete.map(k => cache.delete(k)));
    log(`Trimmed ${toDelete.length} items from "${cacheName}"`);
  }
}

/**
 * Race a fetch against a timeout. Rejects with a TimeoutError on expiry.
 * Fast fails if offline to avoid hanging on Lie-Fi.
 */
function fetchWithTimeout(request, ms = NETWORK_TIMEOUT_MS) {
  if (!navigator.onLine) {
    return Promise.reject(new Error('Offline: Fast-failing network request to use cache.'));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  // Clone the request to attach the abort signal safely
  const req = new Request(request, { signal: controller.signal });

  return fetch(req).finally(() => clearTimeout(timer));
}

/**
 * Returns true for URLs that should never be cached (live APIs).
 */
function isNeverCache(url) {
  return (
    url.href.includes('accounts.google.com') ||
    url.pathname.startsWith('/api/')
  );
}

/**
 * Returns true for requests that are navigations or expect HTML.
 */
function isHtmlRequest(request) {
  return (
    request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'))
  );
}

/**
 * Returns true for image requests.
 */
function isImageRequest(request, url) {
  return (
    request.destination === 'image' ||
    /\.(jpe?g|png|gif|webp|svg|ico)(\?|$)/i.test(url.pathname) ||
    /\.(jpe?g|png|gif|webp|svg|ico)(\?|$)/i.test(url.href)
  );
}

/**
 * Returns true for static asset requests (CSS, JS, fonts, CDN).
 */
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
// INSTALL — Pre-cache all static assets
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

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVATE — Delete stale caches, claim clients
// ─────────────────────────────────────────────────────────────────────────────

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
// FETCH — Route requests to the right strategy
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Ignore non-GET
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return; // Malformed URL — ignore
  }

  // ── STRATEGY 0: Google Macro URLs — always intercepted for offline support ─
  if (url.hostname.includes('script.google.com') || url.hostname.includes('script.googleusercontent.com')) {
    event.respondWith(networkFirstMacro(request));
    return;
  }

  // Never cache live API endpoints
  if (isNeverCache(url)) return;

  // ── Strategy 1: Network First (HTML pages) ────────────────────────────────
  if (isHtmlRequest(request)) {
    event.respondWith(networkFirstHTML(request));
    return;
  }

  // ── Strategy 2: Cache First + BG Revalidate (Images) ─────────────────────
  if (isImageRequest(request, url)) {
    event.respondWith(cacheFirstImage(request));
    return;
  }

  // ── Strategy 3: Stale-While-Revalidate (CSS / JS / Fonts) ────────────────
  if (isStaticAsset(request, url)) {
    event.respondWith(staleWhileRevalidate(request, CACHE_STATIC));
    return;
  }

  // ── Strategy 4: Network with Cache Fallback (everything else) ─────────────
  event.respondWith(networkWithCacheFallback(request));
});

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY IMPLEMENTATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the offline macro snapshot from all available sources in priority order:
 *   1. IndexedDB   (full HTML string, saved by both SW and main thread)
 *   2. CACHE_MACRO (dedicated Response cache with stable key)
 *   3. CACHE_DYNAMIC (general dynamic cache, older snapshot may live here)
 *   4. Built-in offline HTML fallback
 *
 * @returns {Promise<Response>}
 */
async function serveOfflineMacro() {
    // 1. IndexedDB — highest quality, written by SW after every live fetch
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

    // 2. Dedicated macro cache (stable key, written by SW)
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

    // 3. General dynamic cache (older path — still valid)
    try {
        const dynCache = await caches.open(CACHE_DYNAMIC);
        // Search without query string variations
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

    // 4. Ultimate offline HTML fallback
    log('No cached macro found — serving built-in offline shell');
    return buildOfflineFallbackResponse();
}

/**
 * Special interceptor for the Google Scripts Macro.
 *
 * Online  → Fetch live, save to IDB + CACHE_MACRO, return live response.
 * Offline → serveOfflineMacro() with 3-tier fallback chain.
 */
async function networkFirstMacro(request) {
    const urlObj   = new URL(request.url);
    const cleanUrl = urlObj.origin + urlObj.pathname; // Strip cache-busters for stable key

    // FAST OFFLINE BAILOUT — skip the network entirely if we know we're offline
    if (!navigator.onLine) {
        log('Device offline — serving macro from cache/IDB immediately');
        return serveOfflineMacro();
    }

    try {
        const networkRes = await fetchWithTimeout(request, 15000);

        // Only cache genuine HTML responses (ok or opaque redirects)
        const cacheable = networkRes && (networkRes.ok || networkRes.type === 'opaque' || networkRes.status === 302);

        if (cacheable) {
            // ── Save to CACHE_DYNAMIC with path-based stable key ──────────
            caches.open(CACHE_DYNAMIC).then(cache => cache.put(cleanUrl, networkRes.clone())).catch(() => {});

            // ── Save to dedicated CACHE_MACRO with a fixed string key ─────
            // This makes lookup O(1) and version-stable
            caches.open(CACHE_MACRO).then(cache => cache.put(MACRO_CACHE_KEY, networkRes.clone())).catch(() => {});

            // ── Also extract HTML text and persist to IndexedDB from the SW ─
            // This is the most reliable offline source because it survives
            // cache eviction and HTTP cache header conflicts.
            networkRes.clone().text().then(html => {
                if (html && html.length > 500) { // sanity check — not an empty/error page
                    SW_IDB.save(html);
                }
            }).catch(() => {});
        }

        return networkRes;

    } catch (e) {
        log('Macro network fetch failed:', e.message, '— falling back to offline sources');
        return serveOfflineMacro();
    }
}

/**
 * Builds the built-in offline fallback HTML Response.
 * Auto-reloads when connectivity is restored.
 */
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

/**
 * Network First — try network with timeout, fall back to cache.
 * Updates cache on successful network response.
 */
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
    return cached || caches.match('/index.html'); // Ultimate fallback
  }
}

/**
 * Cache First — return cached image immediately, update cache silently.
 * Trims cache when it gets too large.
 */
async function cacheFirstImage(request) {
  const cache    = await caches.open(CACHE_IMAGES);
  const cached   = await cache.match(request);

  if (cached) {
    // Background revalidation — fire and forget
    fetchAndCacheImage(cache, request);
    return cached;
  }

  // Not in cache — fetch, store, return
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
    // Return a transparent 1×1 PNG as placeholder (no broken-image icon)
    return new Response(
      Uint8Array.from(atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
      ), c => c.charCodeAt(0)),
      { headers: { 'Content-Type': 'image/png' } }
    );
  }
}

/**
 * Stale-While-Revalidate — return cache immediately, update in background.
 * Falls back to network if not cached yet.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);

  // Always kick off a background refresh
  const networkPromise = fetch(request).then(res => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);

  return cached || networkPromise;
}

/**
 * Network with Cache Fallback — try network, serve cache if offline.
 * Caches successful responses from trusted origins.
 */
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

    // Return a structured JSON error for non-HTML requests
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
// BACKGROUND SYNC
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

// ─────────────────────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// PERIODIC BACKGROUND SYNC (Chrome 80+)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE HANDLING — Main thread ↔ Service Worker bridge
// ─────────────────────────────────────────────────────────────────────────────

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

    // ── NEW: Force macro re-cache from main thread ────────────────────────
    case 'FORCE_MACRO_CACHE':
      if (data.html && data.html.length > 500) {
        event.waitUntil(SW_IDB.save(data.html));
      }
      break;

    default:
      warn('Unknown message type received:', type);
  }
});

// ─────────────────────────────────────────────────────────────────────────────

log('Loaded successfully');
