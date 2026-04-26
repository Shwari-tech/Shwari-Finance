/**
 * Shwari Finance — Service Worker v6
 * Production-grade caching, offline support, and background sync
 *
 * Strategies used:
 *  - HTML pages        → Network First  (freshness > speed)
 *  - Images            → Cache First    (stale-while-revalidate in BG)
 *  - CSS / JS / Fonts  → Stale-While-Revalidate
 *  - API / GAS calls   → Network Only   (never cached)
 *  - Everything else   → Network with Cache Fallback
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const APP_VERSION      = '6.0.0';
const CACHE_VERSION    = 'v6';

const CACHE_STATIC     = `shwari-static-${CACHE_VERSION}`;
const CACHE_DYNAMIC    = `shwari-dynamic-${CACHE_VERSION}`;
const CACHE_IMAGES     = `shwari-images-${CACHE_VERSION}`;

// All known cache names this SW manages — used for safe cleanup
const KNOWN_CACHES     = new Set([CACHE_STATIC, CACHE_DYNAMIC, CACHE_IMAGES]);

// Maximum items in each dynamic cache to prevent unbounded growth
const MAX_DYNAMIC_ITEMS = 80;
const MAX_IMAGE_ITEMS   = 60;

// Network request timeout (ms) before falling back to cache
const NETWORK_TIMEOUT_MS = 5000;

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
 */
function fetchWithTimeout(request, ms = NETWORK_TIMEOUT_MS) {
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
    url.href.includes('script.google.com') ||
    url.href.includes('googleusercontent.com') ||
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
      // Take control without waiting for old SW to release clients
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
        // Notify open tabs that a new SW version is active
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
      // Minimal valid PNG
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
    // Retrieve queued requests from IndexedDB here if implemented
    log('Syncing queued payroll data…');
  } catch (e) {
    err('Background sync failed:', e);
    throw e; // Re-throw so the browser retries
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  let payload = { title: 'Shwari Finance', body: 'You have a new update.' };

  if (event.data) {
    try {
      payload = event.data.json(); // Prefer structured JSON payloads
    } catch {
      payload.body = event.data.text();
    }
  }

  const options = {
    body:    payload.body,
    icon:    'https://cdn-icons-png.flaticon.com/128/1077/1077114.png',
    badge:   'https://cdn-icons-png.flaticon.com/128/1077/1077114.png',
    vibrate: [100, 50, 100],
    tag:     payload.tag || 'shwari-notification', // Deduplicate same-type notifications
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
        // Focus an existing tab if open, otherwise open a new one
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

  // Accept string or object form
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

    default:
      warn('Unknown message type received:', type);
  }
});

// ─────────────────────────────────────────────────────────────────────────────

log('Loaded successfully');
