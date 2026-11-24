/* Office Snacks Tracker service worker.
 * Caches ONLY the static app shell (same-origin GET requests). Supabase/API traffic is cross-origin and is never
 * intercepted, so authenticated or user-specific data is never stored by this worker.
 * __BUILD_ID__ and the precache list are filled in at build time (vite.config.js). */
const BUILD_ID = '__BUILD_ID__';
const PRECACHE = /*__PRECACHE__*/[];
const SHELL_CACHE = `snacks-shell-${BUILD_ID}`;
const RUNTIME_CACHE = `snacks-runtime-${BUILD_ID}`;
const PREFIX = 'snacks-';
const scopeUrl = new URL(self.registration.scope);
const abs = (p) => new URL(p, scopeUrl).href;
const INDEX = abs('index.html'), OFFLINE = abs('offline.html');

self.addEventListener('install', (event) => {
  // No skipWaiting here: the page decides when to activate an update, so an open form is never swapped under the user.
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE.map((p) => new Request(abs(p), { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, RUNTIME_CACHE]);
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && !keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => { if (event.data?.type === 'SKIP_WAITING') self.skipWaiting(); });

const isCacheable = (res) => res && res.ok && res.type === 'basic' && !/no-store/i.test(res.headers.get('Cache-Control') || '');

async function networkFirstNavigation(request) {
  try {
    const res = await fetch(request);
    if (isCacheable(res)) (await caches.open(SHELL_CACHE)).put(INDEX, res.clone());
    return res;
  } catch {
    return (await caches.match(INDEX)) || (await caches.match(OFFLINE)) || Response.error();
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (isCacheable(res)) (await caches.open(RUNTIME_CACHE)).put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = (await cache.match(request)) || (await caches.match(request));
  const refresh = fetch(request).then((res) => { if (isCacheable(res)) cache.put(request, res.clone()); return res; }).catch(() => null);
  return hit || (await refresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;            // Supabase, CDNs, etc.: never touched
  if (url.pathname.startsWith(scopeUrl.pathname + 'api/')) return;
  if (request.mode === 'navigate') return event.respondWith(networkFirstNavigation(request));
  if (url.pathname.includes('/assets/')) return event.respondWith(cacheFirst(request)); // content-hashed filenames
  if (url.pathname.endsWith('sw.js')) return;
  event.respondWith(staleWhileRevalidate(request));          // icons, manifest, offline page
});
