/* RAW AROMA portal — offline-first service worker.
 * The app shell (index.html) is fully self-contained (CSS, JS, fonts inlined), so caching the
 * navigation document gives complete offline rendering. Strategy:
 *   - navigations  → cache-first, fall back to network, then to the cached shell (offline).
 *   - same-origin static (manifest/icons) → stale-while-revalidate.
 *   - API calls (the backend origin) → network-only (never cached; data stays live + per-session).
 */
const CACHE = 'ra-shell-v67';
const SHELL = [
  '/', '/index.html', '/app.js', '/qrcode.js', '/manifest.webmanifest', '/icon.svg',
  '/fonts/adf5f325-e87d-4401-84a9-246e380c6864.woff2',
  '/fonts/9b9b854c-5b1b-4e4a-88a5-0d3eec462f94.woff2',
  '/fonts/ad1f26c5-34be-47f9-98b1-c73b902006f7.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // Best-effort per URL so one failing cross-origin (CDN) fetch doesn't abort the whole install.
      Promise.all(SHELL.map((u) => c.add(u).catch(() => null))),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API (backend) — never cache; let it fail offline (the app handles it).
  if (url.port === '3000' || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/auth/')) {
    return; // default network handling
  }

  // Navigations → NETWORK-FIRST so a fresh deploy is picked up on the next reload; fall back to
  // the cached shell only when offline. (Was cache-first, which stranded users on an old shell
  // until the SW quietly updated — the recurring "I don't see the new module" problem.)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  // app.js — NETWORK-FIRST (it IS the application; must be fresh), cache fallback for offline.
  if (url.origin === self.location.origin && url.pathname === '/app.js') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  // CDN (unpkg) — cache-first so the app renders offline.
  if (url.hostname === 'unpkg.com') {
    e.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => cached)),
    );
    return;
  }

  // Other same-origin GETs → stale-while-revalidate.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((cached) => {
        const net = fetch(req).then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }).catch(() => cached);
        return cached || net;
      }),
    );
  }
});
