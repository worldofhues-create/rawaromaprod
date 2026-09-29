/* Platform Operations PWA service worker. Installable-shell caching ONLY — the static
 * HTML/CSS/JS/manifest/icon that makes the app installable and boot offline. NO business
 * data is ever cached: every backend call (/health, /v1/*, /auth/*, /crypto/*, /rpc) is
 * network-only and falls straight through, same principle as the factory PWA's sw.js but
 * simpler (this console has no offline-write workflow to support at all — it's read-mostly
 * platform telemetry, not factory operations). */
const CACHE = 'platform-shell-v14'; // v14: dock.js (compact quick-access dock, distinct section glyphs). v13: ALEMBIC bridge health + pick-to-light connector screens. v12: focus.js (focus mode + app-window offer). v11: UX-H Aria answers via /v1/aria (v10: reference shell, UX-D welcome/logo/icons, UX-E Aria panel, UX-F sound)
const SHELL = [
  '/', '/index.html', '/sound.js', '/rac-console.css', '/aria-panel.css', '/aria-panel.js', '/platform.css', '/alembic-tokens.css', '/platform.js', '/dock.js', '/focus.js', '/manifest.webmanifest',
  // UX-D: the RAW welcome, the logo and the one icon set (ALEMBIC release/ui/BRAND_ASSETS.md).
  '/rac-preload.js', '/logo/brand.css',
  '/logo/raw-logo.png', '/logo/raw-logo@2x.png', '/logo/raw-logo@3x.png',
  '/logo/raw-logo-ondark.png', '/logo/raw-logo-ondark@2x.png', '/logo/raw-logo-ondark@3x.png',
  '/favicon.ico', '/favicon-16.png', '/favicon-32.png', '/favicon-48.png', '/apple-touch-icon.png',
  '/icon-192.png', '/icon-512.png', '/icon-maskable-192.png', '/icon-maskable-512.png',
  // Vendored fonts (no longer fetched from fonts.googleapis.com/fonts.gstatic.com — see index.html).
  '/fonts/outfit.css', '/fonts/jetbrains-mono.css',
  '/fonts/outfit-300-latin.woff2', '/fonts/outfit-300-latin-ext.woff2',
  '/fonts/outfit-400-latin.woff2', '/fonts/outfit-400-latin-ext.woff2',
  '/fonts/outfit-500-latin.woff2', '/fonts/outfit-500-latin-ext.woff2',
  '/fonts/jetbrains-mono-400-latin.woff2', '/fonts/jetbrains-mono-400-latin-ext.woff2',
  '/fonts/jetbrains-mono-500-latin.woff2', '/fonts/jetbrains-mono-500-latin-ext.woff2',
  '/fonts/cabinet-grotesk-variable.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Backend calls: network-only, never cached, never intercepted beyond pass-through.
  // /rpc and /crypto/ are the encrypted tunnel; /main/ is the Vault host's channel to the main API
  // (not served here, excluded all the same); console-config.js is per-deployment config.
  const p = url.pathname;
  if (url.origin !== self.location.origin || p === '/health' || p.startsWith('/v1/') || p.startsWith('/auth/')
    || p.startsWith('/crypto/') || p === '/rpc' || p.startsWith('/rpc/') || p === '/main' || p.startsWith('/main/')
    || p === '/console-config.js') {
    return; // let it hit the network untouched
  }

  if (req.method !== 'GET') return;

  // App shell: network-first (so a redeploy is picked up promptly), cache fallback for the
  // installable/offline-boot case. Never cache-first — a stale shell must not trap a user.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html'))),
  );
});
