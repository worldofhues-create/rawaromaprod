/* RAW AROMA portal — offline-first service worker.
 * The app shell (index.html) is fully self-contained (CSS, JS, fonts inlined), so caching the
 * navigation document gives complete offline rendering. Strategy:
 *   - navigations  → cache-first, fall back to network, then to the cached shell (offline).
 *   - same-origin static (manifest/icons) → stale-while-revalidate.
 *   - API calls (the backend origin) → network-only (never cached; data stays live + per-session).
 */
const CACHE = 'ra-shell-v144'; // v144: release stage 2 (release/stage-2-rp), one number above every lane merged into it: stock-e2e-2-rp v142, ship-rp v139, imports-rp v143, promises-rp v139-v141. v143 (lane imports-rp): IMPORT-RP import-panel.js + ws-imports.js ("Import from a sheet" on Materials, Suppliers, Goods receipt, Batches, Adjustments, Packaging BOM; record a purchase price), precached. v142 (lane stock-e2e-rp; promises-rp holds v139-v141): STOCK-FIX-RP STK-27 the verify station asks for a second person's sign-off on a typed weight (ws-floor.js). v139: FAVICON-FLUKE the favicon and app icons are the Shell Fluke on a Kon Navy tile (nine precached icon files, index.html, pair.html). v138: FLOOR-QC-IN-1-LEGACY "Released before the sample rule" badge on Scan a lot and the QC Test queue (ws-floor.js, shell.js). v137: FLOOR-LOT-STOP-1 line-stopped screen, FLOOR-TEMP-1 Temperatures screen, FLOOR-QC-IN-1 hold and QC state on Scan a lot (ws-floor.js, shell.js thermo glyph). v136: BRAND-8 the RAC lockup (icon + wordmark images) in every header and the welcome. v135: BRAND-6 the RAC marks from the brand handoff on the pack wrap (brand-marks.js, fetched with the first wrap, not precached), Sand stock, tagline without a comma. v134: SHELL-FLUKE pack wrap (shell-fluke.js precached; label-render.js draws colour, shapes and JetBrains Mono in PDFs). v133: merge of lane fonts-rp (v131 FONT-RP-4/5 label text sized so lines never collide, label PDFs embed Manrope; label-pdf-font.js NOT precached) with lane rac-codes-rp. v132: RAC-CODES-RP-3 QC spec line named by RAC product code (ws-floorb.js, rac-code.js). v131: RAC-CODES-RP-2 rac-code.js (RAC code + grade on floor, produce, QC pickers). v130: RAC-CODES-RP-1 labels in Manrope, RAC codes in JetBrains Mono (label-render.js). v129: FLOOR-FIX-16 in-page typed-weight and pairing questions (ws-floor-ops.js). v128: FLOOR-FIX-16 scale-serial.js (kiosk Web Serial scale), typed weights signed by a second person (ws-floor-ops.js). v126: STOCK2 held readings and stock alerts on the floor, card padding on every plain card (shell.css), focus exit. v124: LEFTOVER-AFTER-FINISH return from Scan a lot (ws-floor.js). v123: PROD-REL5 merge of lane floor-gaps (v122) onto qc-gate v120 + PROD-REL4-1. v122: FLOOR-5 child label layout, Scan a lot wraps at 375, FG zones glyph (ws-floor.js, ws-produce.js, screen-guide.js). v121: FLOOR-1..3 lot split and leftover return with child-lot labels and genealogy, FG zones with colour name and initials, FG rack on the TV board, bin-label sheet logged with REPRINT (ws-floor.js, ws-produce.js, ws-floor-ops.js, shell.js, routes.js, screen-guide.js). v120: SCAN-14 row-button help (screen-guide.js). v119: SCAN-8..13 kiosk one-column at 1024+, Print/Reprint at every flow step, scan-to-pick at receiving and Batch QC, MIXED reprint by scan, multi-field wedge advance (ws-floor.js, ws-floorb.js, ws-floor-ops.js, shell.js, scan-input.js). v118: SCAN-6 label codes keep the sales order's case (label-render.js). v117: SCAN-1..n both codes on every label, the shared scan field with camera scanning (label-render.js, scan-input.js new, ws-floor.js, ws-floorb.js, ws-floor-ops.js, ws-produce.js, index.html). v116: WALK2-RP-23..35 progressive pickers, row-action size, stock-cover and print-queue words, offline freeze, unreachable-server failures, acronyms, en-IN dates (shell.js, shell.css, screen-guide.js, ruh.js, ws-floor*.js, ws-produce.js, ws-setup.js). v115: WALK2-RP-2..20 floor screens, labels, TV board, pairing board, kiosk sizes, lot and run pickers, field touch floor (shell.js, shell.css, ws-floor.js, ws-floorb.js, ws-floor-ops.js, pair.html, pair.js), on top of qc-gate v114. v114: PROD-D lane pf-d ws-floord.js (Stock cover, QC review) precached, and the floor queue's late prediction and planned list (ws-floor.js). v113: PROD-REL2 merge of lane pf-c onto pf-a+pf-b (ws-floor.js, ws-floorb.js, ws-floor-ops.js, label-render.js, pair.html/pair.js all precached). v111 (pf-c): PROD-C-10 success toasts in ws-floor-ops.js. v110 (pf-c): ws-floor-ops.js, label-render.js, weight.js, pair.html/pair.js. v112: PROD-REL merge of lanes pf-a and pf-b (ws-floor.js + ws-floorb.js both precached). v111 (pf-a): PROD-A-7 phone drawer closes on the open screen (shell.js), tolerance window rounds down (weight.js). v111 (pf-b): PROD-B-11 in-page reason sheets, product pickers QC can read, scrolling tables (ws-floorb.js). v110 (pf-b): PROD-B ws-floorb.js + weight.js (receiving audit, payments, QC checkpoints, batch QC, lot recall). v110 (pf-a): PROD-A-7 floor kiosks, Rules, Floor colours (ws-floor.js, weight.js). v109: WALK-RP-21 Go, Move and Add rack submit (ws-produce.js). v108: WALK-RP-20 stage names keep whole words (shell.js). v107: WALK-RP-12..17 line items, QC certificate results, pick list lines, role list, COA spec and /me failures read every page and say a failure (shell.js, ws-produce.js, ws-platform.js, ws-mfg.js). v106: WALK-RP My work says a failed feed, document form pickers read every page, codes no longer break mid-word, and SWEEP2-O6/O7/R1 (one write per press, status words, idempotency key) reach installed consoles (shell.js). v105: SWEEP2 rail drops screens the role cannot read, and SWEEP-FACTORY-8 produce counters (shell.js, ws-produce.js). v104: SWEEP lists read every page, say when capped, and show failures (shell.js, ws-mfg.js, ws-produce.js, ws-formula-setup.js). v103: material issue, CAPA and fill screens, one organizations table. v102: Open Vault only for an ALEMBIC admin. v101: Owner rail (procurement, receiving, test queue), plain wording, Ruh's name, Open Vault. v100: doc-format.js (house print layout for Documents). v99: tutorial.js (Training videos card linking to ALEMBIC Tutorial -> Videos). v98: routes.js + screen-guide.js (readable addresses, plain screen names, help lines). v97: ruh.js (always-on Ruh: badge, panel, urgent pop-up, RuhConfirm). v96: merge ws-setup.js (v95 catalogue lane: Factory setup checklist, Ruh's drafts, one-person approval) + ws-formula-setup.js (v95 vaultsetup lane: Ruh grant, formula shells, product -> formula link). v94: dock.js (compact quick-access dock, distinct section glyphs). v93: ws-produce.js (Produce next, shelves, labels, live produce alerts). v92: merge focus.js (v91 focus) + batch COA/QC spec screens (v91 compliance). v90: UX-H Aria answers via /v1/aria
const SHELL = [
  '/', '/index.html', '/sound.js', '/dock.js', '/ruh.js', '/routes.js', '/screen-guide.js', '/shell.js', '/ws-supply.js', '/ws-mfg.js', '/ws-platform.js', '/ws-produce.js', '/ws-setup.js', '/ws-formula-setup.js', '/weight.js', '/ws-floor.js', '/ws-floorb.js', '/label-render.js', '/shell-fluke.js', '/rac-code.js', '/scan-input.js', '/scale-serial.js', '/ws-floor-ops.js', '/ws-floord.js', '/pair.html', '/pair.js', '/doc-format.js', '/import-panel.js', '/ws-imports.js',
  '/qrcode.js', '/focus.js', '/manifest.webmanifest', '/ui-contract/aria-panel.js', '/ui-contract/aria-panel.css',
  // UX-D: the RAW welcome and the logo. FAVICON-FLUKE: the icon family (tools/brand/favicon-fluke.py).
  '/rac-preload.js', '/logo/brand.css',
  '/logo/rac-icon-shell-fluke-ink.png', '/logo/rac-icon-shell-fluke-white.png', '/logo/rac-wordmark-ink.png', '/logo/rac-wordmark-white.png', '/logo/rac-lockup-shell-fluke-ink.png',
  '/favicon.ico', '/favicon-16.png', '/favicon-32.png', '/favicon-48.png', '/apple-touch-icon.png',
  '/icon-192.png', '/icon-512.png', '/icon-maskable-192.png', '/icon-maskable-512.png',
  // ALEMBIC visual contract (ui-contract/) — vendored tokens/fonts/shell CSS. Bumped past the old
  // /fonts/*.woff2 (Urbanist) precache entries, which index.html no longer references.
  '/ui-contract/rac-console.css', '/ui-contract/alembic-tokens.css', '/ui-contract/shell.css',
  '/ui-contract/fonts/type.css', '/ui-contract/fonts/manrope-latin.woff2', '/ui-contract/fonts/manrope-latin-ext.woff2', '/ui-contract/fonts/jetbrains-mono-latin.woff2',
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
