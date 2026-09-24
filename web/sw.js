/* RAW AROMA portal — offline-first service worker.
 * The app shell (index.html) is fully self-contained (CSS, JS, fonts inlined), so caching the
 * navigation document gives complete offline rendering. Strategy:
 *   - navigations  → cache-first, fall back to network, then to the cached shell (offline).
 *   - same-origin static (manifest/icons) → stale-while-revalidate.
 *   - API calls (the backend origin) → network-only (never cached; data stays live + per-session).
 */
const CACHE = 'ra-shell-v88'; // v88: reference shell (rac-console.css) + UX-D welcome, logo and icons
const SHELL = [
  '/', '/index.html', '/shell.js', '/ws-supply.js', '/ws-mfg.js', '/ws-platform.js',
  '/qrcode.js', '/manifest.webmanifest',
  // UX-D: the RAW welcome, the logo and the one icon set (ALEMBIC release/ui/BRAND_ASSETS.md).
  '/rac-preload.js', '/logo/brand.css',
  '/logo/raw-logo.png', '/logo/raw-logo@2x.png', '/logo/raw-logo@3x.png',
  '/logo/raw-logo-ondark.png', '/logo/raw-logo-ondark@2x.png', '/logo/raw-logo-ondark@3x.png',
  '/favicon.ico', '/favicon-16.png', '/favicon-32.png', '/favicon-48.png', '/apple-touch-icon.png',
  '/icon-192.png', '/icon-512.png', '/icon-maskable-192.png', '/icon-maskable-512.png',
  // ALEMBIC visual contract (ui-contract/) — vendored tokens/fonts/shell CSS. Bumped past the old
  // /fonts/*.woff2 (Urbanist) precache entries, which index.html no longer references.
  '/ui-contract/rac-console.css', '/ui-contract/alembic-tokens.css', '/ui-contract/shell.css',
  '/ui-contract/fonts/outfit.css', '/ui-contract/fonts/jetbrains-mono.css',
  '/ui-contract/fonts/outfit-300-latin.woff2', '/ui-contract/fonts/outfit-300-latin-ext.woff2',
  '/ui-contract/fonts/outfit-400-latin.woff2', '/ui-contract/fonts/outfit-400-latin-ext.woff2',
  '/ui-contract/fonts/outfit-500-latin.woff2', '/ui-contract/fonts/outfit-500-latin-ext.woff2',
  '/ui-contract/fonts/jetbrains-mono-400-latin.woff2', '/ui-contract/fonts/jetbrains-mono-400-latin-ext.woff2',
  '/ui-contract/fonts/jetbrains-mono-500-latin.woff2', '/ui-contract/fonts/jetbrains-mono-500-latin-ext.woff2',
  '/ui-contract/fonts/jetbrains-mono-600-latin.woff2', '/ui-contract/fonts/jetbrains-mono-600-latin-ext.woff2',
  '/ui-contract/fonts/cabinet-grotesk-variable.woff2',
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

  // shell.js + ws-*.js — NETWORK-FIRST (it IS the application; must be fresh), cache fallback offline.
  if (url.origin === self.location.origin && /^\/(shell|ws-supply|ws-mfg|ws-platform)\.js$/.test(url.pathname)) {
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
