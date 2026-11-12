/* Platform Operations PWA service worker. Installable-shell caching ONLY — the static
 * HTML/CSS/JS/manifest/icon that makes the app installable and boot offline. NO business
 * data is ever cached: every backend call (/health, /v1/*, /auth/*, /crypto/*, /rpc) is
 * network-only and falls straight through, same principle as the factory PWA's sw.js but
 * simpler (this console has no offline-write workflow to support at all — it's read-mostly
 * platform telemetry, not factory operations). */
const CACHE = 'platform-shell-v28'; // v28: FAVICON-FLUKE the favicon and app icons are the Shell Fluke on a Kon Navy tile (nine precached icon files, index.html). v27: BRAND-8 the RAC lockup in every header and the welcome. v26: FONT-RP-1 Manrope + JetBrains Mono only (fonts/type.css). v25: STOCK2-5 focus exit in the page flow on a phone (focus.js). v23: WALK2-RP-34/35 cannot-connect words, en-IN dates (platform.js, ruh.js). v22: WALK2-RP-16 fields keep the 44px touch floor (platform.css). v21: WALK-RP-9..11 who set up a connector by name, message types as words, table words whole (platform.js, platform.css). v20: SWEEP2-R1 idempotency key on every write reaches installed consoles (platform.js). v19: SWEEP2-O6 one press, one write. // v18: SWEEP held-back updates say when the list is capped. v17: plain wording, Ruh's name, replay and discard held-back updates. v16: readable addresses (#/sign-in-history …), plain screen words, help lines. v15: ruh.js (always-on Ruh: badge, panel, urgent pop-up, RuhConfirm). v14: dock.js (compact quick-access dock, distinct section glyphs). v13: ALEMBIC bridge health + pick-to-light connector screens. v12: focus.js (focus mode + app-window offer). v11: UX-H Aria answers via /v1/aria (v10: reference shell, UX-D welcome/logo/icons, UX-E Aria panel, UX-F sound)
const SHELL = [
  '/', '/index.html', '/sound.js', '/rac-console.css', '/aria-panel.css', '/aria-panel.js', '/platform.css', '/alembic-tokens.css', '/platform.js', '/dock.js', '/ruh.js', '/focus.js', '/manifest.webmanifest',
  // UX-D: the RAW welcome and the logo. FAVICON-FLUKE: the icon family (tools/brand/favicon-fluke.py).
  '/rac-preload.js', '/logo/brand.css',
  '/logo/rac-icon-shell-fluke-ink.png', '/logo/rac-icon-shell-fluke-white.png', '/logo/rac-wordmark-ink.png', '/logo/rac-wordmark-white.png', '/logo/rac-lockup-shell-fluke-ink.png',
  '/favicon.ico', '/favicon-16.png', '/favicon-32.png', '/favicon-48.png', '/apple-touch-icon.png',
  '/icon-192.png', '/icon-512.png', '/icon-maskable-192.png', '/icon-maskable-512.png',
  // Vendored fonts (no longer fetched from fonts.googleapis.com/fonts.gstatic.com — see index.html).
  '/fonts/type.css', '/fonts/manrope-latin.woff2', '/fonts/manrope-latin-ext.woff2', '/fonts/jetbrains-mono-latin.woff2',
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
