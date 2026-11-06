/* RAW AROMA portal — offline-first service worker.
 * The app shell (index.html) is fully self-contained (CSS, JS, fonts inlined), so caching the
 * navigation document gives complete offline rendering. Strategy:
 *   - navigations  → cache-first, fall back to network, then to the cached shell (offline).
 *   - same-origin static (manifest/icons) → stale-while-revalidate.
 *   - API calls (the backend origin) → network-only (never cached; data stays live + per-session).
 */
const CACHE = 'ra-shell-v115'; // v115: WALK2-RP-2..20 floor screens, labels, TV board, pairing board, kiosk sizes, lot and run pickers, field touch floor (shell.js, shell.css, ws-floor.js, ws-floorb.js, ws-floor-ops.js, pair.html, pair.js), on top of qc-gate v114. v114: PROD-D lane pf-d ws-floord.js (Stock cover, QC review) precached, and the floor queue's late prediction and planned list (ws-floor.js). v113: PROD-REL2 merge of lane pf-c onto pf-a+pf-b (ws-floor.js, ws-floorb.js, ws-floor-ops.js, label-render.js, pair.html/pair.js all precached). v111 (pf-c): PROD-C-10 success toasts in ws-floor-ops.js. v110 (pf-c): ws-floor-ops.js, label-render.js, weight.js, pair.html/pair.js. v112: PROD-REL merge of lanes pf-a and pf-b (ws-floor.js + ws-floorb.js both precached). v111 (pf-a): PROD-A-7 phone drawer closes on the open screen (shell.js), tolerance window rounds down (weight.js). v111 (pf-b): PROD-B-11 in-page reason sheets, product pickers QC can read, scrolling tables (ws-floorb.js). v110 (pf-b): PROD-B ws-floorb.js + weight.js (receiving audit, payments, QC checkpoints, batch QC, lot recall). v110 (pf-a): PROD-A-7 floor kiosks, Rules, Floor colours (ws-floor.js, weight.js). v109: WALK-RP-21 Go, Move and Add rack submit (ws-produce.js). v108: WALK-RP-20 stage names keep whole words (shell.js). v107: WALK-RP-12..17 line items, QC certificate results, pick list lines, role list, COA spec and /me failures read every page and say a failure (shell.js, ws-produce.js, ws-platform.js, ws-mfg.js). v106: WALK-RP My work says a failed feed, document form pickers read every page, codes no longer break mid-word, and SWEEP2-O6/O7/R1 (one write per press, status words, idempotency key) reach installed consoles (shell.js). v105: SWEEP2 rail drops screens the role cannot read, and SWEEP-FACTORY-8 produce counters (shell.js, ws-produce.js). v104: SWEEP lists read every page, say when capped, and show failures (shell.js, ws-mfg.js, ws-produce.js, ws-formula-setup.js). v103: material issue, CAPA and fill screens, one organizations table. v102: Open Vault only for an ALEMBIC admin. v101: Owner rail (procurement, receiving, test queue), plain wording, Ruh's name, Open Vault. v100: doc-format.js (house print layout for Documents). v99: tutorial.js (Training videos card linking to ALEMBIC Tutorial -> Videos). v98: routes.js + screen-guide.js (readable addresses, plain screen names, help lines). v97: ruh.js (always-on Ruh: badge, panel, urgent pop-up, RuhConfirm). v96: merge ws-setup.js (v95 catalogue lane: Factory setup checklist, Ruh's drafts, one-person approval) + ws-formula-setup.js (v95 vaultsetup lane: Ruh grant, formula shells, product -> formula link). v94: dock.js (compact quick-access dock, distinct section glyphs). v93: ws-produce.js (Produce next, shelves, labels, live produce alerts). v92: merge focus.js (v91 focus) + batch COA/QC spec screens (v91 compliance). v90: UX-H Aria answers via /v1/aria
const SHELL = [
  '/', '/index.html', '/sound.js', '/dock.js', '/ruh.js', '/routes.js', '/screen-guide.js', '/shell.js', '/ws-supply.js', '/ws-mfg.js', '/ws-platform.js', '/ws-produce.js', '/ws-setup.js', '/ws-formula-setup.js', '/weight.js', '/ws-floor.js', '/ws-floorb.js', '/label-render.js', '/ws-floor-ops.js', '/ws-floord.js', '/pair.html', '/pair.js', '/doc-format.js',
  '/qrcode.js', '/focus.js', '/manifest.webmanifest', '/ui-contract/aria-panel.js', '/ui-contract/aria-panel.css',
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

/** Backend and tunnel paths: network-only, never cached, never answered from cache, whatever the
 *  method. /rpc and /crypto/ are the encrypted tunnel every console call travels through; /main/ is
 *  the Vault host's channel to the main API (not served here today, excluded all the same). */
function isNetworkOnly(url) {
  const p = url.pathname;
  return url.origin !== self.location.origin && url.hostname !== 'unpkg.com'
    || url.port === '3000'
    || p === '/rpc' || p.startsWith('/rpc/') || p.startsWith('/main/') || p === '/main'
    || p.startsWith('/crypto/') || p.startsWith('/v1/') || p.startsWith('/auth/') || p === '/health'
    || p === '/console-config.js';
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // API (backend) and tunnel — never cache; let it fail offline (the app handles it).
  if (isNetworkOnly(url)) return; // default network handling
  if (req.method !== 'GET') return;

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
