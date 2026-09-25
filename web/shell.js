/* RAW AROMA — DB-driven portal (clean rebuild reusing the exact design tokens).
 * Source of truth = the backend/DB. Every table shows exactly what its endpoint returns, masked
 * per the signed-in role. Transport is the encrypted tunnel (only /crypto/handshake + /rpc on the
 * wire). Role comes from the DB (the JWT), never self-picked. Responsive on every device. */
'use strict';
  // Backend base: same-origin '' always, unless overridden with window.RA_API. Every deployed
  // vhost (infra/aws/nginx/rawprod-main.conf) AND the local stand-in for it
  // (ops/ui-parity/static-proxy.mjs) reverse-proxy /crypto,/rpc,/v1,/auth,/health on this SAME
  // origin, so a relative fetch is correct in both. A stale localhost-only guess here used to
  // replace the port with :3000 (a leftover Vercel+Render-era assumption — that infra is gone),
  // which on this codebase's actual current local stand-up hits nothing this app owns and reads
  // back as "Could not reach the backend." A raw `npm run dev` backend on a different port from
  // the static files (no reverse proxy at all) needs `window.RA_API` set explicitly.
  var API = (typeof window.RA_API === 'string') ? window.RA_API : '';
  // PB-04 / SB-02: where "Sign in via ALEMBIC" sends the browser — ALEMBIC's own console,
  // which mints a short-lived signed assertion and returns here with it in the URL FRAGMENT
  // (never a query string a server would log) at `#assertion=<token>`. Same deploy-time
  // override convention as window.RA_API; unset renders an honest "not configured" notice
  // rather than a guessed URL.
  var ALEMBIC_CONSOLE_URL = (typeof window.ALEMBIC_CONSOLE_URL === 'string') ? window.ALEMBIC_CONSOLE_URL : '';

  /* ---------------- encrypted tunnel (ECDH P-256 → AES-256-GCM, single /rpc) ---------------- */
  var AES = null, KID = null, hsP = null, session = null;
  var te = function (s) { return new TextEncoder().encode(s); };
  function b64(b) { var s = '', C = 0x8000; for (var i = 0; i < b.length; i += C) s += String.fromCharCode.apply(null, b.subarray(i, i + C)); return btoa(s); }
  function ub64(s) { var bin = atob(s), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  function handshake() {
    if (AES) return Promise.resolve(); if (hsP) return hsP;
    hsP = (async function () {
      var kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      var pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      var hs = (await (await fetch(API + '/crypto/handshake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientPub: b64(pub) }) })).json()).data;
      var sk = await crypto.subtle.importKey('raw', ub64(hs.serverPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      var shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: sk }, kp.privateKey, 256);
      var hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
      var bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te('ra-session-v1') }, hk, 256);
      AES = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); KID = hs.keyId;
    })();
    return hsP;
  }
  async function seal(s) { var iv = crypto.getRandomValues(new Uint8Array(12)); var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, AES, te(s))); var o = new Uint8Array(12 + ct.length); o.set(iv, 0); o.set(ct, 12); return b64(o); }
  // Renamed from the original closure-local `open` (AES-GCM decrypt) to `openCipher`: the former
  // app.js wrapped this whole module in an IIFE, so a top-level `function open(){}` there safely
  // shadowed `window.open` only inside that closure. Now that the module is split across plain
  // <script> files sharing the global scope (no IIFE), a global `open` would instead OVERWRITE
  // `window.open` for the whole page — breaking the native popup opener that printDoc/printQrLabel
  // call via `window.open(...)`. Renaming avoids that collision; behavior is unchanged otherwise.
  async function openCipher(bl) { var b = ub64(bl); var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, AES, b.slice(12)); return new TextDecoder().decode(pt); }
  async function tunnel(path, opts, _retried, _ch) {
    opts = opts || {}; await handshake();
    var p = { method: (opts.method || 'GET').toUpperCase(), path: path };
    if (opts.body !== undefined) p.body = opts.body;
    if (session) p.token = session.token;
    // Transient-failure resilience (SYS-01): a dropped fetch, a cold-start 502, or a reset
    // handshake all surface as a missing encrypted envelope. Rather than bubble "could not reach
    // the secure channel" to the user on the first blip, reset the crypto state and retry with a
    // short backoff (up to 3 attempts) — re-running the ECDH handshake each time.
    _ch = _ch || 0;
    var outer;
    try {
      var r = await fetch(API + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ra-key': KID }, body: JSON.stringify({ enc: await seal(JSON.stringify(p)) }) });
      outer = await r.json();
    } catch (netErr) {
      if (_ch < 2) { AES = null; hsP = null; await new Promise(function (rs) { setTimeout(rs, 350 + _ch * 400); }); return tunnel(path, opts, _retried, _ch + 1); }
      throw new Error('channel');
    }
    if (!outer || !outer.data || !outer.data.enc) {
      AES = null; hsP = null;
      if (_ch < 2) { await new Promise(function (rs) { setTimeout(rs, 350 + _ch * 400); }); return tunnel(path, opts, _retried, _ch + 1); }
      throw new Error('channel');
    }
    var inner = JSON.parse(await openCipher(outer.data.enc));
    // Access token expired mid-session (15-min TTL) → silently refresh once and retry, so the user isn't bounced.
    if (inner.status === 401 && !_retried && path !== '/auth/refresh' && path !== '/auth/login' && path !== '/auth/alembic-assertion') {
      var rt = null; try { rt = localStorage.getItem('ra_rt'); } catch (e) {}
      if (rt) {
        var rr = await tunnel('/auth/refresh', { method: 'POST', body: { refreshToken: rt } }, true);
        var d = rr.json && rr.json.data;
        if (rr.status < 400 && d && d.accessToken) {
          if (session) session.token = d.accessToken;
          try { if (d.refreshToken) localStorage.setItem('ra_rt', d.refreshToken); } catch (e) {}
          return tunnel(path, opts, true);
        }
      }
    }
    return { status: inner.status, json: inner.body ? JSON.parse(inner.body) : null };
  }
  // Tiny registration API for the ws-*.js workspace modules (scaffolding for future lanes —
  // U2/U3/U4 restyling Procurement/Receiving/Warehouse, QC/Production/Packaging/Dispatch, and
  // Platform/Vault respectively). Not wired into the render path yet: today's view dispatch is
  // still the generic endpoint-driven engine below (ROLES/COLS/ACTIONS/CREATE + loadView), so
  // registering here is inert and changes no behaviour. It exists so those lanes have a single,
  // non-colliding place to declare per-workspace view renderers as they build them.
  var RA_VIEWS = {};
  function registerViews(map) { Object.keys(map || {}).forEach(function (k) { RA_VIEWS[k] = map[k]; }); }
  window.RA = { tunnel: tunnel, registerViews: registerViews, views: RA_VIEWS };

  /* ---------------- design system ----------------
   * RawProd previously offered a neumorphic/glass/skeuomorphic "skin" picker plus a light/dark
   * toggle (skinTokens(), below, generated ~120 lines of hardcoded hex/rgba gradients per
   * combination). That directly contradicted P0_UI_PARITY_PUBLIC_GREEN_ADDENDUM.md §1 ("There is
   * ONE Raw Aroma Chem product design language… Do not invent a new RAWPROD visual style"), so it
   * is removed. The legacy custom-property names it used to populate at runtime (--surface, --well,
   * --t1/2/3, --border, --cbord, --wbord, --rai, --rai-sm, --track, --barmute, --cblur) are still
   * referenced throughout this file and the ws-*.js modules' many modal/table/dashboard renderers;
   * rather than hand-edit every call site in one pass, web/ui-contract/shell.css now shims each of
   * those old names to its ALEMBIC-token equivalent (e.g. --surface → var(--panel), --rai → none —
   * ALEMBIC's admin/agent cards are flat by design, per ALEMBIC_VISUAL_CONTRACT.json shadows.
   * admin_card_shadow), so every existing var(--surface)/var(--well)/… reference already renders in
   * the ALEMBIC palette with zero JS changes required at those call sites. ALEMBIC's contract
   * defines one fixed palette (no dark-mode tokens), so dark mode is retired along with the skins. */

  var ICONS = { grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z', layers: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5', lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4', users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75', shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', clipboard: 'M9 4h6v3H9zM8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2', sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6', truck: 'M1 4h13v11H1zM14 8h4l3 3v4h-7zM6 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0M21 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0', box: 'M21 8 12 3 3 8v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8', flask: 'M9 3h6M10 3v6L5 19a1 1 0 0 0 1 1.5h12A1 1 0 0 0 19 19l-5-10V3M7.5 14h9', beaker: 'M6 3h12M8 3v7l-3 8a1 1 0 0 0 1 1.3h12A1 1 0 0 0 19 18l-3-8V3', droplet: 'M12 3l5.5 6.5a7 7 0 1 1-11 0z', tag: 'M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7 7h.01', refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', calendar: 'M3 5h18v16H3zM3 9h18M8 3v4M16 3v4', activity: 'M22 12h-4l-3 9L9 3l-3 9H2', bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0', search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3', logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', pkg: 'M16 3 4 7v10l8 4 8-4V7zM4 7l8 4 8-4M12 11v10', building: 'M3 21h18M6 21V4h8v17M14 9h4v12M9 8h.01M9 12h.01M9 16h.01', sun: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z', shelf: 'M3 7h18M3 12h18M3 17h18M7 7v10M17 7v10', mappin: 'M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11zM12 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5', panel: 'M4 4h16v16H4zM10 4v16', alert: 'M12 9v4M12 17h.01M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z' };
  function icon(k, sz) { return '<svg width="' + (sz || 18) + '" height="' + (sz || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="' + (ICONS[k] || ICONS.grid) + '"/></svg>'; }

  // Status → .chip tone variant (COMPONENT_PARITY_MATRIX.json "Chip": n/b/g/a/r/p/k, admin.css:
  // 119-126). Token-only — no hardcoded hex; fmt() below maps this to a "chip <tone>" class.
  // MFG-lifecycle additions (U3): HOLD/REJECT/REWORK/etc. surfaced by QC disposition, oil-batch
  // transitions, and dispatch/filling/production-plan lifecycles (§9/§10 of the addendum — a HOLD
  // or REJECT must read as a warning/danger chip, never fall through to the neutral default).
  // Values match the exact enum strings the backend writes (verified against
  // cluster-quality/production/packaging/sales service.ts sources, not guessed): qc_inspections
  // disposition PENDING/ACCEPT/REJECT/REWORK/HOLD; production_order PLANNING/INPROGRESS/HOLD/
  // COMPLETED; secure_mixing_session IN_PROGRESS/COMPLETED/ABORTED; oil_batch_master ACTIVE/
  // PRODUCED/IN_MATURATION/MATURING/HOLD/REWORK/RELEASED/FAILED; filling_session ACTIVE/DONE;
  // package_order DRAFT/MATERIALS_ISSUED/IN_PROGRESS/COMPLETED/CANCELLED; packaging_qc PASS/FAIL/
  // HOLD; dispatch_master ACTIVE/DELIVERED; qc_capa OPEN/IN_PROGRESS/CLOSED/VERIFIED. (No IN_TRANSIT/
  // NDR/RTO/DAMAGED/PARTIAL dispatch states exist in this backend — not added here; a chip for a
  // status the DB never writes would be fake state, which the addendum forbids.)
  var STATUS = { pending: 'a', pass: 'g', fail: 'r', approved: 'g', ordered: 'b', draft: 'n', received: 'g', inprogress: 'b', active: 'g', confirmed: 'g', pending_approval: 'a',
    hold: 'a', accept: 'g', accepted: 'g', reject: 'r', rejected: 'r', rework: 'a', released: 'g', release: 'g', in_maturation: 'b', maturing: 'b', failed: 'r', produced: 'b',
    done: 'g', completed: 'g', delivered: 'g', issued: 'b', cancelled: 'r', archived: 'n', closed: 'n', open: 'b', submitted: 'b', planning: 'n',
    in_progress: 'b', aborted: 'r', materials_issued: 'b', verified: 'g' };

  /* ---------------- role → nav → real endpoints (Phase-1 modules, DB-driven) ---------------- */
  // nav tuple: [key, label, icon, endpoint, masked?]. Aligned to the Phase-1 module per role.
  var ROLES = {
    superadmin: { label: 'Super Admin', dept: 'Controller', user: 'Owner', nav: [
      ['plans', 'Production plans', 'calendar', '/v1/production-plans'], ['planitems', 'Plan items', 'list', '/v1/production-plan-items'],
      ['runs', 'Master runs', 'layers', '/v1/production-orders'],
      ['materials', 'Materials', 'box', '/v1/materials'], ['uom', 'Units', 'sliders', '/v1/uoms'],
      ['mtypes', 'Material types', 'sliders', '/v1/material-types'], ['mcats', 'Categories', 'sliders', '/v1/material-categories'],
      ['msubcats', 'Sub-categories', 'sliders', '/v1/material-subcategories'], ['mgroups', 'Material groups', 'sliders', '/v1/material-groups'],
      ['mqcspec', 'Material QC specs', 'flask', '/v1/material-qc-specifications'], ['mstorage', 'Storage rules', 'box', '/v1/material-storage-rules'],
      ['maliases', 'RM aliases', 'lock', '/v1/rm-aliases'],
      ['splitc', 'Split containers', 'layers', '/v1/batch-container-mappings'],
      ['geotypes', 'Geo levels', 'sliders', '/v1/geo-region-types'], ['georegions', 'Geo regions', 'building', '/v1/geo-regions'],
      ['sorders', 'Sales orders', 'clipboard', '/v1/sales-orders'], ['dispatch', 'Dispatches', 'truck', '/v1/dispatches'], ['ddocs', 'Dispatch docs', 'clipboard', '/v1/dispatch-documents'],
      ['fgstock', 'FG stock (ATP)', 'box', '/v1/fg-stock'],
      ['trace', 'Traceability', 'activity', '/v1/finished-good-batches'], ['notifs', 'Notifications', 'bell', '/v1/notifications'],
      ['docs', 'Documents', 'clipboard', '/v1/document-registry'],
      ['users', 'Users', 'users', '/v1/users'], ['audit', 'Audit log', 'clipboard', '/v1/formula-event-hist'],
      ['wtrail', 'Write audit trail', 'clipboard', '/v1/audit-events'],
      ['bridgereq', 'ALEMBIC requirements', 'link', '/v1/bridge/requirements'],
      ['weigh', 'Weighing', 'sliders', '/v1/weighing-records'], ['labels', 'FG labels', 'tag', '/v1/fg-labels'],
      ['approvals', 'Approval matrix', 'shield', '/v1/approval-matrix'] ] },
    admin: { label: 'Admin', dept: 'Access & Governance', user: 'Admin', nav: [
      ['users', 'Users', 'users', '/v1/users'], ['roles', 'Roles', 'shield', '/v1/roles'],
      ['perms', 'Permissions', 'lock', '/v1/permissions'], ['approvals', 'Approval matrix', 'shield', '/v1/approval-matrix'],
      ['orgs', 'Organizations', 'building', '/v1/organizations'], ['bunits', 'Business units', 'building', '/v1/business-units'],
      ['loctypes', 'Location types', 'sliders', '/v1/location-types'], ['locations', 'Locations', 'building', '/v1/locations'],
      ['materials', 'Materials', 'box', '/v1/materials'], ['units', 'Units', 'sliders', '/v1/uoms'],
      ['contacts', 'Contacts', 'users', '/v1/contacts'], ['countries', 'Countries', 'building', '/v1/countries'],
      ['docs', 'Documents', 'clipboard', '/v1/document-registry'], ['loginhist', 'Login history', 'activity', '/v1/login-history'],
      ['wtrail', 'Write audit trail', 'clipboard', '/v1/audit-events'] ] },
    procurement: { label: 'Procurement', dept: 'Procurement', user: 'Procurement', nav: [
      ['planning', 'Stock planning', 'grid', '/v1/stock-requirements'], ['reorder', 'Reorder plan', 'activity', '/v1/reorder-suggestions'], ['prs', 'Purchase requests', 'list', '/v1/purchase-requests'],
      ['rfq', 'RFQs', 'list', '/v1/rfqs'], ['quotes', 'Quotations', 'calendar', '/v1/quotations'],
      ['qitems', 'Quotation items', 'list', '/v1/quotation-items'], ['negotiate', 'Negotiation', 'activity', '/v1/vendor-negotiations'],
      ['pos', 'Purchase orders', 'clipboard', '/v1/purchase-orders'], ['advpay', 'Advance payments', 'clipboard', '/v1/po-advance-payments'],
      ['vendors', 'Suppliers', 'truck', '/v1/vendors'], ['vcontacts', 'Vendor contacts', 'users', '/v1/vendor-contacts'],
      ['vmap', 'Vendor materials', 'link', '/v1/vendor-rm-mappings'],
      ['ratehist', 'Rate history', 'list', '/v1/vendor-rate-history'], ['vperf', 'Vendor performance', 'activity', '/v1/vendor-performance'],
      ['settle', 'Settlements', 'clipboard', '/v1/vendor-credit-notes'], ['rejgrns', 'Rejected GRNs', 'alert', '/v1/qc-rejected-grns'],
      ['vledger', 'Vendor ledger', 'clipboard', '/v1/vendor-ledger'], ['materials', 'Materials', 'box', '/v1/materials'] ] },
    receiving: { label: 'Receiving', dept: 'Receiving', user: 'Receiving', nav: [
      ['vdispatch', 'Vendor dispatch', 'truck', '/v1/vendor-dispatches'],
      ['gate', 'Gate entries', 'truck', '/v1/gate-entries'], ['grns', 'Goods receipt', 'clipboard', '/v1/grns'],
      ['grnitems', 'Qty verification', 'activity', '/v1/grn-items'],
      ['batches', 'Batches', 'layers', '/v1/rm-batches'], ['containers', 'Containers', 'box', '/v1/grn-containers'] ] },
    qc: { label: 'QC Laboratory', dept: 'Quality Control', user: 'QC', nav: [
      ['queue', 'Test queue', 'flask', '/v1/qc-inspections'], ['results', 'Results', 'clipboard', '/v1/qc-result-details'],
      ['prodqc', 'Production QC', 'activity', '/v1/production-qc'], ['samples', 'Sample retention', 'beaker', '/v1/qc-sample-retentions'],
      ['qcparams', 'QC parameters', 'list', '/v1/qc-parameters'] ] },
    production: { label: 'Production', dept: 'Manufacturing & QC oversight', user: 'Production', nav: [
      ['bridgereq', 'ALEMBIC requirements', 'link', '/v1/bridge/requirements'],
      ['plans', 'Production plans', 'calendar', '/v1/production-plans'], ['planitems', 'Plan items', 'list', '/v1/production-plan-items'],
      ['runs', 'Production orders', 'layers', '/v1/production-orders', true], ['orderitems', 'Order ingredients', 'list', '/v1/production-order-ingredients', true],
      ['picks', 'Pick lists', 'list', '/v1/material-pick-lists'], ['pickitems', 'Pick list items', 'list', '/v1/material-pick-list-items'],
      ['issues', 'Material issues', 'box', '/v1/material-issues'],
      ['mixing', 'Mixing sessions', 'flask', '/v1/mixing-sessions', true], ['weigh', 'Weighing', 'sliders', '/v1/weighing-records'],
      ['oil', 'Oil batches', 'droplet', '/v1/oil-batches'],
      ['prodqc', 'Production QC', 'activity', '/v1/production-qc'], ['capas', 'CAPA', 'shield', '/v1/qc-capas'] ] },
    warehouse: { label: 'Warehouse', dept: 'Warehouse', user: 'Warehouse', nav: [
      ['stock', 'Stock (FEFO)', 'box', '/v1/inventory-availability'], ['rm', 'RM batches', 'layers', '/v1/rm-batches'],
      ['movements', 'Movements', 'activity', '/v1/inventory-transactions'], ['adjust', 'Adjustments', 'sliders', '/v1/stock-adjustments'],
      ['reserve', 'Reservations', 'lock', '/v1/stock-reservations'], ['counts', 'Stock counts', 'clipboard', '/v1/stock-audits'],
      ['transfers', 'Transfers', 'refresh', '/v1/stock-transfers'],
      ['warehouses', 'Warehouses', 'building', '/v1/warehouses'], ['floors', 'Floors', 'layers', '/v1/floors'],
      ['zones', 'Zones', 'grid', '/v1/zones'], ['racks', 'Racks', 'shelf', '/v1/racks'],
      ['shelves', 'Shelves', 'shelf', '/v1/shelves'], ['bins', 'Bins', 'box', '/v1/bins'] ] },
    compounding: { label: 'Compounding', dept: 'Compounding', user: 'Compounding', nav: [
      ['work', 'Worksheets', 'beaker', '/v1/production-order-ingredients', true], ['orders', 'Production orders', 'grid', '/v1/production-orders'],
      ['picks', 'Pick lists', 'list', '/v1/material-pick-lists'], ['issues', 'Material issues', 'box', '/v1/material-issues'],
      ['mixing', 'Mixing sessions', 'flask', '/v1/mixing-sessions'], ['weigh', 'Weighing', 'sliders', '/v1/weighing-records'],
      ['oil', 'Oil batches', 'droplet', '/v1/oil-batches'] ] },
    filling: { label: 'Filling', dept: 'Filling', user: 'Filling', nav: [
      ['tickets', 'Fill tickets', 'droplet', '/v1/filling-sessions'], ['orders', 'Package orders', 'box', '/v1/package-orders'],
      ['oil', 'Bulk lots', 'layers', '/v1/oil-batches'] ] },
    packaging: { label: 'Packaging', dept: 'Packaging', user: 'Packaging', nav: [
      ['orders', 'Pack orders', 'box', '/v1/package-orders'], ['fg', 'Finished goods', 'pkg', '/v1/finished-good-batches'],
      ['fgstock', 'FG stock (ATP)', 'box', '/v1/fg-stock'], ['fgreserve', 'FG reservations', 'lock', '/v1/fg-reservations'],
      ['labels', 'FG labels', 'tag', '/v1/fg-labels'],
      ['pkgqc', 'Packaging QC', 'flask', '/v1/packaging-qc'], ['products', 'Products', 'tag', '/v1/products'],
      ['skus', 'Product SKUs', 'tag', '/v1/product-skus'], ['pkgbom', 'Packaging BOM', 'layers', '/v1/packaging-boms'] ] },
    sales: { label: 'Sales & Dispatch', dept: 'Sales & Dispatch', user: 'Sales', nav: [
      ['orders', 'Sales orders', 'clipboard', '/v1/sales-orders'], ['customers', 'Customers', 'users', '/v1/customers'],
      ['fgstock', 'FG stock (ATP)', 'box', '/v1/fg-stock'], ['fgreserve', 'FG reservations', 'lock', '/v1/fg-reservations'],
      ['transporters', 'Transporters', 'building', '/v1/transporters'], ['dispatch', 'Dispatches', 'truck', '/v1/dispatches'],
      ['ddocs', 'Dispatch docs', 'clipboard', '/v1/dispatch-documents'] ] }
  };
  // Curated, readable columns per endpoint (DB field names). Fallback = a smart generic picker.
  var COLS = {
    '/v1/users': ['userName', 'email', 'employeeCode', 'mobileNumber', 'isActive', 'status'],
    '/v1/roles': ['roleCode', 'roleName', 'status'],
    '/v1/permissions': ['permissionCode', 'moduleName', 'permissionName', 'status'],
    '/v1/production-orders': ['productionOrderId', 'orderQty', 'formulaVersionId', 'actualStartDt', 'status'],
    '/v1/production-order-ingredients': ['aliasName', 'requiredQty', 'issuedQty', 'status'],
    '/v1/formula-event-hist': ['eventType', 'eventDt', 'formulaId', 'remarks'],
    '/v1/materials': ['materialCode', 'materialName', 'reorderLevel', 'qcRequired', 'status'],
    '/v1/rm-aliases': ['aliasName', 'aliasType', 'status'],
    '/v1/material-types': ['typeCode', 'typeName', 'status'],
    '/v1/material-categories': ['categoryCode', 'categoryName', 'status'],
    '/v1/material-subcategories': ['subCategoryCode', 'subCategoryName', 'status'],
    '/v1/material-groups': ['groupCode', 'groupName', 'status'],
    '/v1/material-qc-specifications': ['materialCode', 'materialName', 'parameterName', 'minValue', 'maxValue', 'targetValue', 'status'],
    '/v1/material-storage-rules': ['materialCode', 'materialName', 'minTemperature', 'maxTemperature', 'storageCondition', 'status'],
    '/v1/grn-containers': ['grnNumber', 'containerCode', 'containerQty', 'status'],
    '/v1/batch-container-mappings': ['batchNumber', 'containerCode', 'status'],
    '/v1/geo-region-types': ['key', 'name', 'displayOrder', 'typicalParent'],
    '/v1/geo-regions': ['name', 'typeName', 'code', 'parentName', 'isActive'],
    '/v1/products': ['productCode', 'productName', 'status'],
    '/v1/packaging-boms': ['skuCode', 'packagingMaterialName', 'requiredQty', 'status'],
    '/v1/quotation-items': ['quotationNumber', 'vendorName', 'materialName', 'quotedQty', 'quotedRate', 'status'],
    '/v1/vendor-negotiations': ['quotationNumber', 'vendorName', 'materialName', 'originalRate', 'revisedRate', 'recommendation', 'status'],
    '/v1/vendor-rate-history': ['asOf', 'vendorName', 'materialName', 'rate', 'source'],
    '/v1/vendor-performance': ['vendorName', 'poCount', 'grnCount', 'qcPass', 'qcFail', 'qcPassPct'],
    '/v1/qc-rejected-grns': ['grnNumber', 'vendorName', 'poNumber', 'qcResult'],
    '/v1/vendor-ledger': ['vendorName', 'poTotal', 'creditNotes', 'creditTotal', 'netBalance'],
    '/v1/po-advance-payments': ['poNumber', 'vendorName', 'amount', 'paymentDate', 'reference', 'status'],
    '/v1/vendor-dispatches': ['poNumber', 'vendorName', 'dispatchDate', 'transporter', 'docketNumber', 'status'],
    '/v1/qc-sample-retentions': ['sampleCode', 'sampleQty', 'retainedDt', 'status'],
    '/v1/approval-matrix': ['module', 'transaction', 'createdBy', 'approvedBy', 'finalAuthority', 'autoApproval', 'remarks'],
    '/v1/production-plans': ['planDate', 'plannedStartDt', 'plannedEndDt', 'status'],
    // OPS-GREEN (lane ops-factory): the factory path's new records + the write audit trail.
    '/v1/weighing-records': ['sequenceNo', 'floorCode', 'targetQty', 'netQty', 'uom', 'tolerancePct', 'status', 'weighedDt'],
    '/v1/fg-labels': ['labelCount', 'status', 'appliedDt'],
    '/v1/bridge/requirements': ['orderRef', 'mappedSku', 'qty', 'uom', 'lifecycleStatus', 'neededBy'],
    '/v1/audit-events': ['occurredAt', 'actor', 'cluster', 'action', 'entityType', 'resultStatus'],
    '/v1/production-plan-items': ['plannedQty', 'status'],
    '/v1/organizations': ['type', 'name', 'reraNo', 'gstin', 'status'],
    '/v1/locations': ['locationCode', 'locationName', 'status'],
    '/v1/location-types': ['typeCode', 'typeName', 'status'],
    '/v1/vendors': ['vendorCode', 'vendorName', 'gstin', 'paymentTerms', 'status'],
    '/v1/vendor-contacts': ['contactName', 'contactType', 'designation', 'email', 'mobileNumber', 'status'],
    '/v1/vendor-rm-mappings': ['vendorName', 'materialCode', 'materialName', 'isPreferred', 'leadTimeDays', 'minOrderQty', 'status'],
    '/v1/purchase-orders': ['poNumber', 'vendorName', 'totalAmount', 'replacementOfPo', 'status'],
    '/v1/purchase-requests': ['prNumber', 'expectedDeliveryDate', 'status'],
    '/v1/gate-entries': ['gateEntryNumber', 'vehicleNumber', 'driverName', 'status'],
    '/v1/grns': ['grnNumber', 'grnDate', 'status'],
    '/v1/grn-items': ['grnNumber', 'orderedQty', 'receivedQty', 'acceptedQty', 'rejectedQty', 'damagedQty', 'varianceType', 'status'],
    '/v1/rm-batches': ['batchNumber', 'expiryDate', 'fefoFlag', 'status'],
    '/v1/qc-inspections': ['batchNumber', 'overallResult', 'inspectionDt', 'status'],
    '/v1/qc-result-details': ['parameterName', 'observedValue', 'observedText', 'result', 'status'],
    '/v1/qc-parameters': ['parameterCode', 'parameterName', 'status'],
    '/v1/inventory-batches': ['rmBatchId', 'availableQty', 'reservedQty', 'status'],
    '/v1/inventory-availability': ['batchNumber', 'available', 'onHand', 'reserved', 'expiryDate', 'daysToExpiry'],
    '/v1/document-registry': ['title', 'documentType', 'entityType', 'expiryDate', 'daysToExpiry', 'version', 'status'],
    '/v1/reorder-suggestions': ['materialCode', 'materialName', 'available', 'reorderLevel', 'shortage', 'suggestedVendor'],
    '/v1/login-history': ['loginAt', 'user', 'portal', 'expiresAt'],
    '/v1/contacts': ['contactName', 'email', 'mobileNumber', 'status'],
    '/v1/countries': ['countryCode', 'countryName', 'status'],
    '/v1/stock-transfers': ['transferQty', 'transferDt', 'status'],
    '/v1/racks': ['rackCode', 'rackName', 'status'],
    '/v1/mixing-sessions': ['sessionStartDt', 'sessionEndDt', 'status'],
    '/v1/oil-batches': ['batchNumber', 'producedQty', 'producedDt', 'status'],
    '/v1/filling-sessions': ['sessionStartDt', 'sessionEndDt', 'status'],
    '/v1/package-orders': ['skuCode', 'orderQty', 'status'],
    '/v1/finished-good-batches': ['batchNumber', 'producedQty', 'manufacturingDate', 'status'],
    '/v1/fg-stock': ['batchNumber', 'skuCode', 'producedQty', 'dispatchedQty', 'reservedQty', 'availableQty', 'expiryDate', 'daysToExpiry'],
    '/v1/fg-stock/by-sku': ['skuCode', 'productName', 'batchCount', 'producedQty', 'availableQty'],
    '/v1/fg-reservations': ['finishedGoodBatchId', 'reservedQty', 'channel', 'reservedForDocumentId', 'reservedDt', 'status'],
    '/v1/product-skus': ['skuCode', 'packSize', 'status'],
    '/v1/sales-orders': ['soNumber', 'totalAmount', 'orderDate', 'origin', 'status'],
    '/v1/customers': ['customerCode', 'customerName', 'status'],
    '/v1/transporters': ['transporterCode', 'transporterName', 'status'],
    '/v1/stock-requirements': ['materialCode', 'materialName', 'requiredQty', 'requiredByDate', 'priority', 'status'],
    '/v1/rfqs': ['rfqNumber', 'prNumber', 'rfqDate', 'submissionDeadline', 'status'],
    '/v1/quotations': ['quotationNumber', 'quotationDate', 'validUntilDate', 'status'],
    '/v1/material-pick-lists': ['pickListDate', 'productionOrderId', 'status'],
    '/v1/material-issues': ['issuedDt', 'productionOrderId', 'status'],
    '/v1/production-qc': ['result', 'observedValue', 'inspectionDt', 'status'],
    '/v1/warehouses': ['warehouseCode', 'warehouseName', 'status'],
    '/v1/floors': ['floorCode', 'floorName', 'status'],
    '/v1/zones': ['zoneCode', 'zoneName', 'status'],
    '/v1/shelves': ['shelfCode', 'shelfName', 'status'],
    '/v1/bins': ['binCode', 'binName', 'status'],
    '/v1/uoms': ['uomCode', 'uomName', 'status'],
    '/v1/business-units': ['businessUnitCode', 'businessUnitName', 'status'],
    '/v1/packaging-qc': ['overallResult', 'leakageCheck', 'labelCheck', 'cartonCheck', 'inspectionDt'],
    '/v1/notifications': ['eventType', 'subject', 'status', 'recipient', 'createdDt'],
    '/v1/dispatches': ['soNumber', 'customerName', 'dispatchDate', 'vehicleNumber', 'status'],
    '/v1/dispatch-documents': ['documentType', 'documentNumber', 'soNumber', 'customerName', 'documentDate', 'amount', 'status']
  };
  // Every role opens on a rich, DB-aggregated dashboard (endpoint sentinel '__dash__' → /v1/dashboard).
  Object.keys(ROLES).forEach(function (k) {
    var label = k === 'warehouse' ? 'Floor map' : 'Dashboard';
    var ic = k === 'warehouse' ? 'mappin' : (k === 'superadmin' ? 'activity' : 'grid');
    ROLES[k].nav.unshift(['dashboard', label, ic, '__dash__']);
  });
  // G4: "Tutorials" — added to every role's nav the same way Dashboard is above (a nav tuple
  // dispatched by the sentinel endpoint loadView() already special-cases, not a per-role
  // permission gate — nav ITEMS aren't individually permission-filtered anywhere else in this
  // file either; loadTutorialView (web/tutorial.js, loaded after this file) itself decides which
  // lessons a session may actually see, same split as __dash__/loadDashboard).
  Object.keys(ROLES).forEach(function (k) { ROLES[k].nav.push(['tutorial', 'Tutorials', 'clipboard', '__tutorial__']); });
  // LANE D1: the demo showcase opens the owner's screens; the server keeps it read-only and masked (no writes, no formula access).
  var VIEW = { owner: 'superadmin', showcase: 'superadmin' };
  function roleView(r) { return VIEW[r] || r; }

  /* ---------------- state + helpers ---------------- */
  var st = { role: null, nav: null, search: '', collapsed: false, drawer: false };
  var $ = function (id) { return document.getElementById(id); };
  // No-op kept so every existing call site across shell.js/ws-*.js (which call setTheme() after
  // inserting a modal into the DOM, from the old runtime skin-switching design) stays valid without
  // hunting down each one — the ALEMBIC tokens are now a static stylesheet (ui-contract/
  // alembic-tokens.css + shell.css), not JS-applied inline custom properties, so there is nothing
  // left to (re)apply at render time.
  function setTheme() {}

  // Curate which fields to show + how, from a real row object (DB is the source).
  var HIDE = { createdDt: 1, updatedDt: 1, createdBy: 1, updatedBy: 1 };
  function sensitive(k) { return /hash|secret|token|password|salt|enc_?payload|enc_?iv|enc_?tag|encpayload|enciv|enctag|encryption|vaultlocation/i.test(k); }
  function isUuid(v) { return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/.test(v); }
  function label(k) { return k.replace(/([A-Z])/g, ' $1').replace(/Id\b/, '').replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }).trim(); }
  // uomId → readable unit code (kg / L / units …), loaded once (loadView) and used to label
  // quantity cells + create-form unit pickers so every quantity reads "10 kg", not a bare "10".
  var UOM = {};
  function trimNum(v) { var n = Number(v); return isFinite(n) && String(v).trim() !== '' ? String(n) : String(v); }
  function isQtyKey(k) { return /qty$/i.test(k) || k === 'available' || k === 'onHand' || k === 'reserved'; }
  function unitHtml(k, r) { var u = (isQtyKey(k) && r && r.uomId && UOM[r.uomId]) ? UOM[r.uomId] : ''; return u ? ' <span style="color:var(--ink-3);font-weight:var(--w-med);font-size:var(--t-cap)">' + u + '</span>' : ''; }
  function fmt(k, v, r) {
    if (v === null || v === undefined || v === '') return '<span style="color:var(--ink-3)">—</span>';
    if (typeof v === 'boolean') return v ? '<span style="color:var(--green);font-weight:var(--w-med)">Yes</span>' : '<span style="color:var(--ink-3)">No</span>';
    if (k === 'daysToExpiry') { var d = Number(v); var c = d <= 30 ? 'var(--red)' : (d <= 90 ? 'var(--amber)' : 'var(--ink-2)'); return '<span style="font-weight:var(--w-med);color:' + c + '">' + (d <= 0 ? 'EXPIRED' : d + ' d') + '</span>'; }
    if (k === 'available' || k === 'availableQty') { var a = Number(v); return '<span style="font-weight:var(--w-med);font-family:var(--font-mono);color:' + (a <= 0 ? 'var(--red)' : 'var(--green)') + '">' + trimNum(v) + '</span>' + unitHtml(k, r); }
    if (k === 'shortage') { var sh = Number(v); return '<span style="font-weight:var(--w-med);font-family:var(--font-mono);color:' + (sh > 0 ? 'var(--red)' : 'var(--ink-3)') + '">' + (sh > 0 ? '▲ ' + v : v) + '</span>'; }
    if (isQtyKey(k) && isFinite(Number(v))) return '<span style="font-family:var(--font-mono);font-size:var(--t-cap);font-weight:var(--w-med)">' + trimNum(v) + '</span>' + unitHtml(k, r);
    if (k === 'status' || k === 'overallResult' || k === 'approvalStatus') { var tone = STATUS[String(v).toLowerCase()] || 'n'; return '<span class="chip ' + tone + '"><i class="dot"></i>' + v + '</span>'; }
    if (isUuid(v)) return '<span style="font-family:var(--font-mono);font-size:var(--t-cap);color:var(--ink-2)">' + String(v).slice(0, 8).toUpperCase() + '</span>';
    if (/Dt$|Date$|_dt$/.test(k) && typeof v === 'string' && v.indexOf('T') > 0) return '<span style="color:var(--ink-2)">' + v.slice(0, 10) + '</span>';
    if (/code|number|alias/i.test(k)) return '<span style="font-family:var(--font-mono);font-size:var(--t-cap);font-weight:var(--w-med)">' + v + '</span>';
    return '<span>' + String(v) + '</span>';
  }
  function columns(rows, endpoint) {
    if (!rows.length) return [];
    var present = Object.keys(rows[0]);
    var ok = function (k) { return present.indexOf(k) >= 0 && !HIDE[k] && !sensitive(k); };
    if (COLS[endpoint]) { var pick = COLS[endpoint].filter(ok); if (pick.length) return pick.slice(0, 7); }
    // smart generic: names/codes first, then quantities, types, dates, status; uuid ids last.
    function sc(k) { var l = k.toLowerCase();
      if (/code$|^name|name$|email|alias|title|number$/.test(l)) return 0;
      if (/qty|quantity|amount|rate|result|level|count|percentage|value/.test(l)) return 1;
      if (/type|class|category|reason|remark|note|method/.test(l)) return 2;
      if (/date|dt$/.test(l)) return 3;
      if (/status|active|state/.test(l)) return 4;
      if (/id$/.test(l)) return 6; return 5; }
    var keys = present.filter(function (k) { return !HIDE[k] && !sensitive(k); });
    keys.sort(function (a, b) { return sc(a) - sc(b); });
    return keys.slice(0, 6);
  }

  /* ---------------- reference shell kit (vanilla port of rac-console.jsx) ----------------
   * The Admin/Agent reference (rawprod-lanes/reference/admin/d6c51180.javascript, rac-console.jsx)
   * defines the shell as React components: BrandMark, QuickDock, GCard, ExpandSheet, the rail
   * toggle and usePageEnter. This console is plain classic scripts, so each is ported as a string
   * builder or a small wiring function with the same class names and the same behaviour; the
   * styling is rac-console.css itself (vendored verbatim, web/ui-contract/rac-console.css). */
  var CI = { // the reference's CIcon glyphs used by the chrome (16px grid, 1.6–1.9 stroke)
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M13.5 6.5 8 12l5.5 5.5"/><path d="M19 5v14"/></svg>',
    cmd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 6.6a2.6 2.6 0 1 0-2.6 2.6H9V6.6zM15 6.6a2.6 2.6 0 1 1 2.6 2.6H15V6.6zM9 17.4a2.6 2.6 0 1 1-2.6-2.6H9v2.6zM15 17.4a2.6 2.6 0 1 0 2.6-2.6H15v2.6z"/><rect x="9" y="9.2" width="6" height="5.6"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6.4 9.4a5.6 5.6 0 1 1 11.2 0c0 4.6 1.9 5.6 1.9 5.6H4.5s1.9-1 1.9-5.6"/><path d="M10.2 18.4a1.9 1.9 0 0 0 3.6 0"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h13"/><path d="m12.5 5.5 6.5 6.5-6.5 6.5"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.4l1.7 6 5.9.7-4.4 4 1.3 5.8L12 15.9 7.5 18.9l1.3-5.8-4.4-4 5.9-.7z"/></svg>'
  };
  window.RA_CI = CI; // ws-*.js dialogs use the same close glyph
  // BrandMark — the lockup, one builder so it can't drift.
  function brandMark(sub, onInk, compact) {
    // UX-D (release/ui/BRAND_ASSETS.md): the RAW logo, not a letter tile — reversed art on the ink
    // rail, colour art on light glass; logo/brand.css fixes the height per context.
    return '<span class="brandmark' + (onInk ? ' on-ink' : '') + '">' + (compact ? '<img class="brand-logo brand-logo--dock" src="/logo/raw-logo.png" srcset="/logo/raw-logo.png 1x, /logo/raw-logo@2x.png 2x, /logo/raw-logo@3x.png 3x" width="48" height="22" alt="">' : (onInk ? '<img class="brand-logo brand-logo--rail" src="/logo/raw-logo-ondark.png" srcset="/logo/raw-logo-ondark.png 1x, /logo/raw-logo-ondark@2x.png 2x, /logo/raw-logo-ondark@3x.png 3x" width="66" height="30" alt="">' : '<img class="brand-logo brand-logo--rail" src="/logo/raw-logo.png" srcset="/logo/raw-logo.png 1x, /logo/raw-logo@2x.png 2x, /logo/raw-logo@3x.png 3x" width="66" height="30" alt="">')) +
      (compact ? '' : '<span class="bt">Alembic' + (sub ? '<small>' + sub + '</small>' : '') + '</span>') + '</span>';
  }
  // GCard — one card shell so every panel is the same shape: glass, lift, title + caption, the
  // top-right expand affordance, body, optional foot. `span`/`rows` are the 12-col grid classes.
  var _gcSeq = 0, _gcBodies = {};
  function gCard(o) {
    var id = 'gc' + (_gcSeq++);
    _gcBodies[id] = { title: o.title || '', meta: o.meta || '', body: o.detail || o.body };
    var tone = o.tone === 'accent' ? ' glass-accent' : '';
    return '<div class="glass lift gcard ' + (o.span || 'c4') + ' ' + (o.rows || 'r1') + tone + (o.cls ? ' ' + o.cls : '') + '"' + (o.style ? ' style="' + o.style + '"' : '') + '>' +
      ((o.title || o.expand !== false) ? '<div class="gcard-hd"><div class="ttl">' +
        (o.title ? '<h3 class="t-h2">' + o.title + '</h3>' : '') + (o.meta ? '<p class="t-cap">' + o.meta + '</p>' : '') + '</div>' +
        (o.expand === false ? '' : '<button type="button" class="xp" data-expand="' + id + '" aria-label="Expand ' + escHtml(o.title || 'panel') + '">' + CI.expand + '</button>') +
      '</div>' : '') +
      '<div class="gcard-bd' + (o.top ? ' top' : '') + '">' + o.body + '</div>' +
      (o.foot ? '<div class="gcard-ft">' + o.foot + '</div>' : '') + '</div>';
  }
  // ExpandSheet — what the expand affordance opens: the same card, at reading size, in the
  // reference's glass sheet (openSheet below carries the focus trap / Escape / restore).
  function wireExpand(root) {
    [].forEach.call((root || document).querySelectorAll('[data-expand]'), function (b) {
      b.onclick = function () {
        var d = _gcBodies[b.getAttribute('data-expand')]; if (!d) return;
        openSheet({ tag: 'div', title: d.title, meta: d.meta, cls: 'xp-wide', body: '<div class="stack-base">' + d.body + '</div>' });
      };
    });
  }
  // usePageEnter — route entrance: the resting state is correct and the offset is an additive
  // attribute removed on a timer, so a stalled timeline degrades to no motion.
  function pageEnter(el, dir) {
    if (!el || !dir) return;
    el.setAttribute('data-enter', dir);
    setTimeout(function () { el.setAttribute('data-settling', ''); el.removeAttribute('data-enter'); }, 20);
    setTimeout(function () { el.removeAttribute('data-settling'); }, 460);
  }
  // Go-to palette (⌘/): every destination this role holds, filterable, Enter to go.
  function openPalette() {
    if ($('ra-cmdk')) { closePalette(); return; }
    var R = ROLES[st.role]; if (!R) return;
    var wrap = document.createElement('div'); wrap.id = 'ra-cmdk';
    wrap.innerHTML = '<div class="xp-scrim open" data-cmdk-x></div>' +
      '<div class="glass glass-deep cmdk" role="dialog" aria-modal="true" aria-label="Go to">' +
        '<input id="ra-cmdk-q" type="text" placeholder="Go to…" aria-label="Go to" autocomplete="off">' +
        '<ul id="ra-cmdk-l" role="listbox"></ul></div>';
    document.body.appendChild(wrap);
    var q = $('ra-cmdk-q'), list = $('ra-cmdk-l'), idx = 0, rows = [];
    function paint() {
      var t = q.value.trim().toLowerCase();
      rows = R.nav.filter(function (n) { return !t || n[1].toLowerCase().indexOf(t) >= 0; });
      if (idx >= rows.length) idx = 0;
      list.innerHTML = rows.map(function (n, i) {
        return '<li><button type="button" data-go="' + n[0] + '" class="' + (i === idx ? 'on' : '') + '">' + icon(n[2], 15) + n[1] +
          (R.nav.indexOf(n) < 9 ? '<span class="sc">⌘' + (R.nav.indexOf(n) + 1) + '</span>' : '') + '</button></li>';
      }).join('') || '<li class="loading" style="padding:var(--s-base)">No match</li>';
      [].forEach.call(list.querySelectorAll('[data-go]'), function (b) { b.onclick = function () { go(b.getAttribute('data-go')); }; });
    }
    function go(k) { closePalette(); navTo(k); }
    q.oninput = function () { idx = 0; paint(); };
    q.onkeydown = function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(rows.length - 1, idx + 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); paint(); }
      else if (e.key === 'Enter' && rows[idx]) { e.preventDefault(); go(rows[idx][0]); }
      else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    };
    wrap.querySelector('[data-cmdk-x]').onclick = closePalette;
    paint(); q.focus();
  }
  function closePalette() { var w = $('ra-cmdk'); if (w) w.remove(); }
  function navTo(k) {
    var R = ROLES[st.role]; if (!R || !R.nav.some(function (n) { return n[0] === k; })) return;
    if (st.nav === k) return;
    st.nav = k; st.search = '';
    if (window.innerWidth <= 1023) st.drawer = false;
    shell();
  }

  /* ---------------- Ask Aria (UX-E panel, UX-H answers) ----------------
   * The panel is ALEMBIC's own (ui-contract/aria-panel.js, AlembicAria.mount — the vanilla port of
   * AriaPanel, same DOM/classes/states), opened from the top bar's "Ask Aria" and the dock's
   * "Ask Aria · ⌘K", exactly as ALEMBIC Admin/Agent open it.
   *
   * WHERE THE ANSWERS COME FROM (UX-H). This console holds a RawProd session and its CSP is
   * connect-src 'self', so it asks its OWN server — POST /v1/aria/ask, through the same encrypted
   * /rpc tunnel as every other call — and RawProd's server forwards the question to ALEMBIC over
   * the signed rawprod_bridge channel (backend/api/src/aria/aria-bridge.service.ts). ALEMBIC answers
   * as the ALEMBIC staff member this RawProd user is bound to, with that person's own permissions,
   * through the same code path as ALEMBIC Admin's Aria. What is sent: the question, the thread id
   * and the NAME of this view — never page data.
   *
   * THE HONEST FALLBACK STAYS. GET /v1/aria/status is asked on open; when the bridge is not
   * configured, or this sign-in is not linked to an ALEMBIC account, the panel opens in the
   * "Aria answers in ALEMBIC" state it has always had: that one plain answer, shown as a refusal
   * (never as a fact), with nothing invented locally. */
  var ARIA_HERE = 'I answer from ALEMBIC\'s records, and this console has no connection to them yet. Ask me in ALEMBIC Admin.';
  var _aria = null, _ariaMode = null, _ariaMsg = '';
  function ariaView() {
    var R = ROLES[st.role]; var it = R && R.nav.filter(function (n) { return n[0] === st.nav; })[0];
    return it ? it[1] : 'Dashboard';
  }
  function ariaContext() { return 'Factory · ' + ariaView(); }
  // Fetched the first time Aria opens, as ALEMBIC's AriaCoPilot lazy-loads its panel: nothing of
  // it is on first paint, and index.html keeps loading only the split modules (ui-parity-check §18).
  var _ariaLoading = null;
  function loadAria() {
    if (typeof AlembicAria !== 'undefined') return Promise.resolve();
    if (_ariaLoading) return _ariaLoading;
    _ariaLoading = new Promise(function (ok, no) {
      var sc = document.createElement('script'); sc.src = '/ui-contract/aria-panel.js';
      sc.onload = ok; sc.onerror = function () { _ariaLoading = null; no(new Error('aria')); };
      document.head.appendChild(sc);
    });
    return _ariaLoading;
  }
  // Is Aria connected for THIS user? Once it is, it is not asked again this session.
  function ariaStatus() {
    if (_ariaMode === 'live') return Promise.resolve({ live: true });
    return tunnel('/v1/aria/status').then(function (r) {
      var d = r && r.status < 400 && r.json ? r.json.data : null;
      return d && d.available ? { live: true } : { live: false, message: (d && d.message) || ARIA_HERE };
    }).catch(function () { return { live: false, message: ARIA_HERE }; });
  }
  // One question to this console's own server, answered by ALEMBIC (see the header above).
  function ariaAsk(question, extra) {
    var body = { question: question, console: 'factory', view: ariaView(), persist: true };
    if (extra && extra.conversationId) body.conversationId = extra.conversationId;
    return tunnel('/v1/aria/ask', { method: 'POST', body: body }).then(function (r) {
      if (r.status >= 400) return { ok: false, reason: 'http-' + r.status };
      var d = r.json && r.json.data;
      if (d && d.status === 'answered') return { ok: true, text: d.text, via: d.via, cited: d.cited || [], conversationId: d.conversationId || null };
      if (d && d.reason === 'rate_limited') return { ok: false, reason: 'http-429' };
      if (d && d.reason !== 'unreachable' && d.message) return { ok: true, via: 'refusal', text: d.message, cited: [] };
      return { ok: false, reason: 'unreachable' };
    }).catch(function () { return { ok: false, reason: 'unreachable' }; });
  }
  function ariaPanel(s) {
    var mode = s.live ? 'live' : 'fallback';
    if (_aria && _ariaMode === mode && (s.live || _ariaMsg === s.message)) return _aria;
    if (_aria) _aria.destroy();
    _ariaMode = mode; _ariaMsg = s.live ? '' : s.message;
    if (s.live) {
      _aria = AlembicAria.mount({ context: ariaContext(), ask: ariaAsk, parent: document.body });
      return _aria;
    }
    var msg = _ariaMsg;
    _aria = AlembicAria.mount({
      context: ariaContext(),
      prompts: ['Where can I ask Aria?'],
      ask: function () { return Promise.resolve({ ok: true, via: 'refusal', text: msg, cited: [] }); },
      parent: document.body,
    });
    // The panel's fixed greeting promises answers from orders, stock and enquiries; here it says
    // why Aria cannot answer yet. Re-applied whenever the panel repaints its empty state.
    var panel = _aria;
    var fix = function () { var p = panel.element.querySelector('.aria-empty > p'); if (p && p.textContent !== msg) p.textContent = msg; };
    new MutationObserver(fix).observe(panel.element, { childList: true, subtree: true }); fix();
    return _aria;
  }
  function ariaReset() { if (_aria) _aria.destroy(); _aria = null; _ariaMode = null; _ariaMsg = ''; }
  function toggleAria() {
    if (_aria && _aria.isOpen()) { _aria.close(); return; }
    Promise.all([loadAria(), ariaStatus()]).then(function (v) { var a = ariaPanel(v[1]); a.setContext(ariaContext()); a.open(); })
      .catch(function () { toast('Aria didn\'t load. Try again.', 'bad'); });
  }

  /* ---------------- render: shell + data view ---------------- */
  // The reference Admin/Agent shell, 1:1: a rail (collapsed by default — body.rail-off — so the
  // floating dock is the navigation), a top bar (platform brand, page title, page actions), the
  // region, the floating glass dock (brand tile, rail toggle, destinations with ⌘1–9, command
  // palette). Nav items are NOT filtered client-side beyond "what this session's permission-driven
  // ROLES entry contains" — the server enforces per-action authorization. The dock carries the
  // SAME `R.nav` set as the rail; below 1024 it becomes the reference's tab bar, keeping the
  // first destinations (HOT) plus "Sections", which opens the rail as a drawer.
  function shell() {
    $('app').className = 'app'; // clear the login screen's override (showLogin blanks it)
    var R = ROLES[st.role]; var initials = (R.user || 'RA').slice(0, 2).toUpperCase();
    var prevIdx = R.nav.map(function (n) { return n[0]; }).indexOf(st._prevNav);
    var curIdx = R.nav.map(function (n) { return n[0]; }).indexOf(st.nav);
    var navHtml = R.nav.map(function (n) {
      var on = st.nav === n[0];
      // data-tutorial-target="nav-<key>" (G4): the ONE dedicated attribute the tutorial runner's
      // target/action steps use to locate this real nav button (web/tutorial.js).
      return '<button data-nav="' + n[0] + '" data-tutorial-target="nav-' + n[0] + '" class="ri' + (on ? ' on' : '') + '"' + (on ? ' aria-current="page"' : '') + '>' +
        icon(n[2], 14) + '<span class="nm">' + n[1] + '</span></button>';
    }).join('');
    var HOT = {}; R.nav.slice(0, 3).forEach(function (n) { HOT[n[0]] = 1; });
    var dockHtml =
      '<button type="button" class="brandmark qd-brand" id="ra-dock-home" aria-label="Dashboard"><img class="brand-logo brand-logo--dock" src="/logo/raw-logo.png" srcset="/logo/raw-logo.png 1x, /logo/raw-logo@2x.png 2x, /logo/raw-logo@3x.png 3x" width="48" height="22" alt=""></button>' +
      '<button type="button" id="ra-dock-toggle" class="qb dk-navtoggle hot" aria-label="Show navigation" aria-pressed="false">' + CI.menu + '<span class="kb">Sections<span class="kc"> · ⌘\\</span></span></button>' +
      '<span class="sep"></span>' +
      R.nav.map(function (n, i) {
        var on = st.nav === n[0];
        return '<button type="button" data-nav="' + n[0] + '" class="qb' + (on ? ' on' : '') + (HOT[n[0]] ? ' hot' : '') + '"' +
          ' aria-label="' + n[1] + '" aria-pressed="' + on + '"' + (on ? ' aria-current="page"' : '') + '>' +
          icon(n[2], 17) + '<span class="kb">' + n[1] + (i < 9 ? '<span class="kc"> · ⌘' + (i + 1) + '</span>' : '') + '</span></button>';
      }).join('') +
      '<span class="sep"></span>' +
      '<button type="button" class="qb hot" id="ra-aria-dock" aria-label="Ask Aria">' + CI.cmd + '<span class="kb">Ask Aria<span class="kc"> · ⌘K</span></span></button>';
    // Workspace switcher: multi-role staff switch workspaces with no second login (addendum
    // §5/§8) — a RawProd composition in the top bar next to the page title.
    var roles = (session && session.availableRoles) || [st.role];
    var switcher = roles.length > 1 ? (
      '<div class="wsw" title="Switch workspace"><select id="ra-wsw" aria-label="Workspace">' +
        roles.map(function (r) { return '<option value="' + r + '"' + (r === st.role ? ' selected' : '') + '>' + (ROLES[r] ? ROLES[r].label : r) + '</option>'; }).join('') +
      '</select></div>'
    ) : '';
    $('app').innerHTML =
      '<nav class="rail" id="ra-side" aria-label="Factory navigation">' +
        '<button type="button" class="rail-min" id="ra-burger" aria-label="Minimise navigation">' + CI.collapse + '</button>' +
        '<button type="button" class="rb" id="ra-home" style="padding-right:44px;background:none;border:0;cursor:pointer;text-align:left;width:100%" aria-label="Dashboard">' +
          brandMark('Factory', true) + '</button>' +
        '<div class="rail-deep"><div><div class="rs">' + R.dept.toUpperCase() + '</div>' + navHtml + '</div></div>' +
        '<div class="rme">' +
          '<span class="av">' + initials + '</span>' +
          '<span class="who">' + R.user + '<small>' + R.label + '</small></span>' +
          '<button type="button" class="rail-min" id="ra-logout" title="Sign out" aria-label="Sign out" style="position:static;margin-left:auto">' + icon('logout', 13) + '</button>' +
        '</div>' +
      '</nav>' +
      '<div id="ra-drawer-bg" class="rail-scrim"></div>' +
      '<div class="main">' +
        '<div id="ra-net-banner" class="net-banner"><span class="dot"></span><span>Offline. Showing the last data loaded; changes won\'t save until you reconnect.</span></div>' +
        '<div class="bar">' +
          '<span class="bar-brand">Alembic<i>·</i>RawAromaChem</span>' +
          '<h1 id="ra-title">' + R.label + '</h1>' +
          '<span style="flex:1"></span>' +
          switcher +
          '<button type="button" class="gbtn acc" id="ra-aria" aria-label="Ask Aria">' + CI.spark + ' Ask Aria</button>' +
          '<div style="position:relative">' +
            '<button type="button" id="ra-bell" class="gbtn" title="Alerts" aria-label="Alerts">' + CI.bell +
              '<span id="ra-bell-badge" class="t-num" style="display:none"></span></button>' +
            '<div id="ra-bell-pop" class="glass glass-deep" style="display:none;position:absolute;right:0;top:40px;width:300px;padding:8px;z-index:60"><div class="loading" style="padding:var(--s-snug)">Loading…</div></div>' +
          '</div>' +
        '</div>' +
        '<div class="content"><section class="pageview" id="ra-view"></section></div>' +
      '</div>' +
      '<button type="button" class="dock-handle" id="ra-dock-handle" aria-label="Show quick access dock"><i></i></button>' +
      '<div class="glass glass-deep qdock" id="ra-dock" role="toolbar" aria-label="Quick access">' + dockHtml + '</div>';
    wireShell();
    if (prevIdx >= 0 && curIdx >= 0 && prevIdx !== curIdx) pageEnter($('ra-view'), curIdx > prevIdx ? 'r' : 'l');
    st._prevNav = st.nav;
    loadView();
    loadAlerts();
    // G4: WelcomePanel-equivalent — offer the current workspace's tutorial once, only when no
    // progress row of any status exists yet for it (see web/tutorial.js).
    if (typeof tutorialMaybeShowWelcome === 'function') tutorialMaybeShowWelcome();
  }

  // COMPONENT_PARITY_MATRIX.json "Card (glass / GCard, dashboard KPI surfaces)" simplified to the
  // flat `.stat` tile admin.css also defines — see ALEMBIC_VISUAL_CONTRACT.json shadows.
  // admin_card_shadow (flat by design). Caller wraps these in a `.stats` grid.
  // UX-C: one tile shape everywhere (label over figure) — the list-view band and the dashboard
  // band used to render two different tiles.
  function kpi(ic, value, lab) {
    return '<div class="stat"><span class="l" style="display:inline-flex;align-items:center;gap:var(--s-tight)">' + icon(ic, 12) + lab + '</span>' +
      '<span class="v">' + value + '</span></div>';
  }

  /* ================= role dashboards (real DB data from /v1/dashboard) ================= */
  // Olfactive family palette — ALEMBIC has no categorical palette of its own, so this reuses its
  // semantic tokens rather than inventing new hex values.
  var CLS = { natural: ['var(--green)', 'Natural'], aroma: ['var(--blue)', 'Aroma chem'], base: ['var(--amber)', 'Base'], solvent: ['var(--purple)', 'Solvent'] };
  function clsCol(k) { var c = CLS[k] || CLS.aroma; return c[0]; }
  // U3b: real ALEMBIC GCard (console.css:172-196, "Uniform card grid") — a .gwrap 12-col grid
  // row of .gcard.glass surfaces. `span` is one of the c3.._c12 utility classes (shell.css "U3b"
  // block); omit it for a plain, non-grid-item card (e.g. a single zone tile inside .gwrap-auto).
  function relTime(ts) {
    if (!ts) return ''; var t = Date.parse(String(ts).replace(' ', 'T')); if (isNaN(t)) return '';
    var s = Math.max(1, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago'; var m = Math.round(s / 60); if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60); if (h < 24) return h + 'h ago'; var d = Math.round(h / 24);
    return d === 1 ? 'Yesterday' : d + 'd ago';
  }
  // UX-C: the per-tile sparkline (miniBars) was a deterministic pseudo-random strip seeded from the
  // figure itself — decoration dressed as data — so the dashboard KPI band is now the same flat
  // tile as every list view (kpi(), above). `chip`/`seed` stay as ignored params for call sites.
  function kpiRich(ic, value, lab) { return kpi(ic, value, lab); }
  // SVG ring gauge / donut. U3: svg + track/value circles carry the real ALEMBIC chart classes
  // (.chart, .arc-track, .arc-val — console.css:260-280 via shell.css "U3" block); only the
  // per-call dynamic bits (color, dasharray) stay inline.
  function ring(pct, center, sub, color) {
    var C = 2 * Math.PI * 52, dash = (C * Math.max(0, Math.min(100, pct)) / 100).toFixed(1) + ' ' + C.toFixed(1);
    return '<div style="position:relative;width:140px;height:140px;margin:0 auto"><svg class="chart" width="140" height="140" viewBox="0 0 140 140" style="transform:rotate(-90deg)" aria-hidden="true">' +
      '<circle class="arc-track" cx="70" cy="70" r="52"/>' +
      '<circle class="arc-val" cx="70" cy="70" r="52" stroke="' + (color || 'var(--accent)') + '" stroke-dasharray="' + dash + '"/></svg>' +
      '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center"><div class="ring-c">' + center + '</div>' +
      '<div class="ring-s">' + (sub || '') + '</div></div></div>';
  }
  function gaugeFor(p, role) {
    if (role === 'production') return [p.planActual.pct, 'Plan attainment'];
    if (role === 'qc') return [p.counts.qcPassRate, 'Pass rate'];
    if (role === 'warehouse') return [p.counts.zoneCapAvg, 'Capacity'];
    if (role === 'admin') return [p.counts.usersTotal ? Math.round(p.counts.usersActive / p.counts.usersTotal * 100) : 0, 'Active users'];
    return [p.planActual.pct, 'Plan vs actual'];
  }
  // UX-C: the old three-card "hero band" (headline figure · three signals · gauge) repeated the
  // four KPI tiles directly above it, and its headline card carried a canned sentence per role
  // ("Purchasing is tracking to plan — supplier lead times are holding…") that no data backed.
  // What it added — the gauge — now sits beside the role's activity panel instead.
  function gaugeCard(p, role) {
    var g = gaugeFor(p, role), gc = g[0] >= 70 ? 'var(--accent)' : (g[0] >= 40 ? 'var(--amber)' : 'var(--red)');
    return gCard({ title: g[1], span: 'c4', body: '<div style="margin:auto 0">' + ring(g[0], g[0] + '%', '', gc) + '</div>' });
  }
  // Side panel — donut / bars / feed / pipeline, real data.
  function sideDonut(p) {
    var q = p.qc, tot = q.pass + q.fail, pct = tot ? Math.round(q.pass / tot * 100) : 0;
    var legend = [['Pass', q.pass, 'var(--green)'], ['Fail', q.fail, 'var(--red)'], ['Pending', q.pending, 'var(--amber)']].map(function (l) {
      return '<div class="kv"><i class="sw-dot" style="background:' + l[2] + '"></i><span class="k">' + l[0] + '</span><span class="v">' + l[1] + '</span></div>';
    }).join('');
    return '<div style="margin:var(--s-tight) 0 var(--s-snug)">' + ring(pct, pct + '%', 'Pass', 'var(--green)') + '</div>' + legend;
  }
  function sideBars(items) {
    return items.map(function (it) {
      return '<div style="padding:var(--s-tight) 0"><div class="kv" style="border:0;padding:0 0 var(--s-tight)"><span class="k">' + it.label + '</span><span class="v">' + it.pct + '%</span></div>' +
        '<div class="meter"><i style="width:' + it.pct + '%;background:' + clsCol(it.cls) + '"></i></div></div>';
    }).join('');
  }
  function sidePipe(items) {
    var max = Math.max.apply(null, items.map(function (i) { return i[1]; })) || 1;
    return items.map(function (it) {
      return '<div class="kv" style="border:0"><span class="k" style="flex:0 0 96px">' + it[0] + '</span>' +
        '<div class="meter" style="flex:1"><i style="width:' + Math.round(it[1] / max * 100) + '%;background:var(--accent)"></i></div>' +
        '<span class="v" style="min-width:28px;text-align:right">' + it[1] + '</span></div>';
    }).join('');
  }
  function sideFeed(items) {
    if (!items.length) return '<div class="empty" style="padding:var(--s-base) 0"><p>No recent activity.</p></div>';
    return items.map(function (it) {
      return '<div class="kv" style="align-items:flex-start"><i class="sw-dot" style="background:' + it.dot + ';margin-top:6px"></i>' +
        '<div style="flex:1;min-width:0"><div style="font:var(--w-reg) var(--t-body)/1.4 var(--font-ui);color:var(--ink)">' + it.text + '</div><div style="font:var(--w-reg) var(--t-cap)/1 var(--font-ui);color:var(--ink-3);margin-top:var(--s-hair)">' + relTime(it.ts) + '</div></div></div>';
    }).join('');
  }
  function sidePanel(p, role) {
    var spec = {
      superadmin: ['Pipeline', 'In progress', sidePipe(p.pipeline)],
      procurement: ['Spend by supplier', 'Share of PO value', sideBars(p.spendByVendor)],
      qc: ['Batch results', 'Today', sideDonut(p)],
      receiving: ['Dock activity', 'Latest first', sideFeed(p.feed)],
      filling: ['Line activity', 'Latest first', sideFeed(p.feed)],
      packaging: ['Packaging activity', 'Latest first', sideFeed(p.feed)],
      admin: ['Audit log', 'Latest first', sideFeed(p.feed)],
      production: ['Pipeline', 'In progress', sidePipe(p.pipeline)],
      compounding: ['Mixing room', 'Latest first', sideFeed(p.feed)],
      sales: ['Dispatch activity', 'Latest first', sideFeed(p.feed)]
    }[role] || ['Activity', 'Latest first', sideFeed(p.feed)];
    return gCard({ title: spec[0], meta: spec[1], span: role === 'superadmin' ? 'c4' : 'c8', top: true, body: '<div>' + spec[2] + '</div>' });
  }
  // Super-Admin chain of custody — the 24-step flow grouped into 10 stages, with the formula-vault
  // masking boundary in its true position (after Formula Selection). Flex layout (no absolute
  // coords) so it stays correct + responsive. Data is live from /v1/dashboard.flow.
  var FLOW_PRE = [['stockPlanning', 'Stock planning', 'list'], ['procurement', 'Procurement', 'clipboard'], ['receiving', 'Receiving', 'truck'], ['qc', 'Quality control', 'flask'], ['storage', 'Inventory storage', 'box']];
  var FLOW_POST = [['compounding', 'Compounding', 'beaker'], ['productionQc', 'Production QC', 'activity'], ['packaging', 'Packaging', 'pkg'], ['salesDispatch', 'Sales & dispatch', 'truck']];
  var ARROW_R = '<span style="display:grid;place-items:center;color:var(--ink-3);flex:none;align-self:center" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>';
  var ARROW_D = '<div style="display:flex;justify-content:center;padding:var(--s-hair) 0;color:var(--ink-3)" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg></div>';
  function stageCard(num, name, ic, stage, masked) {
    stage = stage || { count: 0, codes: [] };
    var codes = (stage.codes || []).map(function (c) {
      return '<div style="display:flex;flex-direction:column;padding:3px 0"><span style="font:var(--w-med) var(--t-cap)/1.3 var(--font-mono);color:' + (masked ? 'var(--ink-2)' : 'var(--accent-ink)') + '">' + c.code + '</span><span style="font:var(--w-reg) var(--t-micro)/1.3 var(--font-ui);color:var(--ink-3)">' + c.sub + '</span></div>';
    }).join('') || '<div style="font:var(--w-reg) var(--t-cap)/1 var(--font-ui);color:var(--ink-3);padding:3px 0">—</div>';
    return '<div style="flex:1;min-width:152px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:var(--s-snug)">' +
      '<div style="display:flex;align-items:center;gap:var(--s-tight);margin-bottom:var(--s-tight)">' +
      '<span style="width:22px;height:22px;border-radius:var(--r-sm);background:var(--accent-soft);color:var(--accent-ink);display:grid;place-items:center;font:var(--w-med) var(--t-micro)/1 var(--font-ui);flex:none">' + num + '</span>' +
      '<span style="display:grid;place-items:center;color:var(--ink-2);flex:none">' + icon(ic, 14) + '</span>' +
      '<span style="font:var(--w-med) var(--t-cap)/1.15 var(--font-ui);flex:1">' + name + '</span>' +
      '<span style="font:var(--w-reg) var(--t-micro)/1 var(--font-mono);color:var(--ink-3);flex:none">' + stage.count + '</span></div>' + codes + '</div>';
  }
  function flowRow(metas, p, start, masked) {
    var parts = [];
    metas.forEach(function (m, i) {
      parts.push(stageCard(start + i, m[1], m[2], p.flow[m[0]], masked));
      if (i < metas.length - 1) parts.push(ARROW_R);
    });
    return '<div style="display:flex;align-items:stretch;gap:var(--s-tight);flex-wrap:wrap">' + parts.join('') + '</div>';
  }
  function flowGraph(p) {
    var rev = p.reveal.product, fv = p.flow.formula || { count: 0, codes: [] };
    var fcodes = (fv.codes || []).map(function (c) { return c.code; }).join(' · ');
    var sub = rev ? ('Selects ' + (fcodes || 'the formula') + '. Aliases only below this point.') : (fv.count + ' formulas sealed');
    var vault = '<div style="display:flex;align-items:center;gap:var(--s-snug);background:var(--accent);color:var(--ink);border-radius:var(--r-md);padding:var(--s-snug) var(--s-base)">' +
      '<span style="width:40px;height:40px;border-radius:var(--r-md);background:rgba(255,255,255,.35);display:grid;place-items:center;flex:none">' + icon('lock', 20) + '</span>' +
      '<div style="flex:1;min-width:0"><div style="font:var(--w-med) var(--t-h3)/1.2 var(--font-ui)">6 · Formula selection</div>' +
      '<div style="font:var(--w-reg) var(--t-cap)/1.35 var(--font-ui);margin-top:var(--s-hair)">' + sub + '</div></div>' +
      '<span style="font:var(--w-reg) var(--t-micro)/1 var(--font-mono);flex:none">' + fv.count + ' formulas</span></div>';
    function divider(txt, col) { return '<div style="display:flex;align-items:center;gap:var(--s-tight);margin:var(--s-tight) 0"><span style="font:var(--w-med) var(--t-micro)/1 var(--font-ui);color:' + col + ';letter-spacing:var(--ls-wide);text-transform:uppercase;flex:none">' + txt + '</span><div style="flex:1;height:1px;background:var(--line)"></div></div>'; }
    return gCard({ title: 'Chain of custody', meta: 'Stock planning to delivery · ' + (rev ? 'identity visible' : 'anonymised'), span: 'c12', top: true, body: '<div>' +
      divider('Identity visible', 'var(--ink-3)') +
      flowRow(FLOW_PRE, p, 1, false) +
      ARROW_D + vault + ARROW_D +
      divider('Aliases only', 'var(--ink-3)') +
      flowRow(FLOW_POST, p, 7, true) +
      '</div>' });
  }
  function runsTable(p) {
    // U3b: real Data table grammar (shell.css thead th/tbody td) inside .card-bd; .tscroll lets a
    // wide table scroll inside its own card instead of pushing the page wide.
    var head = ['Run', 'Product', 'Stage', 'Batch', 'Target', 'Status'].map(function (h) { return '<th>' + h + '</th>'; }).join('');
    var body = p.runs.map(function (r) {
      return '<tr><td class="mono">' + r.run + '</td>' +
        '<td>' + r.product + '</td>' +
        '<td>' + r.stage + '</td>' +
        '<td class="mono">' + r.batch + '</td>' +
        '<td>' + r.target + '</td>' +
        '<td>' + fmt('status', r.status) + '</td></tr>';
    }).join('');
    return gCard({ title: 'Master runs', meta: p.runs.length + ' runs', span: 'c8', top: true, body: '<div class="tscroll"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' });
  }
  // Warehouse floor zone map — real zones + rack counts + batch occupancy.
  function warehouseMap(p) {
    // U3b: zone tiles are a dynamic-length collection, so they sit in .gwrap-auto as .gcard.glass
    // surfaces rather than a fixed c-span.
    var zones = p.zones.map(function (z) {
      var capCol = z.capPct >= 85 ? 'var(--red)' : (z.capPct >= 65 ? 'var(--amber)' : 'var(--accent)');
      var cells = ''; for (var i = 0; i < 12; i++) { var on = i < Math.round(z.capPct / 100 * 12); cells += '<i style="border-radius:var(--r-sm);height:16px;background:' + (on ? clsCol(z.cls) : 'var(--panel-3)') + '"></i>'; }
      return gCard({ span: 'c4', title: z.name, meta: z.racks + ' racks · ' + z.batches + ' batches', body:
        '<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:5px" aria-hidden="true">' + cells + '</div>' +
        '<div class="kv" style="border:0;padding:0"><span class="k">Capacity used</span><span class="v" style="color:' + (capCol === 'var(--accent)' ? 'var(--ink)' : capCol) + '">' + z.capPct + '%</span></div>' +
        '<div class="meter"><i style="width:' + z.capPct + '%;background:' + capCol + '"></i></div>' +
        (z.code === 'Z4' ? '<span class="chip r" style="align-self:flex-start">Flammable</span>' : '')
      });
    }).join('');
    // UX-C: the "Storage workload" bar chart beside this card was pseudo-random bars under a fixed
    // 06:00/12:00/18:00 axis — no hourly data exists behind it — so it is gone; the floor summary
    // (real counts) now spans the row.
    var floorSummary = gCard({ title: 'Floor summary', span: 'c12', top: true, body: '<div>' +
      [['SKUs stored', p.counts.skusStored], ['Units on hand', p.counts.invOnHand], ['Storage zones', p.counts.zones], ['Racks', p.counts.racks]].map(function (r) {
        return '<div class="kv"><span class="k">' + r[0] + '</span><span class="v">' + r[1] + '</span></div>';
      }).join('') + '</div>' });
    return '<div class="gwrap">' + zones + '</div><div class="gwrap">' + floorSummary + '</div>';
  }
  // Per-role KPI set (4 cards) computed from the real counts payload.
  function kpiSet(p, role) {
    var c = p.counts;
    var S = {
      superadmin: [['layers', c.runsActive, 'Active runs'], ['flask', c.qcQueue, 'Batches in QC'], ['pkg', c.unitsPacked.toLocaleString(), 'Units packed'], ['activity', p.planActual.pct + '%', 'Plan attainment']],
      admin: [['users', c.usersTotal, 'Total users'], ['shield', c.usersActive, 'Active'], ['lock', c.roles, 'Roles defined'], ['bell', c.usersTotal - c.usersActive, 'Pending']],
      procurement: [['clipboard', c.posOpen, 'Open POs'], ['bell', c.posPending, 'Pending approvals'], ['truck', c.vendors, 'Suppliers'], ['box', c.materials, 'Materials']],
      receiving: [['truck', c.grns, 'Goods receipts'], ['layers', c.rmBatches, 'RM batches'], ['box', c.invOnHand, 'Units on hand'], ['flask', c.qcQueue, 'Awaiting QC']],
      qc: [['flask', c.qcQueue, 'In queue'], ['activity', c.qcPass, 'Passed'], ['alert', c.qcFail, 'Failed'], ['shield', c.qcPassRate + '%', 'Pass rate']],
      warehouse: [['box', c.skusStored, 'SKUs stored'], ['layers', c.invOnHand, 'Units on hand'], ['shelf', c.racks, 'Racks'], ['grid', c.zoneCapAvg + '%', 'Avg capacity']],
      production: [['layers', c.runsActive, 'Active runs'], ['flask', c.qcQueue, 'Batches in QC'], ['droplet', c.oilBatches, 'Oil batches'], ['activity', p.planActual.pct + '%', 'Plan attainment']],
      compounding: [['beaker', c.mixing, 'Mixing sessions'], ['layers', c.runsActive, 'Active runs'], ['droplet', c.oilBatches, 'Oil batches'], ['activity', p.planActual.pct + '%', 'Plan attainment']],
      filling: [['droplet', c.fillSessions, 'Fill sessions'], ['activity', c.unitsFilled.toLocaleString(), 'Units filled'], ['layers', c.oilBatches, 'Bulk lots'], ['box', c.packageOrders, 'Pack orders']],
      packaging: [['box', c.packageOrders, 'Pack orders'], ['pkg', c.fgBatches, 'Finished batches'], ['activity', c.unitsPacked.toLocaleString(), 'Units packed'], ['truck', c.salesOrders, 'Sales orders']],
      sales: [['clipboard', c.salesOrders, 'Sales orders'], ['truck', (p.flow.salesDispatch && p.flow.salesDispatch.dispatched) || 0, 'Dispatched'], ['users', c.customers, 'Customers'], ['pkg', c.fgBatches, 'Finished goods']]
    };
    return (S[role] || S.superadmin).map(function (k) { var v = String(k[1]); return [k[0], v, k[2], '', (parseInt(v, 10) || v.length) * 13 + 3]; });
  }
  async function loadDashboard() {
    var V = $('ra-view'); V.innerHTML = '<div class="loading">Loading…</div>';
    var res;
    try { res = await tunnel('/v1/dashboard'); } catch (e) { V.innerHTML = errBox('Can\'t connect. Try again.'); return; }
    if (res.status === 403) { V.innerHTML = errBox('No dashboard for this role yet.'); return; }
    var p = res.json && res.json.data;
    if (!p) { V.innerHTML = errBox('The dashboard came back empty.'); return; }
    st.dash = p;
    var role = st.role, kset = kpiSet(p, role);
    var kpis = '<div class="stats">' + kset.map(function (k) { return kpiRich(k[0], k[1], k[2], k[3], k[4]); }).join('') + '</div>';
    // "My work" — the role's actionable queue at the top of the home (tap a tile to jump to the screen that resolves it)
    var ad = null; try { var ar = await tunnel('/v1/alerts'); ad = ar && ar.json && ar.json.data; } catch (e) {}
    var html = myWorkPanel(ad) + kpis;
    if (role === 'warehouse') {
      html += warehouseMap(p);
    } else if (role === 'superadmin') {
      // U3b: .gwrap c8/c4 (shell.css "U3b" block) — real GCard grid row, collapsing to one
      // card per row at <=1023 on its own; no data-grid/applyDashCols.
      html += '<div class="gwrap">' + flowGraph(p) + '</div>' +
        '<div class="gwrap">' + runsTable(p) + sidePanel(p, role) + '</div>';
    } else {
      html += '<div class="gwrap">' + sidePanel(p, role) + gaugeCard(p, role) + '</div>';
    }
    V.innerHTML = html;
    wireExpand(V);
    [].forEach.call(document.querySelectorAll('#ra-view [data-work-nav]'), function (el) {
      el.onclick = function () { navTo(el.getAttribute('data-work-nav')); };
    });
  }
  // The role's actionable queue: clickable tiles from the role-filtered alerts.
  function myWorkPanel(ad) {
    var alerts = (ad && ad.alerts) || [];
    var inner;
    if (!alerts.length) inner = '<p style="margin:0;font:var(--w-reg) var(--t-body)/var(--lh-body) var(--font-ui);color:var(--ink-3)">Nothing needs action.</p>';
    else inner = '<div style="display:flex;gap:var(--s-snug);flex-wrap:wrap">' + alerts.map(function (a) {
      // Low severity used to print in --accent (#E9F260) on a near-white tile — ~1.2:1. Its ink
      // counterpart keeps the same hue family at a readable contrast.
      var col = a.severity === 'high' ? 'var(--red)' : (a.severity === 'med' ? 'var(--amber)' : 'var(--accent-ink)');
      var nk = alertNavKey(a.kind);
      var tag = nk ? 'button type="button"' : 'div';
      return '<' + tag + (nk ? ' data-work-nav="' + nk + '"' : '') + ' class="work-tile" style="flex:1;min-width:168px;text-align:left;border-radius:var(--r-md);padding:var(--s-snug)">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:var(--s-tight)"><span style="font:var(--w-med) var(--t-micro)/1.2 var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:' + col + '">' + a.title + '</span><span style="font:var(--w-med) var(--t-h1)/1 var(--font-ui);color:' + col + '">' + a.count + '</span></div>' +
        '<div style="font:var(--w-reg) var(--t-cap)/1.35 var(--font-ui);color:var(--ink-3);margin-top:var(--s-hair)">' + a.sub + (nk ? ' &rsaquo;' : '') + '</div></' + (nk ? 'button' : 'div') + '>';
    }).join('') + '</div>';
    // U3b: real .card/.card-hd/.card-bd grammar for the outer panel; the hover feedback on a
    // clickable tile moves from inline onmouseover/onmouseout box-shadow swaps (the legacy
    // --ins-sm/--rai-sm shim) to a plain CSS rule on [data-work-nav] (shell.css "U3b" block).
    return '<div class="gwrap strip" style="margin-bottom:var(--gr-gap)">' + gCard({ title: 'My work', meta: alerts.length ? alerts.length + ' queues need action' : '', span: 'c12', expand: false, body: inner }) + '</div>';
  }
  /* ---------------- flow actions: existing POST routes wired to per-row buttons ---------------- */
  // The role must hold the permission (owner/super_admin hold all) AND the row must be in the
  // action's precondition status. The backend re-checks both — this is UX only.
  function can(perm) {
    if (!session) return false;
    var rs = session.roles || []; if (rs.indexOf('owner') >= 0 || rs.indexOf('super_admin') >= 0) return true;
    var ps = session.perms || [];
    if (!ps.length) return true; // JWT carries no permission list → don't gate client-side; the backend enforces (403 → toast)
    return ps.indexOf('*') >= 0 || ps.indexOf(perm) >= 0;
  }
  var UP = function (v) { return String(v == null ? '' : v).toUpperCase(); };
  // Segregation of duties: a document's creator may not approve it (the backend enforces this
  // authoritatively; this just hides the button so the button isn't offered in the first place).
  function isCreator(r) { return !!(r && session && session.user && r.createdBy && r.createdBy === session.user.userId); }
  var ACTIONS = {
    '/v1/reorder-suggestions': [
      { label: 'Raise requirement', perm: 'procurement:stock_requirement:write', when: function (r) { return Number(r.shortage) > 0; }, run: function (r) { openRaiseRequirement(r); } }
    ],
    '/v1/roles': [
      { label: 'Assign perms', perm: 'iam:role_permission_mapping:write', when: function () { return true; }, run: function (r) { openAssignPerm(r); } }
    ],
    '/v1/user-roles': [
      { label: 'Revoke', perm: 'iam:user_role_mapping:write', tone: 'bad', when: function () { return true; }, run: function (r) {
        raConfirm('Revoke this role assignment? It takes effect on the user\'s next sign-in / token refresh.', function () {
          tunnel('/v1/user-roles/' + (r.userRoleMappingId != null ? r.userRoleMappingId : guessId(r)), { method: 'DELETE' }).then(function (res) {
            if (res.status >= 400) { toast((res.json && res.json.error && res.json.error.message) || 'Failed', 'bad'); return; }
            toast('Revoked', 'good'); loadView();
          }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
        }, { title: 'Revoke role assignment', confirmLabel: 'Revoke', tone: 'bad' });
      } }
    ],
    '/v1/role-permissions': [
      { label: 'Revoke', perm: 'iam:role_permission_mapping:write', tone: 'bad', when: function () { return true; }, run: function (r) {
        raConfirm('Revoke this permission from the role?', function () {
          tunnel('/v1/role-permissions/' + (r.rolePermissionMappingId != null ? r.rolePermissionMappingId : guessId(r)), { method: 'DELETE' }).then(function (res) {
            if (res.status >= 400) { toast((res.json && res.json.error && res.json.error.message) || 'Failed', 'bad'); return; }
            toast('Revoked', 'good'); loadView();
          }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
        }, { title: 'Revoke permission', confirmLabel: 'Revoke', tone: 'bad' });
      } }
    ],
    '/v1/dispatches': [
      { label: 'Mark delivered', perm: 'sales:dispatch_master:write', tone: 'good', when: function (r) { return UP(r.status) !== 'DELIVERED'; }, run: function (r) { markDelivered(r); } }
    ],
    '/v1/stock-reservations': [
      { label: 'Release', perm: 'inventory:stock_reservation:write', tone: 'warn', when: function (r) { return UP(r.status) !== 'RELEASED'; }, run: function (r) {
        var id = r.stockReservationId != null ? r.stockReservationId : guessId(r);
        tunnel('/v1/masters/reservations/' + id, { method: 'PATCH', body: { status: 'RELEASED' } }).then(function (res) {
          if (res.status >= 400) { toast((res.json && res.json.error && res.json.error.message) || 'Failed', 'bad'); return; }
          toast('Released', 'good'); loadView();
        }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
      } }
    ],
    '/v1/purchase-requests': [
      { label: 'Submit', perm: 'procurement:purchase_request:write', when: function (r) { return UP(r.status) === 'DRAFT'; }, path: function (r) { return '/v1/purchase-requests/' + r.purchaseRequestId + '/submit'; }, body: { approvalLevel: 1 } },
      { label: 'Approve', perm: 'procurement:purchase_request:write', tone: 'good', when: function (r) { return UP(r.status) === 'SUBMITTED' && !isCreator(r); }, path: function (r) { return '/v1/purchase-requests/' + r.purchaseRequestId + '/approve'; }, body: {} },
      { label: 'Reject', perm: 'procurement:purchase_request:write', tone: 'bad', when: function (r) { return ['DRAFT', 'SUBMITTED'].indexOf(UP(r.status)) >= 0; }, run: function (r) { rejectDoc('purchase-requests', 'purchaseRequestId', r); } }
    ],
    '/v1/purchase-orders': [
      { label: 'Approve', perm: 'procurement:purchase_order:write', tone: 'good', when: function (r) { return UP(r.status) === 'DRAFT' && !isCreator(r); }, path: function (r) { return '/v1/purchase-orders/' + r.purchaseOrderId + '/approve'; }, body: {} },
      { label: 'Issue', perm: 'procurement:purchase_order:write', when: function (r) { return ['ISSUED', 'ACKNOWLEDGED', 'DRAFT', 'REJECTED', 'CANCELLED', 'AMENDED'].indexOf(UP(r.status)) < 0; }, path: function (r) { return '/v1/purchase-orders/' + r.purchaseOrderId + '/issue'; }, body: {} },
      { label: 'Acknowledge', perm: 'procurement:purchase_order:write', when: function (r) { return UP(r.status) === 'ISSUED'; }, path: function (r) { return '/v1/purchase-orders/' + r.purchaseOrderId + '/acknowledge'; }, body: {} },
      { label: 'Reject', perm: 'procurement:purchase_order:write', tone: 'bad', when: function (r) { return ['DRAFT', 'PENDING', 'PENDING_APPROVAL', 'ISSUED'].indexOf(UP(r.status)) >= 0; }, run: function (r) { rejectDoc('purchase-orders', 'purchaseOrderId', r); } },
      // G2/V4 §113: a non-DRAFT PO can't be edited directly (409) — Amend raises a new DRAFT
      // revision linked to this one instead, which needs re-approval.
      { label: 'Amend', perm: 'procurement:purchase_order:write', tone: 'accent', when: function (r) { return ['DRAFT', 'CANCELLED', 'AMENDED'].indexOf(UP(r.status)) < 0; }, run: function (r) { amendPurchaseOrder(r); } },
      { label: 'Cancel', perm: 'procurement:purchase_order:write', tone: 'bad', when: function (r) { return ['CANCELLED', 'AMENDED'].indexOf(UP(r.status)) < 0; }, run: function (r) { cancelPurchaseOrderFlow(r); } }
    ],
    '/v1/rm-batches': [
      { label: 'QR label', perm: 'inventory:rm_batch_master:read', tone: 'accent', when: function () { return true; }, run: function (r) { openQrLabel('Batch ' + (r.batchNumber || ''), (r.batchNumber || String(r.rmBatchId).slice(0, 8)), 'RA-BATCH:' + (r.batchNumber || '') + ':' + r.rmBatchId, 'RM batch'); } },
      { label: 'Release to stock', perm: 'inventory:rm_batch_master:write', when: function (r) { return UP(r.status) !== 'RELEASED'; }, path: function (r) { return '/v1/rm-batches/' + r.rmBatchId + '/release'; }, body: {} }
    ],
    '/v1/grn-containers': [
      { label: 'QR label', perm: 'inventory:grn_container:read', tone: 'accent', when: function () { return true; }, run: function (r) { openQrLabel('Container ' + (r.containerCode || ''), (r.containerCode || String(r.grnContainerId).slice(0, 8)), 'RA-CONTAINER:' + (r.containerCode || '') + ':' + r.grnContainerId, 'GRN ' + (r.grnNumber || '') + (r.containerQty != null ? ' · ' + r.containerQty : '')); } }
    ],
    '/v1/qc-rejected-grns': [
      { label: 'Replacement PO', perm: 'procurement:purchase_order:write', tone: 'accent', when: function () { return true; }, run: function (r) { generateReplacementPo(r); } }
    ],
    '/v1/rfqs': [
      { label: 'Send to vendors', perm: 'procurement:rfq_master:write', tone: 'accent', when: function (r) { return UP(r.status) !== 'SENT' && UP(r.status) !== 'CLOSED'; }, run: function (r) { setStatus('rfqs', 'rfqId', r, 'SENT', 'Sent to vendors'); } }
    ],
    '/v1/quotations': [
      { label: 'Select as final vendor', perm: 'procurement:quotation_items:write', tone: 'good', when: function (r) { return UP(r.status) !== 'SELECTED'; }, run: function (r) { setStatus('quotations', 'quotationId', r, 'SELECTED', 'Vendor selected'); } }
    ],
    '/v1/qc-inspections': [
      // once dispositioned, the inspection's overallResult becomes the code → hide the buttons.
      { label: 'Record results', perm: 'quality:qc_inspections:write', tone: 'accent', when: function (r) { return ['ACCEPT', 'REJECT', 'REWORK', 'HOLD'].indexOf(UP(r.overallResult)) < 0; }, run: function (r) { openRecordQc(r); } },
      { label: 'Accept', perm: 'quality:qc_inspections:write', tone: 'good', when: function (r) { return ['ACCEPT', 'REJECT', 'REWORK', 'HOLD'].indexOf(UP(r.overallResult)) < 0; }, path: function (r) { return '/v1/qc-inspections/' + r.qcInspectionId + '/disposition'; }, body: { dispositionCode: 'ACCEPT' } },
      { label: 'Reject', perm: 'quality:qc_inspections:write', tone: 'bad', when: function (r) { return ['ACCEPT', 'REJECT', 'REWORK', 'HOLD'].indexOf(UP(r.overallResult)) < 0; }, path: function (r) { return '/v1/qc-inspections/' + r.qcInspectionId + '/disposition'; }, body: { dispositionCode: 'REJECT' } },
      { label: 'Hold', perm: 'quality:qc_inspections:write', tone: 'warn', when: function (r) { return ['ACCEPT', 'REJECT', 'REWORK', 'HOLD'].indexOf(UP(r.overallResult)) < 0; }, path: function (r) { return '/v1/qc-inspections/' + r.qcInspectionId + '/disposition'; }, body: { dispositionCode: 'HOLD' } },
      { label: 'Rework', perm: 'quality:qc_inspections:write', tone: 'warn', when: function (r) { return ['ACCEPT', 'REJECT', 'REWORK', 'HOLD'].indexOf(UP(r.overallResult)) < 0; }, path: function (r) { return '/v1/qc-inspections/' + r.qcInspectionId + '/disposition'; }, body: { dispositionCode: 'REWORK' } }
    ],
    '/v1/mixing-sessions': [
      // OPS-GREEN Act L: WEIGH before MIX — the server resolves the line's target from the coded
      // instruction and refuses to end a session with an unweighed line.
      { label: 'Record weighing', perm: 'production:secure_mixing_session:write', tone: 'accent', when: function (r) { return UP(r.status).indexOf('PROGRESS') >= 0; }, run: function (r) { recordWeighing(r); } },
      { label: 'End session', perm: 'production:secure_mixing_session:write', when: function (r) { return UP(r.status).indexOf('PROGRESS') >= 0; }, path: function (r) { return '/v1/mixing-sessions/' + r.secureMixingSessionId + '/end'; }, body: {} }
    ],
    '/v1/filling-sessions': [
      { label: 'End fill', perm: 'packaging:filling_session:write', when: function (r) { return UP(r.status) !== 'DONE'; }, path: function (r) { return '/v1/filling-sessions/' + r.fillingSessionId + '/end'; }, body: {} }
    ],
    '/v1/production-orders': [
      { label: 'Generate pick list', perm: 'production:material_pick_list:write', when: function (r) { return ['INPROGRESS', 'PLANNING'].indexOf(UP(r.status)) >= 0; }, path: function (r) { return '/v1/production-orders/' + r.productionOrderId + '/pick-list'; }, body: {} }
    ],
    '/v1/sales-orders': [
      // G1/PB-08: sales orders should originate from the ALEMBIC bridge — confirming one here
      // is a break-glass continuity action (owner/admin only, sales:manual_continuity:write)
      // and always asks for a reason (see confirmSalesOrderManual, ws-mfg.js), audited server-side.
      { label: 'Confirm', perm: 'sales:manual_continuity:write', tone: 'good', when: function (r) { return UP(r.status) === 'DRAFT'; }, run: function (r) { confirmSalesOrderManual(r); } },
      { label: 'Dispatch', perm: 'sales:dispatch_master:write', when: function (r) { return UP(r.status) === 'CONFIRMED'; }, run: function (r) { openDispatch(r); } }
    ],
    '/v1/fg-reservations': [
      { label: 'Release', perm: 'packaging:finished_good_batch_master:write', tone: 'warn', when: function (r) { return UP(r.status) !== 'RELEASED'; }, path: function (r) { return '/v1/fg-reservations/' + (r.finishedGoodReservationId != null ? r.finishedGoodReservationId : guessId(r)) + '/release'; }, body: {} }
    ],
    '/v1/users': [
      { label: 'Assign role', perm: 'iam:user_role_mapping:write', when: function () { return true; }, run: function (r) { openAssignRole(r); } }
    ],
    '/v1/finished-good-batches': [
      // §109.7: the backend trace route (v1/trace/finished-good/:id) self-masks — it no
      // longer requires formula:actual:read (that would 403 every factory role, owner
      // included, since only formulator/vault_approver hold it now). Gate the button on
      // read-access to the FG resource itself; the server decides per-caller whether the
      // product/material names come back real or masked (alias/'Protected ◆').
      { label: 'Trace', perm: 'packaging:finished_good_batch_master:read', when: function () { return true; }, run: function (r) { openTrace(r); } },
      // OPS-GREEN Act L: LABEL before packaging QC (the label check cannot PASS unlabelled).
      { label: 'Apply labels', perm: 'packaging:finished_good_batch_master:write', tone: 'accent', when: function () { return true; }, run: function (r) { applyFgLabels(r); } }
    ],
    '/v1/oil-batches': [
      // Guarded lifecycle (server enforces the state machine; these `when` guards are UX only).
      { label: 'Start maturation', perm: 'production:oil_batch_master:write', when: function (r) { return ['IN_MATURATION', 'MATURING', 'RELEASED'].indexOf(UP(r.status)) < 0; }, path: function (r) { return '/v1/oil-batches/' + r.oilBatchId + '/transition'; }, body: { status: 'IN_MATURATION' } },
      { label: 'Release', perm: 'production:oil_batch_master:write', tone: 'good', when: function (r) { return ['IN_MATURATION', 'MATURING', 'HOLD'].indexOf(UP(r.status)) >= 0; }, path: function (r) { return '/v1/oil-batches/' + r.oilBatchId + '/transition'; }, body: { status: 'RELEASED' } },
      { label: 'Hold', perm: 'production:oil_batch_master:write', tone: 'warn', when: function (r) { return ['RELEASED', 'HOLD'].indexOf(UP(r.status)) < 0; }, path: function (r) { return '/v1/oil-batches/' + r.oilBatchId + '/transition'; }, body: { status: 'HOLD' } },
      { label: 'Rework', perm: 'production:oil_batch_master:write', tone: 'warn', when: function (r) { return ['RELEASED', 'FAILED', 'REWORK'].indexOf(UP(r.status)) < 0; }, path: function (r) { return '/v1/oil-batches/' + r.oilBatchId + '/transition'; }, body: { status: 'REWORK' } },
      { label: 'Fail', perm: 'production:oil_batch_master:write', tone: 'bad', when: function (r) { return ['RELEASED', 'FAILED'].indexOf(UP(r.status)) < 0; }, path: function (r) { return '/v1/oil-batches/' + r.oilBatchId + '/transition'; }, body: { status: 'FAILED' } }
    ]
  };
  /* ---------------- edit / correct / deactivate (cross-cutting; PATCH /v1/masters/:resource/:id) ---------------- */
  // Row-click detail drill-downs: header fields + (optionally) the record's line items.
  var DETAIL = {
    '/v1/purchase-requests': { title: 'Purchase request', idKey: 'purchaseRequestId' },
    '/v1/purchase-orders': { title: 'Purchase order', idKey: 'purchaseOrderId', items: { ep: '/v1/purchase-order-items', fk: 'purchaseOrderId', cols: ['materialName', 'orderedQty', 'rate', 'amount', 'status'] } },
    '/v1/quotations': { title: 'Quotation', idKey: 'quotationId', items: { ep: '/v1/quotation-items', fk: 'quotationId', cols: ['materialName', 'quotedQty', 'quotedRate', 'status'] } },
    '/v1/sales-orders': { title: 'Sales order', idKey: 'salesOrderId', items: { ep: '/v1/sales-order-items', fk: 'salesOrderId', cols: ['orderedQty', 'rate', 'amount', 'status'] } },
    '/v1/grns': { title: 'Goods receipt', idKey: 'grnId', items: { ep: '/v1/grn-items', fk: 'grnId', cols: ['orderedQty', 'receivedQty', 'acceptedQty', 'rejectedQty', 'damagedQty', 'varianceType'] } },
  };
  var EDIT = {
    '/v1/materials': { resource: 'materials', idKey: 'materialId', perm: 'masterdata:material:write', statusField: 'status', title: 'Edit material',
      fields: [{ n: 'materialName', l: 'Material name' }, { n: 'uomId', l: 'Unit', fk: '/v1/uoms', fv: 'uomId', fl: 'uomCode' },
        { n: 'scientificName', l: 'Scientific name' }, { n: 'casNumber', l: 'CAS number' }, { n: 'density', l: 'Density', t: 'number' }, { n: 'shelfLifeDays', l: 'Shelf life (days)', t: 'number' },
        { n: 'reorderLevel', l: 'Reorder level', t: 'number' }, { n: 'minStock', l: 'Min stock', t: 'number' }, { n: 'maxStock', l: 'Max stock', t: 'number' },
        { n: 'qcRequired', l: 'QC required?', t: 'select', en: ['true', 'false'] }, { n: 'description', l: 'Description', t: 'textarea' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/stock-requirements': { resource: 'stock-requirements', idKey: 'stockRequirementId', perm: 'procurement:stock_requirement:write', statusField: 'status', title: 'Edit requirement',
      fields: [{ n: 'requiredQty', l: 'Required qty', t: 'number' }, { n: 'priority', l: 'Priority', t: 'select', en: ['HIGH', 'MEDIUM', 'LOW'] }, { n: 'requiredByDate', l: 'Required by', t: 'date' }, { n: 'status', l: 'Status', t: 'select', en: ['OPEN', 'CLOSED'] }] },
    '/v1/vendor-contacts': { resource: 'vendor-contacts', idKey: 'vendorContactId', perm: 'procurement:vendor_contact:write', statusField: 'status', title: 'Edit vendor contact',
      fields: [{ n: 'contactName', l: 'Name' }, { n: 'contactType', l: 'Contact type', t: 'select', en: ['PRIMARY', 'SECONDARY', 'PURCHASE', 'ACCOUNTS', 'TECHNICAL'] }, { n: 'designation', l: 'Designation' }, { n: 'email', l: 'Email' }, { n: 'mobileNumber', l: 'Mobile' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/vendor-rm-mappings': { resource: 'vendor-rm-mappings', idKey: 'vendorRmMappingId', perm: 'procurement:vendor_rm_mapping:write', statusField: 'status', title: 'Edit material↔supplier',
      fields: [{ n: 'isPreferred', l: 'Preferred supplier', t: 'select', en: ['true', 'false'] }, { n: 'leadTimeDays', l: 'Lead time (days)', t: 'number' }, { n: 'minOrderQty', l: 'Min order qty (MOQ)', t: 'number' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/contacts': { resource: 'contacts', idKey: 'contactId', perm: 'platform:contact_master:write', statusField: 'status', title: 'Edit contact',
      fields: [{ n: 'contactName', l: 'Name' }, { n: 'email', l: 'Email' }, { n: 'mobileNumber', l: 'Mobile' }, { n: 'phone', l: 'Phone' }, { n: 'whatsapp', l: 'WhatsApp' }, { n: 'facebook', l: 'Facebook' }, { n: 'instagram', l: 'Instagram' }, { n: 'xHandle', l: 'X (Twitter)' }, { n: 'linkedin', l: 'LinkedIn' }, { n: 'preferredLanguage', l: 'Preferred language' }, { n: 'preferredContactMethod', l: 'Preferred contact', t: 'select', en: ['EMAIL', 'PHONE', 'WHATSAPP', 'SMS'] }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/qc-parameters': { resource: 'qc-parameters', idKey: 'qcParameterId', perm: 'quality:qc_parameter_master:write', statusField: 'status', title: 'Edit QC parameter',
      fields: [{ n: 'parameterCode', l: 'Code' }, { n: 'parameterName', l: 'Name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/countries': { resource: 'countries', idKey: 'countryId', perm: 'platform:country_master:write', statusField: 'status', title: 'Edit country',
      fields: [{ n: 'countryName', l: 'Country name' }, { n: 'currencyId', l: 'Currency', t: 'select', fk: '/v1/currencies', fv: 'currencyId', fl: 'currencyCode' }, { n: 'timezone', l: 'Time zone (e.g. Asia/Kolkata)' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/organizations': { resource: 'organizations', idKey: 'id', perm: 'iam:business_unit_master:write', statusField: 'status', editPath: function (id) { return '/v1/organizations/' + id; }, title: 'Edit organization',
      fields: [{ n: 'type', l: 'Type', t: 'select', en: ['GROUP', 'COMPANY', 'SUBSIDIARY'] }, { n: 'name', l: 'Name' }, { n: 'reraNo', l: 'Registration no.' }, { n: 'gstin', l: 'GSTIN', maxlen: 15, pat: '[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]', patMsg: 'GSTIN must be 15 characters, e.g. 29ABCDE1234F1Z5' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/locations': { resource: 'locations', idKey: 'locationId', perm: 'location:location_master:write', statusField: 'status', title: 'Edit location',
      fields: [{ n: 'locationCode', l: 'Code' }, { n: 'locationName', l: 'Name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/location-types': { resource: 'location-types', idKey: 'locationTypeId', perm: 'location:location_type_master:write', statusField: 'status', title: 'Edit location type',
      fields: [{ n: 'typeCode', l: 'Code' }, { n: 'typeName', l: 'Name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/uoms': { resource: 'uoms', idKey: 'uomId', perm: 'platform:uom_master:write', statusField: 'status', title: 'Edit unit',
      fields: [{ n: 'uomCode', l: 'Unit code' }, { n: 'uomName', l: 'Unit name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/business-units': { resource: 'business-units', idKey: 'businessUnitId', perm: 'iam:business_unit_master:write', statusField: 'status', title: 'Edit business unit',
      fields: [{ n: 'businessUnitName', l: 'Name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/material-types': { resource: 'material-types', idKey: 'materialTypeId', perm: 'masterdata:material_type_master:write', statusField: 'status', title: 'Edit material type',
      fields: [{ n: 'typeName', l: 'Type name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/material-categories': { resource: 'material-categories', idKey: 'materialCategoryId', perm: 'masterdata:material_category_master:write', statusField: 'status', title: 'Edit material category',
      fields: [{ n: 'categoryName', l: 'Category name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/material-subcategories': { resource: 'material-subcategories', idKey: 'materialSubcategoryId', perm: 'masterdata:material_subcategory_master:write', statusField: 'status', title: 'Edit sub-category',
      fields: [{ n: 'subCategoryCode', l: 'Code' }, { n: 'subCategoryName', l: 'Name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/material-groups': { resource: 'material-groups', idKey: 'materialGroupId', perm: 'masterdata:material_group:write', statusField: 'status', title: 'Edit material group',
      fields: [{ n: 'groupCode', l: 'Code' }, { n: 'groupName', l: 'Name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/material-qc-specifications': { resource: 'material-qc-specifications', idKey: 'materialQcSpecificationId', perm: 'masterdata:material_qc_specifications:write', statusField: 'status', title: 'Edit material QC spec',
      fields: [{ n: 'minValue', l: 'Min value', t: 'number' }, { n: 'maxValue', l: 'Max value', t: 'number' }, { n: 'targetValue', l: 'Target value', t: 'number' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/material-storage-rules': { resource: 'material-storage-rules', idKey: 'materialStorageRuleId', perm: 'masterdata:material_storage_rules:write', statusField: 'status', title: 'Edit storage rule',
      fields: [{ n: 'minTemperature', l: 'Min temperature' }, { n: 'maxTemperature', l: 'Max temperature' }, { n: 'storageCondition', l: 'Storage condition / handling' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/rm-aliases': { resource: 'rm-aliases', idKey: 'rmAliasId', perm: 'masterdata:rm_alias:write', statusField: 'status', title: 'Edit RM alias',
      fields: [{ n: 'aliasName', l: 'Alias name' }, { n: 'aliasType', l: 'Alias type', t: 'select', en: ['FLOOR', 'PACKAGING', 'GENERIC'] }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/grn-containers': { resource: 'grn-containers', idKey: 'grnContainerId', perm: 'inventory:grn_container:write', statusField: 'status', title: 'Edit container',
      fields: [{ n: 'containerCode', l: 'Container number' }, { n: 'containerQty', l: 'Container qty', t: 'number' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/dispatch-documents': { resource: 'dispatch-documents', idKey: 'dispatchDocumentId', perm: 'sales:dispatch_master:write', statusField: 'status', title: 'Edit dispatch document',
      fields: [{ n: 'documentNumber', l: 'Document number' }, { n: 'amount', l: 'Amount', t: 'number' }, { n: 'receivedBy', l: 'Received by (POD)' }, { n: 'status', l: 'Status', t: 'select', en: ['ISSUED', 'DELIVERED', 'CANCELLED'] }] },
    '/v1/production-plans': { resource: 'production-plans', idKey: 'productionPlanId', perm: 'production:production_plan:write', statusField: 'status', title: 'Edit production plan',
      fields: [{ n: 'planDate', l: 'Plan date', t: 'date' }, { n: 'status', l: 'Status', t: 'select', en: ['DRAFT', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] }] },
    '/v1/geo-regions': { resource: 'geo-regions', idKey: 'id', perm: 'platform:geo_location_master:write', statusField: 'isActive', editPath: function (id) { return '/v1/geo-regions/' + id; }, title: 'Edit geo region',
      fields: [{ n: 'name', l: 'Region name' }, { n: 'code', l: 'Code' }, { n: 'isActive', l: 'Active', t: 'select', en: ['true', 'false'] }] },
    '/v1/products': { resource: 'products', idKey: 'productId', perm: 'packaging:product_master:write', statusField: 'status', title: 'Edit product',
      fields: [{ n: 'productCode', l: 'Code' }, { n: 'productName', l: 'Name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/packaging-boms': { resource: 'packaging-boms', idKey: 'packagingBomId', perm: 'packaging:packaging_bom_master:write', statusField: 'status', title: 'Edit BOM line',
      fields: [{ n: 'requiredQty', l: 'Qty per unit', t: 'number' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/quotation-items': { resource: 'quotation-items', idKey: 'quotationItemId', perm: 'procurement:quotation_items:write', statusField: 'status', title: 'Edit quotation line',
      fields: [{ n: 'quotedQty', l: 'Quoted qty', t: 'number' }, { n: 'quotedRate', l: 'Quoted rate', t: 'number' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/vendor-negotiations': { resource: 'vendor-negotiations', idKey: 'vendorNegotiationId', perm: 'procurement:quotation_items:write', statusField: 'status', title: 'Edit negotiation',
      fields: [{ n: 'revisedRate', l: 'Revised rate', t: 'number' }, { n: 'recommendation', l: 'Recommendation', t: 'select', en: ['APPROVE', 'REJECT', 'HOLD', 'RENEGOTIATE'] }, { n: 'notes', l: 'Notes', t: 'textarea' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/warehouses': { resource: 'warehouses', idKey: 'warehouseId', perm: 'location:warehouse_master:write', statusField: 'status', title: 'Edit warehouse',
      fields: [{ n: 'warehouseName', l: 'Warehouse name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/floors': { resource: 'floors', idKey: 'floorId', perm: 'location:floor_master:write', statusField: 'status', title: 'Edit floor',
      fields: [{ n: 'floorName', l: 'Floor name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/zones': { resource: 'zones', idKey: 'zoneId', perm: 'location:zone_master:write', statusField: 'status', title: 'Edit zone',
      fields: [{ n: 'zoneName', l: 'Zone name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/racks': { resource: 'racks', idKey: 'rackId', perm: 'location:rack_master:write', statusField: 'status', title: 'Edit rack',
      fields: [{ n: 'rackName', l: 'Rack name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/shelves': { resource: 'shelves', idKey: 'shelfId', perm: 'location:shelf_master:write', statusField: 'status', title: 'Edit shelf',
      fields: [{ n: 'shelfName', l: 'Shelf name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/bins': { resource: 'bins', idKey: 'binId', perm: 'location:bin_master:write', statusField: 'status', title: 'Edit bin',
      fields: [{ n: 'binName', l: 'Bin name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/grns': { resource: 'grns', idKey: 'grnId', perm: 'inventory:grn_master:write', statusField: 'status', title: 'Edit GRN',
      fields: [{ n: 'status', l: 'Status', t: 'select', en: ['RECEIVED', 'PENDING', 'CANCELLED'] }] },
    '/v1/rfqs': { resource: 'rfqs', idKey: 'rfqId', perm: 'procurement:rfq_master:write', statusField: 'status', title: 'Edit RFQ',
      fields: [{ n: 'status', l: 'Status', t: 'select', en: ['OPEN', 'CLOSED', 'CANCELLED'] }] },
    '/v1/purchase-requests': { resource: 'purchase-requests', idKey: 'purchaseRequestId', perm: 'procurement:purchase_request:write', statusField: 'status', noDeactivate: true, editWhen: function (r) { return UP(r.status) === 'DRAFT'; }, editWhenReason: function (r) { return 'Only a DRAFT purchase request can be edited — this one is ' + UP(r.status) + '.'; }, title: 'Edit purchase request (draft)',
      fields: [{ n: 'priority', l: 'Priority', t: 'select', en: ['HIGH', 'MEDIUM', 'LOW'] }, { n: 'status', l: 'Status', t: 'select', en: ['DRAFT', 'SUBMITTED'] }] },
    '/v1/purchase-orders': { resource: 'purchase-orders', idKey: 'purchaseOrderId', perm: 'procurement:purchase_order:write', statusField: 'status', noDeactivate: true, editWhen: function (r) { return UP(r.status) === 'DRAFT'; }, editWhenReason: function (r) { return 'Only a DRAFT purchase order can be edited — this one is ' + UP(r.status) + '.'; }, title: 'Edit purchase order (draft)',
      fields: [{ n: 'orderDate', l: 'Order date', t: 'date' }, { n: 'status', l: 'Status', t: 'select', en: ['DRAFT'] }] },
    '/v1/vendors': { resource: 'vendors', idKey: 'vendorId', perm: 'procurement:vendor_details:write', statusField: 'status', title: 'Edit vendor',
      fields: [{ n: 'vendorName', l: 'Vendor name' }, { n: 'paymentTerms', l: 'Payment terms' }, { n: 'gstin', l: 'GSTIN', maxlen: 15, pat: '[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]', patMsg: 'GSTIN must be 15 characters, e.g. 29ABCDE1234F1Z5' }, { n: 'panNumber', l: 'PAN', maxlen: 10, pat: '[A-Z]{5}[0-9]{4}[A-Z]', patMsg: 'PAN must be 10 characters, e.g. ABCDE1234F' }, { n: 'bankName', l: 'Bank name' }, { n: 'bankAccountNumber', l: 'Bank account no.', maxlen: 20, pat: '[0-9]{6,20}', patMsg: 'Account number must be 6–20 digits' }, { n: 'bankIfsc', l: 'IFSC', maxlen: 11, pat: '[A-Z]{4}0[A-Z0-9]{6}', patMsg: 'IFSC must be 11 characters, e.g. HDFC0001234' }, { n: 'contactEmail', l: 'Contact email', pat: '[^@ ]+@[^@ ]+[.][^@ ]+', patMsg: 'Enter a valid email' }, { n: 'contactPhone', l: 'Contact phone', pat: '[+]?[0-9][0-9 -]{6,18}', patMsg: 'Enter a valid phone number' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/customers': { resource: 'customers', idKey: 'customerId', perm: 'sales:customer_master:write', statusField: 'status', title: 'Edit customer',
      fields: [{ n: 'customerName', l: 'Customer name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/transporters': { resource: 'transporters', idKey: 'transporterId', perm: 'sales:transporter_master:write', statusField: 'status', title: 'Edit transporter',
      fields: [{ n: 'transporterName', l: 'Transporter name' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/users': { resource: 'users', idKey: 'userId', perm: 'iam:user_master:write', statusField: 'isActive', title: 'Edit user',
      fields: [{ n: 'userName', l: 'Name' }, { n: 'email', l: 'Email' }, { n: 'mobileNumber', l: 'Mobile' }, { n: 'isActive', l: 'Active', t: 'select', en: ['true', 'false'] }] },
    '/v1/product-skus': { resource: 'product-skus', idKey: 'productSkuId', perm: 'packaging:product_sku:write', statusField: 'status', title: 'Edit product SKU',
      fields: [{ n: 'skuCode', l: 'SKU code' }, { n: 'packSize', l: 'Pack size' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'INACTIVE'] }] },
    '/v1/document-registry': { resource: 'documents', idKey: 'documentRegistryId', perm: 'platform:document_master:write', statusField: 'status', title: 'Edit document',
      fields: [{ n: 'title', l: 'Title' }, { n: 'documentType', l: 'Type' }, { n: 'referenceNo', l: 'Reference no.' }, { n: 'sourceUrl', l: 'Document link' }, { n: 'issueDate', l: 'Issue date' }, { n: 'expiryDate', l: 'Expiry date' }, { n: 'status', l: 'Status', t: 'select', en: ['ACTIVE', 'SUPERSEDED', 'INACTIVE'] }] }
  };
  /* ---------------- shared modal engine (PORTING_GUIDE.md "Dialog (true modal)" / COMPONENT_
   * PARITY_MATRIX.json "Dialog / expand sheet — ExpandSheet parity") ----------------
   * Every shared overlay below (openEdit/openCreate/openCreateDoc/openTrace) and raConfirm() build
   * on this: .xp-scrim > .xp-sheet[role=dialog aria-modal aria-labelledby], Escape + backdrop-click
   * + header-× to close, Tab trapped inside the sheet while it's open, and focus restored to
   * whatever triggered it on close (WCAG dialog pattern; addendum §12.D "0 critical a11y failures").
   * Kept under this name (not private to one call site) so ws-*.js workspace callers building their
   * own xp-scrim/xp-sheet dialogs (e.g. ws-supply.js openRaiseRequirement) can adopt it too. */
  var _sheetSeq = 0;
  function openSheet(o) {
    var trigger = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : null;
    var scrim = document.createElement('div');
    scrim.className = 'xp-scrim open'; if (o.scrimId) scrim.id = o.scrimId;
    var titleId = 'ra-sheet-t' + (_sheetSeq++);
    var tag = o.tag || 'div';
    // Reference ExpandSheet markup: a glass-deep sheet (display gated on .open only), a t-h1 title
    // with an optional t-cap line, and the reference's × control.
    scrim.innerHTML = '<' + tag + (o.id ? ' id="' + o.id + '"' : '') + ' class="glass glass-deep xp-sheet open' + (o.cls ? ' ' + o.cls : '') + '"' + (o.style ? ' style="' + o.style + '"' : '') + ' role="dialog" aria-modal="true" aria-labelledby="' + titleId + '">' +
      '<div class="xp-sheet-hd"><div style="flex:1;min-width:0"><h2 class="t-h1" id="' + titleId + '">' + o.title + '</h2>' + (o.meta ? '<p class="t-cap" style="margin-top:6px">' + o.meta + '</p>' : '') + '</div><button type="button" class="xp" data-sheet-x aria-label="Close">' + CI.x + '</button></div>' +
      '<div class="xp-sheet-bd form">' + o.body + '</div>' +
    '</' + tag + '>';
    document.body.appendChild(scrim); setTheme();
    var sheet = scrim.firstElementChild;
    function focusables() {
      return [].filter.call(sheet.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'),
        function (el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); });
    }
    function close() {
      if (!scrim.parentNode) return;
      scrim.remove(); document.removeEventListener('keydown', onKey, true);
      if (trigger && typeof trigger.focus === 'function') { try { trigger.focus(); } catch (e) {} }
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      var f = focusables(); if (!f.length) return;
      var first = f[0], last = f[f.length - 1], back = e.shiftKey;
      if (back && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!back && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
    sheet.querySelector('[data-sheet-x]').onclick = close;
    // Land focus on the first real field/control, not the × (Tab still cycles through every
    // focusable including ×, so nothing becomes unreachable — this only picks where focus starts).
    var bd = sheet.querySelector('.xp-sheet-bd');
    var firstField = bd && bd.querySelector('input,select,textarea,button:not([disabled]),a[href]');
    (firstField || sheet.querySelector('[data-sheet-x]')).focus();
    return { scrim: scrim, sheet: sheet, close: close };
  }
  // ALEMBIC confirm sheet — replaces window.confirm() for irreversible actions (addendum §9 "clear
  // irreversible-action confirmations", §10 "no hover-only critical actions"). Async: pass what
  // happens on confirm as `onYes`. Single shared helper — ws-*.js callers may call it by this name.
  function raConfirm(message, onYes, opts) {
    opts = opts || {};
    var tone = opts.tone === 'good' ? 'g' : (opts.tone === 'accent' ? 'p' : 'r');
    var m = openSheet({
      id: 'ra-confirm', tag: 'div', style: 'max-width:380px', title: opts.title || 'Confirm',
      body: '<div style="font:var(--w-reg) var(--t-body)/var(--lh-body) var(--font-ui);color:var(--ink-2)">' + escHtml(message) + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:4px">' +
          '<button type="button" class="btn" data-confirm-no style="flex:1;justify-content:center">Cancel</button>' +
          '<button type="button" class="btn ' + tone + '" data-confirm-yes style="flex:1;justify-content:center">' + escHtml(opts.confirmLabel || 'Confirm') + '</button>' +
        '</div>'
    });
    m.sheet.querySelector('[data-confirm-no]').onclick = m.close;
    m.sheet.querySelector('[data-confirm-yes]').onclick = function () { m.close(); onYes(); };
  }
  // Shared ALEMBIC form-field label (PORTING_GUIDE.md §Form field, simplified to the `.fld` bare-
  // input grammar that same section cites for "outside a form grid"). Matches ws-supply.js's own
  // copy of this helper exactly, so every workspace's forms read identically.
  function fLabel(text, req) { return '<span style="font:var(--w-med) var(--t-cap)/1 var(--font-ui);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)">' + text + (req ? ' <span style="color:var(--red)">*</span>' : '') + '</span>'; }

  // Read-only drill-down: ALEMBIC's live pattern is an inline row-expansion, not a modal
  // (PORTING_GUIDE.md "Drawer / inline detail" — "port the inline pattern for parity with what
  // ships"). Nothing outside this file calls the old modal-based openDetail(), so it is fully
  // replaced (see toggleRowDetail() + the paintResults() row-click wiring below) rather than kept
  // as a second UI alongside it.
  function rowDetailHtml(endpoint, row) {
    var cfg = DETAIL[endpoint]; if (!cfg) return '';
    var skip = {}; skip[cfg.idKey] = 1;
    var cells = Object.keys(row).filter(function (k) {
      var v = row[k]; if (skip[k]) return false; if (v == null || v === '') return false;
      if (/Id$/.test(k) && isUuid(v)) return false;
      return true;
    }).map(function (k) {
      return '<div><div class="sect" style="margin-bottom:4px">' + label(k) + '</div><div style="font:var(--w-med) var(--t-body)/1.3 var(--font-ui);color:var(--ink);word-break:break-word">' + fmt(k, row[k], row) + '</div></div>';
    }).join('') || '<div style="color:var(--ink-3);font:var(--w-reg) var(--t-cap)/1.3 var(--font-ui)">No details.</div>';
    return '<div class="fgrid">' + cells + '</div>' + (cfg.items ? '<div class="sect" style="margin:16px 0 6px">Line items</div><div class="ra-ditems">Loading…</div>' : '');
  }
  function loadRowDetailItems(cfg, id, box) {
    tunnel(cfg.items.ep + '?limit=100').then(function (res) {
      var mine = ((res.json && res.json.data) || []).filter(function (x) { return x[cfg.items.fk] === id; });
      if (!box.parentNode) return;
      if (!mine.length) { box.textContent = 'No line items recorded.'; return; }
      var cols = cfg.items.cols;
      box.innerHTML = '<div style="overflow-x:auto"><table><thead><tr>' +
        cols.map(function (c) { return '<th>' + label(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        mine.map(function (r) { return '<tr>' + cols.map(function (c) { return '<td>' + fmt(c, r[c]) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
    }).catch(function () { if (box.parentNode) box.textContent = 'Could not load line items.'; });
  }
  // Toggle the inline detail row under `tr` (only one open at a time — keeps dense tables legible).
  function toggleRowDetail(tr, endpoint, row) {
    var cfg = DETAIL[endpoint]; if (!cfg) return;
    var table = tr.closest('table');
    var openRow = table && table.querySelector('.row-detail-row');
    var wasOwnRow = false;
    if (openRow) {
      var ownerId = openRow.getAttribute('data-owner');
      wasOwnRow = (ownerId === tr.id);
      var owner = ownerId && document.getElementById(ownerId); if (owner) owner.setAttribute('aria-expanded', 'false');
      openRow.remove();
    }
    if (wasOwnRow) return;
    tr.setAttribute('aria-expanded', 'true');
    var id = row[cfg.idKey] != null ? row[cfg.idKey] : guessId(row);
    var dtr = document.createElement('tr'); dtr.className = 'row-detail-row'; dtr.id = 'detail-for-' + tr.id; dtr.setAttribute('data-owner', tr.id);
    tr.setAttribute('aria-controls', dtr.id);
    var td = document.createElement('td'); td.colSpan = tr.children.length; td.className = 'row-detail';
    td.innerHTML = rowDetailHtml(endpoint, row);
    dtr.appendChild(td); tr.insertAdjacentElement('afterend', dtr);
    if (cfg.items) loadRowDetailItems(cfg, id, td.querySelector('.ra-ditems'));
  }
  function openEdit(endpoint, row) {
    var cfg = EDIT[endpoint]; if (!cfg) return;
    var id = row[cfg.idKey] != null ? row[cfg.idKey] : guessId(row);
    var rows = cfg.fields.map(function (f) {
      var ctrl;
      if (f.fk) { ctrl = '<select data-name="' + f.n + '" class="fld"><option value="">— none —</option></select>'; }
      else if (f.t === 'select') { ctrl = '<select data-name="' + f.n + '" class="fld">' + f.en.map(function (v) { return '<option value="' + v + '">' + v + '</option>'; }).join('') + '</select>'; }
      else if (f.t === 'textarea') { ctrl = '<textarea data-name="' + f.n + '" rows="2" class="fld" style="height:auto;padding:9px 13px;resize:vertical"></textarea>'; }
      else { ctrl = '<input data-name="' + f.n + '" type="' + (f.t === 'number' ? 'number' : 'text') + '" class="fld">'; }
      return '<label style="display:flex;flex-direction:column;gap:5px">' + fLabel(f.l) + ctrl + '</label>';
    }).join('');
    var body = rows + '<div id="ra-eerr" role="alert" style="min-height:16px;font:var(--w-med) var(--t-cap)/var(--lh-cap) var(--font-ui);color:var(--red)"></div>' +
      '<button type="submit" class="btn p" id="ra-esave" style="width:100%;justify-content:center;height:var(--ch-touch-floor-coarse-pointer)">Save</button>';
    var m = openSheet({ id: 'ra-eform', tag: 'form', style: 'max-width:440px', title: cfg.title, body: body });
    var ov = m.sheet;
    // prefill current values (via JS so quotes/markup in data can't break the form)
    cfg.fields.forEach(function (f) { var el = ov.querySelector('[data-name="' + f.n + '"]'); if (!el) return; var cur = row[f.n]; el.value = cur == null ? '' : String(cur); });
    // FK dropdowns: fetch options, then re-select the current value.
    cfg.fields.filter(function (f) { return f.fk; }).forEach(function (f) {
      var sel = ov.querySelector('[data-name="' + f.n + '"]'); if (!sel) return;
      tunnel(f.fk + '?limit=100').then(function (res) {
        ((res.json && res.json.data) || []).forEach(function (r) { var val = r[f.fv] != null ? r[f.fv] : guessId(r); var lab = r[f.fl] != null ? r[f.fl] : (val ? String(val).slice(0, 8) : ''); if (val) { var o = document.createElement('option'); o.value = val; o.textContent = lab; sel.appendChild(o); } });
        if (row[f.n] != null) sel.value = String(row[f.n]);
      }).catch(function () {});
    });
    ov.onsubmit = function (e) {
      e.preventDefault(); var body2 = {}, verr = '';
      cfg.fields.forEach(function (f) { var el = ov.querySelector('[data-name="' + f.n + '"]'); if (!el) return; var v = String(el.value).trim(); var fe = validateField(f, v); if (fe) verr = verr || fe; if (f.n === 'isActive') body2[f.n] = (v === 'true'); else body2[f.n] = v; });
      if (verr) { ov.querySelector('#ra-eerr').textContent = verr; return; }
      var save = ov.querySelector('#ra-esave'); save.disabled = true; save.textContent = 'Saving…';
      var editUrl = cfg.editPath ? cfg.editPath(id) : ('/v1/masters/' + cfg.resource + '/' + id);
      tunnel(editUrl, { method: 'PATCH', body: body2 }).then(function (res) {
        if (res.status >= 400) { save.disabled = false; save.textContent = 'Save'; ov.querySelector('#ra-eerr').textContent = (res.json && res.json.error && res.json.error.message) || ('Save failed (' + res.status + ')'); return; }
        m.close(); toast('Saved', 'good'); loadView();
      }).catch(function () { save.disabled = false; save.textContent = 'Save'; ov.querySelector('#ra-eerr').textContent = 'Can\'t connect. Try again.'; });
    };
  }
  function toggleActive(endpoint, cfg, row) {
    var id = row[cfg.idKey] != null ? row[cfg.idKey] : guessId(row);
    var active = cfg.statusField === 'isActive' ? (row.isActive === true || String(row.isActive) === 'true') : String(row[cfg.statusField]).toUpperCase() === 'ACTIVE';
    var body = cfg.statusField === 'isActive' ? { isActive: !active } : { status: active ? 'INACTIVE' : 'ACTIVE' };
    var verb = active ? 'Deactivate' : 'Activate';
    var consequence = active ? 'It stops appearing in pickers and new transactions until reactivated.' : 'It becomes available again in pickers and new transactions.';
    raConfirm(verb + ' this record? ' + consequence, function () {
      var url = cfg.editPath ? cfg.editPath(id) : ('/v1/masters/' + cfg.resource + '/' + id);
      tunnel(url, { method: 'PATCH', body: body }).then(function (res) {
        if (res.status >= 400) { toast((res.json && res.json.error && res.json.error.message) || (verb + ' failed'), 'bad'); return; }
        toast(verb + 'd', 'good'); loadView();
      }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
    }, { title: verb + ' record', confirmLabel: verb, tone: active ? 'bad' : 'good' });
  }
  // generic status transition via the guarded edit registry (maturation, etc.).
  function setStatus(resource, idKey, row, status, verb) {
    var id = row[idKey] != null ? row[idKey] : guessId(row);
    tunnel('/v1/masters/' + resource + '/' + id, { method: 'PATCH', body: { status: status } }).then(function (res) {
      if (res.status >= 400) { toast((res.json && res.json.error && res.json.error.message) || (verb + ' failed'), 'bad'); return; }
      toast(verb + '', 'good'); loadView();
    }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
  }
  // workflow reject — send a PR/PO back (status → REJECTED). Approvals were one-way before.
  /* OPS-GREEN Act L (lane ops-factory): weigh one coded-instruction line; label an FG batch. The
     server composes everything else (target, floor code, label content) from its own records. */
  function postAction(path, body, okMsg) {
    tunnel(path, { method: 'POST', body: body }).then(function (res) {
      if (res.status >= 400) { toast((res.json && res.json.error && res.json.error.message) || 'Failed', 'bad'); return; }
      var d = res.json && res.json.data;
      toast(typeof okMsg === 'function' ? okMsg(d) : okMsg, d && d.status === 'OUT_OF_TOLERANCE' ? 'bad' : 'good'); loadView();
    }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
  }
  function recordWeighing(row) {
    var seq = window.prompt('Instruction line number (sequence) being weighed:');
    if (!seq) return;
    var gross = window.prompt('Gross reading on the balance:');
    if (gross == null || gross === '') return;
    var tare = window.prompt('Tare (container) reading:');
    if (tare == null || tare === '') return;
    postAction('/v1/mixing-sessions/' + row.secureMixingSessionId + '/weighings',
      { sequenceNo: Number(seq), grossQty: Number(gross), tareQty: Number(tare) },
      function (d) { return d && d.status === 'OUT_OF_TOLERANCE' ? 'Out of tolerance: re-weigh this line' : 'Weighing accepted'; });
  }
  function applyFgLabels(row) {
    var n = window.prompt('How many labels were applied to batch ' + (row.batchNumber || '') + '?');
    if (!n) return;
    postAction('/v1/finished-good-batches/' + row.finishedGoodBatchId + '/labels', { labelCount: Number(n) }, 'Labels recorded');
  }

  function rejectDoc(resource, idKey, row) {
    var id = row[idKey] != null ? row[idKey] : guessId(row);
    var noun = resource.replace(/-/g, ' ').replace(/s$/, '');
    raConfirm('Reject this ' + noun + '? This sends it back and cannot be undone from here.', function () {
      tunnel('/v1/masters/' + resource + '/' + id, { method: 'PATCH', body: { status: 'REJECTED' } }).then(function (res) {
        if (res.status >= 400) { toast((res.json && res.json.error && res.json.error.message) || 'Reject failed', 'bad'); return; }
        toast('Rejected', 'good'); loadView();
      }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
    }, { title: 'Reject ' + noun, confirmLabel: 'Reject', tone: 'bad' });
  }

  /* ---------------- printable records (PO / GRN / dispatch note / CoA / batch certificate) ---------------- */
  var PRINTABLE = {
    '/v1/purchase-orders': 'PURCHASE ORDER', '/v1/grns': 'GOODS RECEIPT NOTE', '/v1/dispatches': 'DISPATCH / DELIVERY NOTE',
    '/v1/qc-inspections': 'CERTIFICATE OF ANALYSIS', '/v1/finished-good-batches': 'FINISHED-GOODS BATCH CERTIFICATE',
    '/v1/package-orders': 'PACKAGING ORDER', '/v1/sales-orders': 'SALES ORDER', '/v1/document-registry': 'DOCUMENT RECORD'
  };
  function printDoc(endpoint, row) {
    var docTitle = PRINTABLE[endpoint] || 'DOCUMENT';
    function rowsHtml(obj) {
      return Object.keys(obj).filter(function (k) { return !HIDE[k] && !sensitive(k) && obj[k] != null && typeof obj[k] !== 'object' && obj[k] !== ''; }).map(function (k) {
        var v = obj[k]; if (isUuid(v)) v = String(v).slice(0, 8).toUpperCase();
        return '<tr><td class="k">' + label(k) + '</td><td class="v">' + String(v) + '</td></tr>';
      }).join('');
    }
    function open(extra) {
      var w = window.open('', '_blank', 'width=820,height=920'); if (!w) { toast('Allow pop-ups to print.', 'bad'); return; }
      var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + docTitle + '</title><style>' +
        'body{font-family:Arial,Helvetica,sans-serif;color:#141413;padding:40px;max-width:720px;margin:auto}' +
        'h1{font-size:14px;letter-spacing:.16em;color:#141413;margin:0;font-weight:600}h2{font-size:20px;margin:4px 0}.sub{color:#66665E;font-size:12px}' +
        'hr{border:none;border-top:2px solid #E6E6E3;margin:14px 0}table{width:100%;border-collapse:collapse;margin-top:8px}' +
        'td{padding:7px 10px;border-bottom:1px solid #E6E6E3;font-size:13px}.k{color:#66665E;width:42%;font-weight:600}.v{font-weight:700}' +
        '.sec{margin-top:20px;font-size:11px;letter-spacing:.1em;color:#66665E;font-weight:800}' +
        '.sign{margin-top:56px;display:flex;justify-content:space-between}.sign div{border-top:1px solid #D6D6D2;padding-top:6px;font-size:12px;color:#66665E;width:210px;text-align:center}' +
        '@media print{.noprint{display:none}}</style></head><body>' +
        '<h1>RAW AROMA CHEM</h1><hr>' +
        '<h2>' + docTitle + '</h2><div class="sub">Generated ' + new Date().toLocaleString() + '</div>' +
        '<table>' + rowsHtml(row) + '</table>' + (extra || '') +
        '<div class="sign"><div>Prepared by</div><div>Authorised signatory</div></div>' +
        '<div class="noprint" style="margin-top:30px;text-align:center"><button onclick="window.print()" style="padding:10px 26px;background:#E9F260;color:#141413;border:none;border-radius:10px;font-weight:600;cursor:pointer;font-size:14px">Print</button></div>' +
        '</body></html>';
      w.document.write(html); w.document.close();
    }
    // CoA: enrich with the inspection's test-result rows.
    if (endpoint === '/v1/qc-inspections') {
      tunnel('/v1/qc-result-details?limit=100').then(function (res) {
        var mine = ((res.json && res.json.data) || []).filter(function (x) { return x.qcInspectionId === row.qcInspectionId; });
        var extra = mine.length ? ('<div class="sec">TEST RESULTS</div><table>' + mine.map(function (m) { return '<tr><td class="k">' + (m.parameterName || m.parameter || m.testName || 'Result') + '</td><td class="v">' + (m.observedValue != null ? m.observedValue : '') + ' ' + (m.result || '') + '</td></tr>'; }).join('') + '</table>') : '';
        open(extra);
      }).catch(function () { open(''); });
    } else open('');
  }

  var _acts = {}, _actSeq = 0;
  function actionsFor(endpoint, r) { var defs = ACTIONS[endpoint]; return defs ? defs.filter(function (a) { return can(a.perm) && a.when(r); }) : null; }
  // Activate/Deactivate only belongs to an ACTIVE/INACTIVE status domain, never a workflow-status
  // one (DRAFT/APPROVED/OPEN/… — those have their own lifecycle buttons via ACTIONS instead). A
  // config can force this off with `noDeactivate`; otherwise it's inferred from the actual `en`
  // enum on the status field, so every EDIT entry gets this right without hand-flagging each one.
  function isActiveDomain(cfg) {
    if (cfg.noDeactivate) return false;
    if (cfg.statusField === 'isActive') return true;
    var sf = cfg.fields.filter(function (f) { return f.n === cfg.statusField; })[0];
    var en = sf && sf.en;
    return !!(en && en.length === 2 && en.indexOf('ACTIVE') >= 0 && en.indexOf('INACTIVE') >= 0);
  }
  function actBtn(k, label, bg, fg, opts) {
    opts = opts || {};
    // Disabled action: plain-language reason via `title` (desktop hover) + a visible inline hint
    // on touch, where hover tooltips don't fire (addendum §9/§10).
    if (opts.disabled) {
      return '<button class="ra-act" disabled aria-disabled="true" title="' + escHtml(opts.reason || '') + '" style="margin:2px 4px 2px 0;padding:6px 12px;border:none;border-radius:var(--r-sm);font:var(--w-med) var(--t-cap)/1 var(--font-ui);color:var(--ink-3);background:var(--panel-2);white-space:nowrap">' + label + '<span class="act-hint">' + escHtml(opts.reason || '') + '</span></button>';
    }
    return '<button class="ra-act" data-k="' + k + '" style="margin:2px 4px 2px 0;padding:6px 12px;border:none;border-radius:var(--r-sm);font:var(--w-med) var(--t-cap)/1 var(--font-ui);cursor:pointer;color:' + (fg || '#fff') + ';background:' + bg + ';white-space:nowrap">' + label + '</button>';
  }
  function rowActionsCell(endpoint, r) {
    var out = [];
    var avail = actionsFor(endpoint, r) || [];
    avail.forEach(function (a) {
      var bg = a.tone === 'bad' ? 'var(--red)' : a.tone === 'warn' ? 'var(--amber)' : a.tone === 'good' ? 'var(--green)' : 'var(--accent)';
      // actBtn's own default fg (#fff) reads fine on red/amber/green (dark, muted tones) but
      // measured at 1.21:1 -- axe color-contrast serious -- on --accent (#E9F260, a light
      // yellow-green): needs --accent-ink, the same pairing .btn.p already uses for --accent
      // everywhere else in this stylesheet. Mirrors bg's own branches exactly (not just
      // `a.tone` truthy) -- tone:'accent' is a real, truthy value distinct from bad/warn/good
      // that also renders on --accent and was missed by a plain truthy check.
      var fg = (a.tone === 'bad' || a.tone === 'warn' || a.tone === 'good') ? '#fff' : 'var(--ink)';
      var k = 'ra' + (_actSeq++); _acts[k] = { a: a, r: r };
      out.push(actBtn(k, a.label, bg, fg));
    });
    var cfg = EDIT[endpoint];
    if (cfg && can(cfg.perm)) {
      var editOk = !cfg.editWhen || cfg.editWhen(r);
      var kE = 'ra' + (_actSeq++);
      if (editOk) {
        _acts[kE] = { a: { label: 'Edit', run: function (row) { openEdit(endpoint, row); } }, r: r };
        out.push(actBtn(kE, 'Edit', 'var(--well)', 'var(--t1)'));
      } else {
        out.push(actBtn(kE, 'Edit', null, null, { disabled: true, reason: cfg.editWhenReason ? cfg.editWhenReason(r) : 'Cannot be edited in its current status.' }));
      }
      if (isActiveDomain(cfg)) {
        var active = cfg.statusField === 'isActive' ? (r.isActive === true || String(r.isActive) === 'true') : String(r[cfg.statusField]).toUpperCase() === 'ACTIVE';
        var kD = 'ra' + (_actSeq++); _acts[kD] = { a: { label: active ? 'Deactivate' : 'Activate', run: function (row) { toggleActive(endpoint, cfg, row); } }, r: r };
        out.push(actBtn(kD, active ? 'Deactivate' : 'Activate', active ? 'var(--red)' : 'var(--green)'));
      }
    }
    if (PRINTABLE[endpoint]) {
      var kP = 'ra' + (_actSeq++); _acts[kP] = { a: { label: 'Print', run: function (row) { printDoc(endpoint, row); } }, r: r };
      out.push(actBtn(kP, 'Print', 'var(--well)', 'var(--t1)'));
    }
    if (!out.length) return '<span style="color:var(--ink-3)">—</span>';
    return out.join('');
  }
  // COMPONENT_PARITY_MATRIX.json "Toast" (console.css:1471-1476 / admin-console.jsx setToast,
  // 3400ms auto-dismiss). RawProd's toasts carry a tone (good/bad/neutral) ALEMBIC's bare `.toast`
  // does not distinguish, so `.toast.good`/`.toast.bad` add that without a new visual grammar.
  function toast(msg, tone) {
    var t = document.createElement('div'); t.className = 'toast' + (tone === 'bad' ? ' bad' : tone === 'good' ? ' good' : '');
    t.innerHTML = '<span class="d"></span>' + escHtml(msg);
    document.body.appendChild(t);
    if (window.RaSound) { if (tone === 'bad') RaSound.play('alert'); else if (tone === 'good') RaSound.play('success'); else RaSound.cue(msg); }
    setTimeout(function () { t.style.transition = 'opacity .35s'; t.style.opacity = '0'; setTimeout(function () { if (t.parentNode) t.remove(); }, 360); }, 1900);
  }
  function wireActions() {
    [].forEach.call(document.querySelectorAll('.ra-act'), function (b) {
      b.onclick = async function () {
        var rec = _acts[b.getAttribute('data-k')]; if (!rec) return;
        var a = rec.a, r = rec.r, old = b.textContent;
        if (a.run) { a.run(r); return; } // custom action (opens its own modal)
        b.disabled = true; b.style.opacity = '.6'; b.textContent = '…';
        try {
          var body = a.prepare ? await a.prepare(r) : (a.body || {});
          var res = await tunnel(a.path(r), { method: 'POST', body: body });
          if (res.status >= 400) { b.disabled = false; b.style.opacity = '1'; b.textContent = old; toast((res.json && res.json.error && res.json.error.message) || ('Action failed (' + res.status + ')'), 'bad'); return; }
          toast('Done', 'good'); loadView();
        } catch (e) { b.disabled = false; b.style.opacity = '1'; b.textContent = old; toast('Can\'t connect. Try again.', 'bad'); }
      };
    });
  }

  /* ---------------- "+ New" create forms (existing POST create routes) ---------------- */
  var CREATE = {
    '/v1/users': { title: 'New user', perm: 'iam:user_master:write', fields: [
      { n: 'userName', l: 'Full name', t: 'text', req: true },
      { n: 'email', l: 'Email (used to sign in)', t: 'text', req: true },
      { n: 'password', l: 'Temporary password (min 8 chars)', t: 'text', req: true },
      { n: 'employeeCode', l: 'Employee code', t: 'text' },
      { n: 'mobileNumber', l: 'Mobile number', t: 'text' }
    ] },
    '/v1/roles': { title: 'New role', perm: 'iam:role_master:write', fields: [
      { n: 'roleCode', l: 'Role code', t: 'text', req: true }, { n: 'roleName', l: 'Role name', t: 'text', req: true }
    ] },
    '/v1/permissions': { title: 'New permission', perm: 'iam:permission_master:write', fields: [
      { n: 'permissionCode', l: 'Permission code (e.g. sales:customer_master:read)', t: 'text', req: true },
      { n: 'permissionName', l: 'Permission name', t: 'text', req: true }, { n: 'moduleName', l: 'Module', t: 'text' }
    ] },
    '/v1/vendor-contacts': { title: 'New vendor contact', perm: 'procurement:vendor_contact:write', fields: [
      { n: 'vendorId', l: 'Vendor', t: 'select', fk: '/v1/vendors', fv: 'vendorId', fl: 'vendorName', req: true },
      { n: 'contactName', l: 'Contact name', t: 'text', req: true },
      { n: 'contactType', l: 'Contact type', t: 'select', en: ['PRIMARY', 'SECONDARY', 'PURCHASE', 'ACCOUNTS', 'TECHNICAL'] },
      { n: 'designation', l: 'Designation', t: 'text' },
      { n: 'email', l: 'Email', t: 'text' }, { n: 'mobileNumber', l: 'Mobile', t: 'text' }
    ] },
    '/v1/vendor-rm-mappings': { title: 'Map material to supplier', perm: 'procurement:vendor_rm_mapping:write', fields: [
      { n: 'vendorId', l: 'Supplier', t: 'select', fk: '/v1/vendors', fv: 'vendorId', fl: 'vendorName', req: true },
      { n: 'materialId', l: 'Material', t: 'select', fk: '/v1/materials', fv: 'materialId', fl: 'materialName', req: true },
      { n: 'isPreferred', l: 'Preferred supplier', t: 'select', en: ['true', 'false'] },
      { n: 'leadTimeDays', l: 'Lead time (days)', t: 'number' },
      { n: 'minOrderQty', l: 'Min order qty (MOQ)', t: 'number' }
    ] },
    '/v1/quotations': { title: 'New quotation', perm: 'procurement:quotations:write', fields: [
      { n: 'quotationNumber', l: 'Quotation no.', t: 'text', req: true },
      { n: 'rfqId', l: 'Against RFQ', t: 'select', fk: '/v1/rfqs', fv: 'rfqId', fl: 'rfqNumber' },
      { n: 'vendorId', l: 'Vendor', t: 'select', fk: '/v1/vendors', fv: 'vendorId', fl: 'vendorName', req: true },
      { n: 'quotationDate', l: 'Quotation date', t: 'date' }, { n: 'validUntilDate', l: 'Valid until', t: 'date' }
    ] },
    '/v1/vendor-credit-notes': { title: 'New vendor settlement', perm: 'procurement:vendor_credit_note:write', fields: [
      { n: 'vendorId', l: 'Vendor', t: 'select', fk: '/v1/vendors', fv: 'vendorId', fl: 'vendorName', req: true },
      { n: 'grnId', l: 'Against GRN (QC-rejected only)', t: 'select', fk: '/v1/qc-rejected-grns', fv: 'grnId', fl: 'label' },
      { n: 'vendorCreditReasonId', l: 'Reason', t: 'select', fk: '/v1/vendor-credit-reasons', fv: 'vendorCreditReasonId', fl: 'reasonDescription' },
      { n: 'creditNoteNumber', l: 'Credit note no.', t: 'text', req: true }, { n: 'amount', l: 'Amount', t: 'number' },
      { n: 'creditNoteDate', l: 'Date', t: 'date' }
    ] },
    '/v1/contacts': { title: 'New contact', perm: 'platform:contact_master:write', fields: [
      { n: 'contactName', l: 'Name', t: 'text', req: true }, { n: 'email', l: 'Email', t: 'text', req: true }, { n: 'mobileNumber', l: 'Mobile', t: 'text', req: true }
    ] },
    '/v1/countries': { title: 'New country', perm: 'platform:country_master:write', fields: [
      { n: 'countryCode', l: 'Country code (e.g. IN)', t: 'text', req: true }, { n: 'countryName', l: 'Country name', t: 'text', req: true }
    ] },
    '/v1/qc-inspections': { title: 'New QC inspection', perm: 'quality:qc_inspections:write', fields: [
      { n: 'rmBatchId', l: 'RM batch', t: 'select', fk: '/v1/rm-batches', fv: 'rmBatchId', fl: 'batchNumber', req: true },
      { n: 'inspectionDt', l: 'Inspection date', t: 'date' }
    ] },
    '/v1/qc-parameters': { title: 'New QC parameter', perm: 'quality:qc_parameter_master:write', fields: [
      { n: 'parameterCode', l: 'Parameter code (e.g. DENSITY)', t: 'text', req: true },
      { n: 'parameterName', l: 'Parameter name', t: 'text', req: true }
    ] },
    '/v1/material-types': { title: 'New material type', perm: 'masterdata:material_type_master:write', fields: [
      { n: 'typeCode', l: 'Type code', t: 'text', req: true }, { n: 'typeName', l: 'Type name', t: 'text', req: true }
    ] },
    '/v1/material-categories': { title: 'New material category', perm: 'masterdata:material_category_master:write', fields: [
      { n: 'materialTypeId', l: 'Material type', t: 'select', fk: '/v1/material-types', fv: 'materialTypeId', fl: 'typeName' },
      { n: 'categoryCode', l: 'Category code', t: 'text', req: true }, { n: 'categoryName', l: 'Category name', t: 'text', req: true }
    ] },
    '/v1/material-subcategories': { title: 'New sub-category', perm: 'masterdata:material_subcategory_master:write', fields: [
      { n: 'materialCategoryId', l: 'Category', t: 'select', fk: '/v1/material-categories', fv: 'materialCategoryId', fl: 'categoryName' },
      { n: 'subCategoryCode', l: 'Sub-category code', t: 'text', req: true }, { n: 'subCategoryName', l: 'Sub-category name', t: 'text', req: true }
    ] },
    '/v1/material-groups': { title: 'New material group', perm: 'masterdata:material_group:write', fields: [
      { n: 'materialSubcategoryId', l: 'Sub-category', t: 'select', fk: '/v1/material-subcategories', fv: 'materialSubcategoryId', fl: 'subCategoryName' },
      { n: 'groupCode', l: 'Group code', t: 'text', req: true }, { n: 'groupName', l: 'Group name', t: 'text', req: true }
    ] },
    '/v1/material-qc-specifications': { title: 'New material QC spec', perm: 'masterdata:material_qc_specifications:write', fields: [
      { n: 'materialId', l: 'Material', t: 'select', fk: '/v1/materials', fv: 'materialId', fl: 'materialName', req: true },
      { n: 'qcParameterId', l: 'QC parameter', t: 'select', fk: '/v1/qc-parameters', fv: 'qcParameterId', fl: 'parameterName' },
      { n: 'minValue', l: 'Min value', t: 'number' }, { n: 'maxValue', l: 'Max value', t: 'number' }, { n: 'targetValue', l: 'Target value', t: 'number' }
    ] },
    '/v1/material-storage-rules': { title: 'New storage rule', perm: 'masterdata:material_storage_rules:write', fields: [
      { n: 'materialId', l: 'Material', t: 'select', fk: '/v1/materials', fv: 'materialId', fl: 'materialName', req: true },
      { n: 'minTemperature', l: 'Min temperature (e.g. 15°C)', t: 'text' }, { n: 'maxTemperature', l: 'Max temperature (e.g. 25°C)', t: 'text' },
      { n: 'storageCondition', l: 'Storage condition / handling', t: 'text' }
    ] },
    '/v1/rm-aliases': { title: 'New RM alias', perm: 'masterdata:rm_alias:write', fields: [
      { n: 'materialId', l: 'Material (real)', t: 'select', fk: '/v1/materials', fv: 'materialId', fl: 'materialName', req: true },
      { n: 'aliasName', l: 'Alias (masked name)', t: 'text', req: true },
      { n: 'aliasType', l: 'Alias type', t: 'select', en: ['FLOOR', 'PACKAGING', 'GENERIC'] }
    ] },
    '/v1/grn-containers': { title: 'New container', perm: 'inventory:grn_container:write', fields: [
      { n: 'grnId', l: 'GRN', t: 'select', fk: '/v1/grns', fv: 'grnId', fl: 'grnNumber', req: true },
      { n: 'containerCode', l: 'Container number', t: 'text', req: true },
      { n: 'containerQty', l: 'Container qty', t: 'number' },
      { n: 'uomId', l: 'Unit', t: 'select', fk: '/v1/uoms', fv: 'uomId', fl: 'uomCode' }
    ] },
    '/v1/batch-container-mappings': { title: 'Split batch into container', perm: 'inventory:batch_container_mappings:write', fields: [
      { n: 'rmBatchId', l: 'RM batch', t: 'select', fk: '/v1/rm-batches', fv: 'rmBatchId', fl: 'batchNumber', req: true },
      { n: 'grnContainerId', l: 'Container', t: 'select', fk: '/v1/grn-containers', fv: 'grnContainerId', fl: 'containerCode', req: true }
    ] },
    '/v1/geo-region-types': { title: 'New geo level', perm: 'platform:geo_location_master:write', fields: [
      { n: 'key', l: 'Key (e.g. STATE)', t: 'text', req: true }, { n: 'name', l: 'Level name', t: 'text', req: true },
      { n: 'displayOrder', l: 'Display order', t: 'number' },
      { n: 'typicalParent', l: 'Typical parent level', t: 'select', fk: '/v1/geo-region-types', fv: 'key', fl: 'name' }
    ] },
    '/v1/geo-regions': { title: 'New geo region', perm: 'platform:geo_location_master:write', fields: [
      { n: 'typeKey', l: 'Level', t: 'select', fk: '/v1/geo-region-types', fv: 'key', fl: 'name', req: true },
      { n: 'parentId', l: 'Parent region', t: 'select', fk: '/v1/geo-regions', fv: 'id', fl: 'name' },
      { n: 'name', l: 'Region name', t: 'text', req: true }, { n: 'code', l: 'Code (e.g. KA, 560001)', t: 'text' }
    ] },
    '/v1/products': { title: 'New product', perm: 'packaging:product_master:write', fields: [
      { n: 'productCode', l: 'Product code', t: 'text', req: true }, { n: 'productName', l: 'Product name', t: 'text', req: true },
      { n: 'formulaId', l: 'Formula', t: 'select', fk: '/v1/formulas', fv: 'formulaId', fl: 'formulaCode' },
      { n: 'brandId', l: 'Brand', t: 'select', fk: '/v1/brands', fv: 'brandId', fl: 'brandName' },
      { n: 'productCategoryId', l: 'Category', t: 'select', fk: '/v1/product-categories', fv: 'productCategoryId', fl: 'categoryName' }
    ] },
    '/v1/packaging-boms': { title: 'New packaging BOM line', perm: 'packaging:packaging_bom_master:write', fields: [
      { n: 'productSkuId', l: 'Product SKU', t: 'select', fk: '/v1/product-skus', fv: 'productSkuId', fl: 'skuCode', req: true },
      { n: 'packagingMaterialId', l: 'Packaging material (bottle/cap/label/carton)', t: 'select', fk: '/v1/materials', fv: 'materialId', fl: 'materialName', req: true },
      { n: 'requiredQty', l: 'Qty per unit', t: 'number' }, { n: 'uomId', l: 'Unit', t: 'select', fk: '/v1/uoms', fv: 'uomId', fl: 'uomCode' }
    ] },
    '/v1/quotation-items': { title: 'New quotation line', perm: 'procurement:quotation_items:write', fields: [
      { n: 'quotationId', l: 'Quotation', t: 'select', fk: '/v1/quotations', fv: 'quotationId', fl: 'quotationNumber', req: true },
      { n: 'materialId', l: 'Material', t: 'select', fk: '/v1/materials', fv: 'materialId', fl: 'materialName', req: true },
      { n: 'quotedQty', l: 'Quoted qty', t: 'number' }, { n: 'uomId', l: 'Unit', t: 'select', fk: '/v1/uoms', fv: 'uomId', fl: 'uomCode' },
      { n: 'quotedRate', l: 'Quoted rate', t: 'number' }, { n: 'currencyId', l: 'Currency', t: 'select', fk: '/v1/currencies', fv: 'currencyId', fl: 'currencyCode' }
    ] },
    '/v1/organizations': { title: 'New organization', perm: 'iam:business_unit_master:write', fields: [
      { n: 'type', l: 'Type', t: 'select', en: ['GROUP', 'COMPANY', 'SUBSIDIARY'] },
      { n: 'name', l: 'Organization name', t: 'text', req: true },
      { n: 'reraNo', l: 'Registration no.', t: 'text' }, { n: 'gstin', l: 'GSTIN (tax)', t: 'text', maxlen: 15, pat: '[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]', patMsg: 'GSTIN must be 15 characters, e.g. 29ABCDE1234F1Z5' }
    ] },
    '/v1/location-types': { title: 'New location type', perm: 'location:location_type_master:write', fields: [
      { n: 'typeCode', l: 'Type code (e.g. FACTORY)', t: 'text', req: true }, { n: 'typeName', l: 'Type name', t: 'text', req: true }
    ] },
    '/v1/locations': { title: 'New location', perm: 'location:location_master:write', fields: [
      { n: 'organizationId', l: 'Organization', t: 'select', fk: '/v1/organizations', fv: 'id', fl: 'name' },
      { n: 'businessUnitId', l: 'Business unit', t: 'select', fk: '/v1/business-units', fv: 'businessUnitId', fl: 'businessUnitName' },
      { n: 'locationTypeId', l: 'Location type', t: 'select', fk: '/v1/location-types', fv: 'locationTypeId', fl: 'typeName' },
      { n: 'parentLocationId', l: 'Parent location', t: 'select', fk: '/v1/locations', fv: 'locationId', fl: 'locationName' },
      { n: 'locationCode', l: 'Location code', t: 'text', req: true }, { n: 'locationName', l: 'Location name', t: 'text', req: true }
    ] },
    '/v1/dispatch-documents': { title: 'New dispatch document', perm: 'sales:dispatch_master:write', fields: [
      { n: 'dispatchId', l: 'Dispatch', t: 'select', fk: '/v1/dispatches', fv: 'dispatchId', fl: 'label', req: true },
      { n: 'documentType', l: 'Document type', t: 'select', en: ['DELIVERY_CHALLAN', 'INVOICE', 'EWAY_BILL', 'PACKING_LIST', 'PROOF_OF_DELIVERY'], req: true },
      { n: 'documentNumber', l: 'Document number', t: 'text' }, { n: 'documentDate', l: 'Document date', t: 'date' },
      { n: 'amount', l: 'Amount (invoice)', t: 'number' }, { n: 'reference', l: 'Reference (e-way/transport)', t: 'text' },
      { n: 'receivedBy', l: 'Received by (POD)', t: 'text' }, { n: 'notes', l: 'Notes', t: 'textarea' }
    ] },
    '/v1/vendor-dispatches': { title: 'Record vendor dispatch', perm: 'procurement:purchase_order:read', fields: [
      { n: 'purchaseOrderId', l: 'Against PO', t: 'select', fk: '/v1/purchase-orders', fv: 'purchaseOrderId', fl: 'poNumber', req: true },
      { n: 'dispatchDate', l: 'Dispatch date', t: 'date', req: true }, { n: 'transporter', l: 'Transporter', t: 'text' },
      { n: 'docketNumber', l: 'Docket / LR no.', t: 'text' }, { n: 'vehicleNumber', l: 'Vehicle no.', t: 'text' }
    ] },
    '/v1/qc-sample-retentions': { title: 'Retain QC sample', perm: 'quality:qc_sample_retention:write', fields: [
      { n: 'sampleCode', l: 'Sample code', t: 'text', req: true },
      { n: 'rmBatchId', l: 'RM batch', t: 'select', fk: '/v1/rm-batches', fv: 'rmBatchId', fl: 'batchNumber' },
      { n: 'sampleQty', l: 'Retained qty', t: 'number', def: 10 },
      { n: 'uomId', l: 'Unit', t: 'select', fk: '/v1/uoms', fv: 'uomId', fl: 'uomCode' }
    ] },
    '/v1/po-advance-payments': { title: 'Record advance payment', perm: 'procurement:purchase_order:write', fields: [
      { n: 'purchaseOrderId', l: 'Purchase order', t: 'select', fk: '/v1/purchase-orders', fv: 'purchaseOrderId', fl: 'poNumber', req: true },
      { n: 'amount', l: 'Advance amount', t: 'number', req: true }, { n: 'paymentDate', l: 'Payment date', t: 'date', req: true },
      { n: 'reference', l: 'Payment reference (UTR/cheque no.)', t: 'text' }
    ] },
    '/v1/vendor-negotiations': { title: 'New negotiation', perm: 'procurement:quotation_items:write', fields: [
      { n: 'quotationId', l: 'Against quotation', t: 'select', fk: '/v1/quotations', fv: 'quotationId', fl: 'quotationNumber' },
      { n: 'vendorId', l: 'Vendor', t: 'select', fk: '/v1/vendors', fv: 'vendorId', fl: 'vendorName', req: true },
      { n: 'materialId', l: 'Material (optional)', t: 'select', fk: '/v1/materials', fv: 'materialId', fl: 'materialName' },
      { n: 'originalRate', l: 'Original rate', t: 'number' }, { n: 'revisedRate', l: 'Revised rate', t: 'number' },
      { n: 'recommendation', l: 'Recommendation', t: 'select', en: ['APPROVE', 'REJECT', 'HOLD', 'RENEGOTIATE'] },
      { n: 'notes', l: 'Negotiation notes', t: 'textarea' }
    ] },
    '/v1/rfqs': { title: 'New RFQ', perm: 'procurement:rfq_master:write', fields: [
      { n: 'rfqNumber', l: 'RFQ number (auto if blank)', t: 'text' },
      { n: 'purchaseRequestId', l: 'From purchase request', t: 'select', fk: '/v1/purchase-requests', fv: 'purchaseRequestId', fl: 'prNumber', req: true },
      { n: 'rfqDate', l: 'RFQ date', t: 'date', req: true }, { n: 'submissionDeadline', l: 'Submission deadline', t: 'date' }
    ] },
    '/v1/document-registry': { title: 'New document', perm: 'platform:document_master:write', fields: [
      { n: 'title', l: 'Title', t: 'text', req: true },
      { n: 'documentType', l: 'Type', t: 'select', en: ['IFRA Certificate', 'IFRA Conformity Certificate', 'Allergen Declaration', 'COA', 'MSDS', 'GST Certificate', 'FSSAI Licence', 'Contract', 'PO Copy', 'Invoice', 'Other'], req: true },
      { n: 'entityType', l: 'Relates to', t: 'select', en: ['vendor', 'material', 'formula', 'customer', 'other'] },
      { n: 'entityId', l: 'Entity ID (optional)', t: 'text' },
      { n: 'referenceNo', l: 'Reference no.', t: 'text' },
      { n: 'sourceUrl', l: 'Document link (URL)', t: 'text' },
      { n: 'issueDate', l: 'Issue date', t: 'date' }, { n: 'expiryDate', l: 'Expiry date', t: 'date' },
      { n: 'notes', l: 'Notes', t: 'textarea' }
    ] },
    // ---- mid-flow production/packaging creates (make the 20-stage chain walkable from the UI) ----
    '/v1/production-plans': { title: 'New production plan', perm: 'production:production_plan:write', fields: [
      { n: 'planDate', l: 'Plan date', t: 'date', req: true },
      { n: 'locationId', l: 'Location', t: 'select', fk: '/v1/locations', fv: 'locationId', fl: 'locationName' }
    ] },
    '/v1/production-plan-items': { title: 'New plan item', perm: 'production:production_plan:write', fields: [
      { n: 'productionPlanId', l: 'Production plan', t: 'select', fk: '/v1/production-plans', fv: 'productionPlanId', fl: 'planDate', req: true },
      { n: 'formulaId', l: 'Formula', t: 'select', fk: '/v1/formulas', fv: 'formulaId', fl: 'formulaCode' },
      { n: 'plannedQty', l: 'Planned qty', t: 'number' }, { n: 'uomId', l: 'Unit', t: 'select', fk: '/v1/uoms', fv: 'uomId', fl: 'uomCode' }
    ] },
    '/v1/production-orders': { title: 'New production order', perm: 'production:production_order:write', fields: [
      { n: 'formulaVersionId', l: 'Formula version', t: 'select', fk: '/v1/formula-versions', fv: 'formulaVersionId', fl: 'versionNumber', req: true },
      { n: 'orderQty', l: 'Batch size / order qty', t: 'number', req: true },
      { n: 'uomId', l: 'Unit', t: 'select', fk: '/v1/uoms', fv: 'uomId', fl: 'uomCode' }
    ] },
    '/v1/mixing-sessions': { title: 'New mixing session', perm: 'production:secure_mixing_session:write', fields: [
      { n: 'productionOrderId', l: 'Production order', t: 'select', fk: '/v1/production-orders', fv: 'productionOrderId', fl: 'productionOrderId', req: true }
    ] },
    '/v1/oil-batches': { title: 'New oil batch', perm: 'production:oil_batch_master:write', fields: [
      { n: 'productionOrderId', l: 'Production order', t: 'select', fk: '/v1/production-orders', fv: 'productionOrderId', fl: 'productionOrderId', req: true },
      { n: 'batchNumber', l: 'Oil batch no.', t: 'text', req: true }, { n: 'producedQty', l: 'Produced qty', t: 'number', req: true },
      { n: 'uomId', l: 'Unit', t: 'select', fk: '/v1/uoms', fv: 'uomId', fl: 'uomCode' }
    ] },
    '/v1/production-qc': { title: 'Record production QC', perm: 'production:production_qc:write', fields: [
      { n: 'oilBatchId', l: 'Oil batch', t: 'select', fk: '/v1/oil-batches', fv: 'oilBatchId', fl: 'batchNumber', req: true },
      { n: 'result', l: 'Result', t: 'select', en: ['PASS', 'FAIL', 'HOLD', 'REWORK'], req: true }, { n: 'observedValue', l: 'Observed value', t: 'number' }
    ] },
    '/v1/package-orders': { title: 'New package order', perm: 'packaging:package_order:write', fields: [
      { n: 'productSkuId', l: 'Product SKU', t: 'select', fk: '/v1/product-skus', fv: 'productSkuId', fl: 'skuCode', req: true },
      { n: 'oilBatchId', l: 'Oil batch', t: 'select', fk: '/v1/oil-batches', fv: 'oilBatchId', fl: 'batchNumber', req: true },
      { n: 'orderQty', l: 'Order qty', t: 'number', req: true },
      { n: 'uomId', l: 'Unit', t: 'select', fk: '/v1/uoms', fv: 'uomId', fl: 'uomCode' }
    ] },
    '/v1/filling-sessions': { title: 'New filling session', perm: 'packaging:filling_session:write', fields: [
      { n: 'packageOrderId', l: 'Package order', t: 'select', fk: '/v1/package-orders', fv: 'packageOrderId', fl: 'packageOrderId', req: true }
    ] },
    '/v1/finished-good-batches': { title: 'New finished-goods batch', perm: 'packaging:finished_good_batch_master:write', fields: [
      { n: 'packageOrderId', l: 'Package order', t: 'select', fk: '/v1/package-orders', fv: 'packageOrderId', fl: 'packageOrderId', req: true },
      { n: 'productSkuId', l: 'Product SKU', t: 'select', fk: '/v1/product-skus', fv: 'productSkuId', fl: 'skuCode', req: true },
      { n: 'batchNumber', l: 'FG batch no.', t: 'text', req: true }, { n: 'producedQty', l: 'Produced qty (units)', t: 'number', req: true },
      { n: 'expiryDate', l: 'Expiry date', t: 'date' }
    ] },
    // ---- M06 stock operations (record movements / adjust / transfer / reserve / count from the UI) ----
    '/v1/inventory-transactions': { title: 'Record stock movement', perm: 'inventory:inventory_transaction:write', fields: [
      { n: 'inventoryBatchId', l: 'Batch', t: 'select', fk: '/v1/inventory-availability', fv: 'inventoryBatchId', fl: 'batchNumber', req: true },
      { n: 'eventType', l: 'Movement', t: 'select', en: ['RECEIPT', 'ISSUE', 'TRANSFER', 'ADJUSTMENT', 'RETURN'], req: true },
      { n: 'transactionQty', l: 'Quantity', t: 'number', req: true }, { n: 'remarks', l: 'Remarks', t: 'text' }
    ] },
    '/v1/stock-adjustments': { title: 'New stock adjustment', perm: 'inventory:stock_adjustment:write', fields: [
      { n: 'inventoryBatchId', l: 'Batch', t: 'select', fk: '/v1/inventory-availability', fv: 'inventoryBatchId', fl: 'batchNumber', req: true },
      { n: 'adjustmentQty', l: 'Adjustment qty (+/−)', t: 'number', req: true }, { n: 'adjustmentReason', l: 'Reason', t: 'text' }
    ] },
    '/v1/stock-transfers': { title: 'New stock transfer', perm: 'inventory:stock_transfer:write', fields: [
      { n: 'inventoryBatchId', l: 'Batch', t: 'select', fk: '/v1/inventory-availability', fv: 'inventoryBatchId', fl: 'batchNumber', req: true },
      { n: 'toLocationId', l: 'To rack/location', t: 'select', fk: '/v1/racks', fv: 'rackId', fl: 'rackCode' },
      { n: 'transferQty', l: 'Transfer qty', t: 'number', req: true }
    ] },
    '/v1/stock-reservations': { title: 'New stock reservation', perm: 'inventory:stock_reservation:write', fields: [
      { n: 'inventoryBatchId', l: 'Batch', t: 'select', fk: '/v1/inventory-availability', fv: 'inventoryBatchId', fl: 'batchNumber', req: true },
      { n: 'reservedQty', l: 'Reserve qty', t: 'number', req: true }
    ] },
    '/v1/fg-reservations': { title: 'Reserve finished-good stock', perm: 'packaging:finished_good_batch_master:write', fields: [
      { n: 'finishedGoodBatchId', l: 'Finished-good batch', t: 'select', fk: '/v1/fg-stock', fv: 'finishedGoodBatchId', fl: 'batchNumber', req: true },
      { n: 'reservedQty', l: 'Reserve qty', t: 'number', req: true },
      { n: 'channel', l: 'Hold for', t: 'select', en: ['GENERAL', 'WEB', 'OFFLINE'] }
    ] },
    '/v1/stock-audits': { title: 'New stock count', perm: 'inventory:stock_audit:write', fields: [
      { n: 'auditCode', l: 'Count reference', t: 'text', req: true },
      { n: 'auditType', l: 'Type', t: 'select', en: ['CYCLE', 'FULL', 'SPOT'] },
      { n: 'locationId', l: 'Location', t: 'select', fk: '/v1/racks', fv: 'rackId', fl: 'rackCode' }
    ] },
    '/v1/materials': { title: 'New material', perm: 'masterdata:material:write', fields: [
      { n: 'materialCode', l: 'Material code', t: 'text', req: true }, { n: 'materialName', l: 'Material name', t: 'text', req: true },
      { n: 'materialTypeId', l: 'Type', t: 'select', fk: '/v1/material-types', fv: 'materialTypeId', fl: 'typeName' },
      { n: 'materialCategoryId', l: 'Category', t: 'select', fk: '/v1/material-categories', fv: 'materialCategoryId', fl: 'categoryName' },
      { n: 'uomId', l: 'Unit', t: 'select', fk: '/v1/uoms', fv: 'uomId', fl: 'uomCode' },
      { n: 'scientificName', l: 'Scientific name', t: 'text' }, { n: 'casNumber', l: 'CAS number', t: 'text' },
      { n: 'density', l: 'Density', t: 'number' }, { n: 'shelfLifeDays', l: 'Shelf life (days)', t: 'number' },
      { n: 'reorderLevel', l: 'Reorder level', t: 'number' }, { n: 'minStock', l: 'Min stock', t: 'number' }, { n: 'maxStock', l: 'Max stock', t: 'number' },
      { n: 'qcRequired', l: 'QC required?', t: 'select', en: ['true', 'false'] }, { n: 'description', l: 'Description', t: 'textarea' }
    ] },
    '/v1/vendors': { title: 'New supplier', perm: 'procurement:vendor_details:write', fields: [
      { n: 'vendorCode', l: 'Vendor code (auto if blank)', t: 'text', maxlen: 50 }, { n: 'vendorName', l: 'Vendor name', t: 'text', req: true, maxlen: 200 }, { n: 'paymentTerms', l: 'Payment terms', t: 'text', maxlen: 60 },
      { n: 'gstin', l: 'GSTIN', t: 'text', maxlen: 15, pat: '[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]', patMsg: 'GSTIN must be 15 characters, e.g. 29ABCDE1234F1Z5' }, { n: 'panNumber', l: 'PAN', t: 'text', maxlen: 10, pat: '[A-Z]{5}[0-9]{4}[A-Z]', patMsg: 'PAN must be 10 characters, e.g. ABCDE1234F' },
      { n: 'bankName', l: 'Bank name', t: 'text' }, { n: 'bankAccountNumber', l: 'Bank account no.', t: 'text', maxlen: 20, pat: '[0-9]{6,20}', patMsg: 'Account number must be 6–20 digits' }, { n: 'bankIfsc', l: 'IFSC', t: 'text', maxlen: 11, pat: '[A-Z]{4}0[A-Z0-9]{6}', patMsg: 'IFSC must be 11 characters, e.g. HDFC0001234' },
      { n: 'contactEmail', l: 'Contact email', t: 'text', pat: '[^@ ]+@[^@ ]+[.][^@ ]+', patMsg: 'Enter a valid email' }, { n: 'contactPhone', l: 'Contact phone', t: 'text', pat: '[+]?[0-9][0-9 -]{6,18}', patMsg: 'Enter a valid phone number' }
    ] },
    '/v1/customers': { title: 'New customer', perm: 'sales:customer_master:write', fields: [
      { n: 'customerCode', l: 'Customer code', t: 'text', req: true }, { n: 'customerName', l: 'Customer name', t: 'text', req: true }
    ] },
    '/v1/transporters': { title: 'New transporter', perm: 'sales:transporter_master:write', fields: [
      { n: 'transporterCode', l: 'Transporter code', t: 'text', req: true }, { n: 'transporterName', l: 'Transporter name', t: 'text', req: true }
    ] },
    '/v1/stock-requirements': { title: 'New stock requirement', perm: 'procurement:stock_requirement:write', fields: [
      { n: 'materialId', l: 'Material', t: 'select', fk: '/v1/materials', fv: 'materialId', fl: 'materialName', req: true },
      { n: 'requiredQty', l: 'Required qty', t: 'number', req: true, min: 0, max: 1000000000 }, { n: 'priority', l: 'Priority', t: 'select', en: ['HIGH', 'MEDIUM', 'LOW'] },
      { n: 'requiredByDate', l: 'Required by', t: 'date', req: true }, { n: 'requirementSource', l: 'Source', t: 'text' }
    ] },
    '/v1/purchase-requests': { title: 'New purchase request', perm: 'procurement:purchase_request:write', fields: [
      { n: 'prNumber', l: 'PR number (auto if blank)', t: 'text' }, { n: 'priority', l: 'Priority', t: 'select', en: ['HIGH', 'MEDIUM', 'LOW'] },
      { n: 'expectedDeliveryDate', l: 'Expected delivery', t: 'date' },
      { n: 'stockRequirementId', l: 'Stock requirement', t: 'select', fk: '/v1/stock-requirements', fv: 'stockRequirementId', fl: 'requirementSource' }
    ] },
    '/v1/gate-entries': { title: 'New gate entry', perm: 'inventory:gate_entry_master:write', fields: [
      { n: 'gateEntryNumber', l: 'Gate entry no. (auto if blank)', t: 'text' },
      { n: 'vendorId', l: 'Supplier', t: 'select', fk: '/v1/vendors', fv: 'vendorId', fl: 'vendorName' },
      { n: 'purchaseOrderId', l: 'Against PO', t: 'select', fk: '/v1/purchase-orders', fv: 'purchaseOrderId', fl: 'poNumber' },
      { n: 'vehicleNumber', l: 'Vehicle no.', t: 'text' }, { n: 'driverName', l: 'Driver', t: 'text' },
      { n: 'invoiceNumber', l: 'Invoice no.', t: 'text' }, { n: 'challanNumber', l: 'Challan no.', t: 'text' }, { n: 'entryDt', l: 'Entry date', t: 'date' }
    ] },
    '/v1/warehouses': { title: 'New warehouse', perm: 'location:warehouse_master:write', fields: [
      { n: 'warehouseCode', l: 'Warehouse code', t: 'text', req: true }, { n: 'warehouseName', l: 'Warehouse name', t: 'text', req: true },
      { n: 'locationId', l: 'Location', t: 'select', fk: '/v1/locations', fv: 'locationId', fl: 'locationName' }
    ] },
    '/v1/floors': { title: 'New floor', perm: 'location:floor_master:write', fields: [
      { n: 'floorCode', l: 'Floor code', t: 'text', req: true }, { n: 'floorName', l: 'Floor name', t: 'text', req: true },
      { n: 'warehouseId', l: 'Warehouse', t: 'select', fk: '/v1/warehouses', fv: 'warehouseId', fl: 'warehouseName' }
    ] },
    '/v1/zones': { title: 'New zone', perm: 'location:zone_master:write', fields: [
      { n: 'zoneCode', l: 'Zone code', t: 'text', req: true }, { n: 'zoneName', l: 'Zone name', t: 'text', req: true },
      { n: 'floorId', l: 'Floor', t: 'select', fk: '/v1/floors', fv: 'floorId', fl: 'floorName' }
    ] },
    '/v1/racks': { title: 'New rack', perm: 'location:rack_master:write', fields: [
      { n: 'rackCode', l: 'Rack code', t: 'text', req: true }, { n: 'rackName', l: 'Rack name', t: 'text', req: true },
      { n: 'zoneId', l: 'Zone', t: 'select', fk: '/v1/zones', fv: 'zoneId', fl: 'zoneName' }
    ] },
    '/v1/shelves': { title: 'New shelf', perm: 'location:shelf_master:write', fields: [
      { n: 'shelfCode', l: 'Shelf code', t: 'text', req: true }, { n: 'shelfName', l: 'Shelf name', t: 'text', req: true },
      { n: 'rackId', l: 'Rack', t: 'select', fk: '/v1/racks', fv: 'rackId', fl: 'rackName' }
    ] },
    '/v1/bins': { title: 'New bin', perm: 'location:bin_master:write', fields: [
      { n: 'binCode', l: 'Bin code', t: 'text', req: true }, { n: 'binName', l: 'Bin name', t: 'text', req: true },
      { n: 'shelfId', l: 'Shelf', t: 'select', fk: '/v1/shelves', fv: 'shelfId', fl: 'shelfName' }
    ] },
    '/v1/uoms': { title: 'New unit of measure', perm: 'platform:uom_master:write', fields: [
      { n: 'uomCode', l: 'UoM code', t: 'text', req: true }, { n: 'uomName', l: 'UoM name', t: 'text', req: true }
    ] },
    '/v1/business-units': { title: 'New business unit', perm: 'iam:business_unit_master:write', fields: [
      { n: 'businessUnitCode', l: 'BU code', t: 'text', req: true }, { n: 'businessUnitName', l: 'BU name', t: 'text', req: true },
      { n: 'organizationId', l: 'Organization', t: 'select', fk: '/v1/organizations', fv: 'id', fl: 'name', req: true },
      { n: 'parentBusinessUnitId', l: 'Parent BU', t: 'select', fk: '/v1/business-units', fv: 'businessUnitId', fl: 'businessUnitName' }
    ] },
    '/v1/packaging-qc': { title: 'Record packaging QC', perm: 'packaging:finished_good_batch_master:write', fields: [
      { n: 'finishedGoodBatchId', l: 'Finished-good batch', t: 'select', fk: '/v1/finished-good-batches', fv: 'finishedGoodBatchId', fl: 'batchNumber', req: true },
      { n: 'leakageCheck', l: 'Leakage check', t: 'select', en: ['PASS', 'FAIL'], req: true },
      { n: 'labelCheck', l: 'Label check', t: 'select', en: ['PASS', 'FAIL'], req: true },
      { n: 'cartonCheck', l: 'Carton check', t: 'select', en: ['PASS', 'FAIL'], req: true }
    ] }
  };
  function guessId(row) { for (var k in row) { if (/Id$/.test(k) && isUuid(row[k])) return row[k]; } return ''; }
  function openCreate(endpoint) {
    var cfg = CREATE[endpoint]; if (!cfg) return;
    var rows = cfg.fields.map(function (f) {
      var ctrl;
      if (f.t === 'select') {
        var opts = '<option value="">' + (f.req ? 'Select…' : '— none —') + '</option>' + (f.en ? f.en.map(function (v) { return '<option value="' + v + '">' + v + '</option>'; }).join('') : '');
        ctrl = '<select data-name="' + f.n + '"' + (f.fk ? ' data-fk="' + f.fk + '" data-fv="' + f.fv + '" data-fl="' + f.fl + '"' : '') + ' class="fld">' + opts + '</select>';
      } else if (f.t === 'textarea') { ctrl = '<textarea data-name="' + f.n + '" rows="2" class="fld" style="height:auto;padding:9px 13px;resize:vertical">' + (f.def != null ? escHtml(f.def) : '') + '</textarea>'; }
      else { ctrl = '<input data-name="' + f.n + '" type="' + (f.t === 'number' ? 'number' : f.t === 'date' ? 'date' : 'text') + '"' + (f.def != null ? ' value="' + escHtml(f.def) + '"' : '') + (f.maxlen ? ' maxlength="' + f.maxlen + '"' : '') + (f.ph ? ' placeholder="' + escHtml(f.ph) + '"' : '') + ' class="fld">'; }
      return '<label style="display:flex;flex-direction:column;gap:5px">' + fLabel(f.l, f.req) + ctrl + '</label>';
    }).join('');
    var body = rows + '<div id="ra-merr" role="alert" style="min-height:16px;font:var(--w-med) var(--t-cap)/var(--lh-cap) var(--font-ui);color:var(--red)"></div>' +
      '<button type="submit" class="btn p" id="ra-msave" style="width:100%;justify-content:center;height:var(--ch-touch-floor-coarse-pointer)">Create</button>';
    var m = openSheet({ id: 'ra-cform', tag: 'form', style: 'max-width:440px', title: cfg.title, body: body });
    var ov = m.sheet;
    cfg.fields.filter(function (f) { return f.fk; }).forEach(function (f) {
      var sel = ov.querySelector('[data-name="' + f.n + '"][data-fk]'); if (!sel) return;
      tunnel(f.fk + '?limit=100').then(function (res) {
        ((res.json && res.json.data) || []).forEach(function (row) {
          var val = row[f.fv] != null ? row[f.fv] : guessId(row); var lab = row[f.fl] != null ? row[f.fl] : (val ? String(val).slice(0, 8) : '');
          if (val) { var o = document.createElement('option'); o.value = val; o.textContent = lab; sel.appendChild(o); }
        });
      }).catch(function () {});
    });
    ov.onsubmit = function (e) {
      e.preventDefault(); var body2 = {}, err = '';
      cfg.fields.forEach(function (f) {
        var el = ov.querySelector('[data-name="' + f.n + '"]'); if (!el) return; var v = String(el.value).trim();
        var fe = validateField(f, v); if (fe) { err = err || fe; }
        if (v) body2[f.n] = f.t === 'number' ? Number(v) : v;
      });
      if (err) { ov.querySelector('#ra-merr').textContent = err; return; }
      var save = ov.querySelector('#ra-msave'); save.disabled = true; save.textContent = 'Creating…';
      tunnel(endpoint, { method: 'POST', body: body2 }).then(function (res) {
        if (res.status >= 400) { save.disabled = false; save.textContent = 'Create'; ov.querySelector('#ra-merr').textContent = (res.json && res.json.error && res.json.error.message) || ('Create failed (' + res.status + ')'); return; }
        m.close(); st.search = ''; toast('Created', 'good'); loadView();
      }).catch(function () { save.disabled = false; save.textContent = 'Create'; ov.querySelector('#ra-merr').textContent = 'Can\'t connect. Try again.'; });
    };
  }

  /* ---------------- documents with line items (raise a PO / sales order from scratch) ---------------- */
  var CREATE_DOC = {
    '/v1/purchase-orders': { title: 'New purchase order', perm: 'procurement:purchase_order:write', itemMin: 1,
      header: [ { n: 'poNumber', l: 'PO number (auto if blank)', t: 'text' }, { n: 'vendorId', l: 'Supplier', t: 'select', fk: '/v1/vendors', fv: 'vendorId', fl: 'vendorName', req: true }, { n: 'purchaseRequestId', l: 'From approved PR (optional)', t: 'select', fk: '/v1/purchase-requests', fv: 'purchaseRequestId', fl: 'prNumber' }, { n: 'quotationId', l: 'From quotation (optional)', t: 'select', fk: '/v1/quotations', fv: 'quotationId', fl: 'quotationNumber' }, { n: 'orderDate', l: 'Order date', t: 'date', req: true } ],
      item: [ { n: 'materialId', l: 'Material', t: 'select', fk: '/v1/materials', fv: 'materialId', fl: 'materialName', req: true }, { n: 'orderedQty', l: 'Qty', t: 'number', req: true }, { n: 'uomId', l: 'Unit', t: 'select', fk: '/v1/uoms', fv: 'uomId', fl: 'uomCode' }, { n: 'rate', l: 'Unit price', t: 'number', req: true } ] },
    // G1/PB-08: sales orders should originate from the ALEMBIC bridge, not this manual form —
    // it is now a break-glass CONTINUITY path (owner/admin only: sales:manual_continuity:write
    // hides the "+ New" button for every other role via the generic `can(cfg.perm)` gate above)
    // and always requires a reason, audited server-side (origin=MANUAL_CONTINUITY + a bridge
    // event toward ALEMBIC — see OrdersService).
    '/v1/sales-orders': { title: 'New sales order (manual continuity)', perm: 'sales:manual_continuity:write', itemMin: 1,
      header: [ { n: 'soNumber', l: 'SO number (auto if blank)', t: 'text' }, { n: 'customerId', l: 'Customer', t: 'select', fk: '/v1/customers', fv: 'customerId', fl: 'customerName', req: true }, { n: 'orderDate', l: 'Order date', t: 'date' }, { n: 'reason', l: 'Reason this order is created manually, outside the ALEMBIC bridge (required, audited)', t: 'text', req: true } ],
      item: [ { n: 'productSkuId', l: 'Product SKU', t: 'select', fk: '/v1/product-skus', fv: 'productSkuId', fl: 'skuCode', req: true }, { n: 'orderedQty', l: 'Qty', t: 'number', req: true }, { n: 'uomId', l: 'Unit', t: 'select', fk: '/v1/uoms', fv: 'uomId', fl: 'uomCode' }, { n: 'rate', l: 'Rate', t: 'number' } ] },
    '/v1/grns': { title: 'New goods receipt (GRN)', perm: 'inventory:grn_master:write', itemMin: 1,
      header: [ { n: 'grnNumber', l: 'GRN number (auto if blank)', t: 'text' }, { n: 'purchaseOrderId', l: 'Against PO', t: 'select', fk: '/v1/purchase-orders', fv: 'purchaseOrderId', fl: 'poNumber' }, { n: 'gateEntryId', l: 'Gate entry', t: 'select', fk: '/v1/gate-entries', fv: 'gateEntryId', fl: 'gateEntryNumber' }, { n: 'grnDate', l: 'GRN date', t: 'date', req: true } ],
      item: [ { n: 'purchaseOrderItemId', l: 'PO line (ordered qty)', t: 'select', fk: '/v1/purchase-order-items', fv: 'purchaseOrderItemId', fl: 'label' }, { n: 'materialId', l: 'Material', t: 'select', fk: '/v1/materials', fv: 'materialId', fl: 'materialName', req: true }, { n: 'receivedQty', l: 'Received qty', t: 'number', req: true }, { n: 'uomId', l: 'Unit', t: 'select', fk: '/v1/uoms', fv: 'uomId', fl: 'uomCode' }, { n: 'damagedQty', l: 'Damaged qty', t: 'number' }, { n: 'varianceReason', l: 'Variance reason (if short/excess/damaged)', t: 'text' } ] }
  };
  async function openCreateDoc(endpoint) {
    var cfg = CREATE_DOC[endpoint]; if (!cfg) return;
    var fkEps = {}; cfg.header.concat(cfg.item).forEach(function (f) { if (f.fk) fkEps[f.fk] = f; });
    var fkCache = {};
    await Promise.all(Object.keys(fkEps).map(function (ep) {
      var f = fkEps[ep];
      return tunnel(ep + '?limit=100').then(function (res) {
        fkCache[ep] = ((res.json && res.json.data) || []).map(function (row) { var v = row[f.fv] != null ? row[f.fv] : guessId(row); return { v: v, l: row[f.fl] != null ? row[f.fl] : (v ? String(v).slice(0, 8) : '') }; }).filter(function (o) { return o.v; });
      }).catch(function () { fkCache[ep] = []; });
    }));
    function opts(f) { var o = '<option value="">' + (f.req ? 'Select…' : '— none —') + '</option>'; if (f.en) o += f.en.map(function (v) { return '<option>' + v + '</option>'; }).join(''); if (f.fk && fkCache[f.fk]) o += fkCache[f.fk].map(function (x) { return '<option value="' + x.v + '">' + x.l + '</option>'; }).join(''); return o; }
    // Line-item fields have no label above them (they sit in a compact row), so carry the field
    // name as a placeholder (PROC-20 — PO qty/rate + GRN qty boxes were unlabeled).
    function ctrl(f, scope) { return f.t === 'select' ? '<select data-' + scope + '="' + f.n + '" class="fld">' + opts(f) + '</select>' : '<input data-' + scope + '="' + f.n + '" type="' + (f.t === 'number' ? 'number' : f.t === 'date' ? 'date' : 'text') + '" placeholder="' + escHtml(f.l) + '" class="fld">'; }
    var headerRows = cfg.header.map(function (f) { return '<label style="display:flex;flex-direction:column;gap:5px">' + fLabel(f.l, f.req) + ctrl(f, 'h') + '</label>'; }).join('');
    var body = headerRows +
      '<div style="display:flex;align-items:center;gap:10px;margin:6px 0 0"><div class="sect" style="flex:1">Line items</div><button type="button" id="ra-addline" class="btn sm">+ Add line</button></div>' +
      '<div id="ra-lines"></div><div id="ra-merr" role="alert" style="min-height:16px;font:var(--w-med) var(--t-cap)/var(--lh-cap) var(--font-ui);color:var(--red)"></div>' +
      '<button type="submit" class="btn p" id="ra-msave" style="width:100%;justify-content:center;height:var(--ch-touch-floor-coarse-pointer)">Create</button>';
    var m = openSheet({ id: 'ra-cform', tag: 'form', style: 'max-width:560px', title: cfg.title, body: body });
    var ov = m.sheet;
    var linesEl = ov.querySelector('#ra-lines');
    function addLine() {
      var row = document.createElement('div'); row.className = 'ra-line'; row.style.cssText = 'display:flex;gap:7px;align-items:center;margin-bottom:8px';
      row.innerHTML = cfg.item.map(function (f) { return '<div style="flex:' + (f.t === 'select' ? '2' : '1') + '">' + ctrl(f, 'i') + '</div>'; }).join('') + '<button type="button" class="ra-rmline xp" aria-label="Remove line" style="flex:none">&times;</button>';
      linesEl.appendChild(row); row.querySelector('.ra-rmline').onclick = function () { row.remove(); };
    }
    for (var i = 0; i < (cfg.itemMin || 1); i++) addLine();
    ov.querySelector('#ra-addline').onclick = addLine;
    ov.onsubmit = function (e) {
      e.preventDefault(); var body2 = {}, err = '';
      cfg.header.forEach(function (f) { var el = ov.querySelector('[data-h="' + f.n + '"]'); var v = el ? String(el.value).trim() : ''; var fe = validateField(f, v); if (fe) err = err || fe; if (v) body2[f.n] = f.t === 'number' ? Number(v) : v; });
      var items = [];
      [].forEach.call(ov.querySelectorAll('.ra-line'), function (row) {
        var it = {}, has = false;
        cfg.item.forEach(function (f) { var el = row.querySelector('[data-i="' + f.n + '"]'); var v = el ? String(el.value).trim() : ''; if (v) { it[f.n] = f.t === 'number' ? Number(v) : v; has = true; } var fe = (f.req && !v && has) ? (f.l + ' is required.') : (v ? validateField(f, v) : null); if (fe) err = err || ('Line: ' + fe); });
        if (has) items.push(it);
      });
      if (items.length < (cfg.itemMin || 1)) err = err || ('Add at least ' + (cfg.itemMin || 1) + ' line item.');
      if (err) { ov.querySelector('#ra-merr').textContent = err; return; }
      body2.items = items;
      var save = ov.querySelector('#ra-msave'); save.disabled = true; save.textContent = 'Creating…';
      tunnel(endpoint, { method: 'POST', body: body2 }).then(function (res) {
        if (res.status >= 400) { save.disabled = false; save.textContent = 'Create'; ov.querySelector('#ra-merr').textContent = (res.json && res.json.error && res.json.error.message) || ('Create failed (' + res.status + ')'); return; }
        m.close(); st.search = ''; toast('Created', 'good'); loadView();
      }).catch(function () { save.disabled = false; save.textContent = 'Create'; ov.querySelector('#ra-merr').textContent = 'Can\'t connect. Try again.'; });
    };
  }


  /* ---------------- reverse traceability (M10): FG → oil → materials → vendor (owner only) ---------------- */
  /* fetch every page of a list endpoint (cursor paginated), up to a sane cap. */
  function fetchAllPages(endpoint, done) {
    var out = [], n = 0;
    function step(cursor) {
      return tunnel(endpoint + '?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')).then(function (res) {
        var j = res.json || {}; out = out.concat((j.data) || []);
        var next = j.meta && j.meta.cursor; n++;
        if (next && n < 6) return step(next);
        done(out);
      }).catch(function () { done(out); });
    }
    return step(null);
  }
  function openTrace(fg) {
    var body = '<div id="ra-trace" class="loading" style="padding:var(--s-base) 0">Tracing…</div>';
    var m = openSheet({ id: 'ra-trace-sheet', tag: 'div', style: 'max-width:560px', title: 'Traceability', body: body });
    var ov = m.sheet;
    var down = ARROW_D;
    function step(ic, title, sub, accent) {
      return '<div style="display:flex;align-items:center;gap:var(--s-snug);background:' + (accent ? 'var(--accent)' : 'var(--panel-2)') + ';color:var(--ink);border-radius:var(--r-md);padding:var(--s-snug)">' +
        '<span style="width:34px;height:34px;border-radius:var(--r-sm);background:' + (accent ? 'rgba(255,255,255,.35)' : 'var(--panel-3)') + ';color:' + (accent ? 'inherit' : 'var(--accent-ink)') + ';display:grid;place-items:center;flex:none">' + icon(ic, 17) + '</span>' +
        '<div style="flex:1;min-width:0"><div style="font:var(--w-med) var(--t-body)/1.3 var(--font-ui)">' + title + '</div><div style="font:var(--w-reg) var(--t-cap)/1.3 var(--font-ui);color:' + (accent ? 'var(--ink-2)' : 'var(--ink-3)') + '">' + sub + '</div></div></div>';
    }
    tunnel('/v1/trace/finished-good/' + fg.finishedGoodBatchId).then(function (res) {
      var el = ov.querySelector('#ra-trace');
      if (res.status >= 400 || !res.json || !res.json.data) { if (el) el.textContent = (res.json && res.json.error && res.json.error.message) || 'Trace unavailable.'; return; }
      var t = res.json.data;
      var mats = (t.materials || []).map(function (m2) {
        return '<div style="display:flex;align-items:center;gap:var(--s-tight);padding:var(--s-tight) var(--s-snug);background:var(--panel-2);border-radius:var(--r-sm);margin-bottom:var(--s-tight);flex-wrap:wrap;font:var(--w-reg) var(--t-cap)/1.3 var(--font-ui)">' +
          '<span style="font:var(--w-med) var(--t-cap)/1.3 var(--font-mono);color:var(--accent-ink)">' + m2.material + '</span>' +
          '<span style="color:var(--ink-3)">&larr; batch ' + m2.rmBatch + '</span><span style="color:var(--ink-3)">&larr; ' + m2.grn + '</span>' +
          '<span style="margin-left:auto;display:inline-flex;align-items:center;gap:var(--s-tight);font-weight:var(--w-med)">' + icon('truck', 13) + m2.vendor + '</span></div>';
      }).join('') || '<div style="color:var(--ink-3);font:var(--w-reg) var(--t-cap)/1.3 var(--font-ui);padding:var(--s-tight) 0">No upstream materials linked.</div>';
      var custStep = t.customer ? (step('users', 'Customer · ' + t.customer.name, t.customer.soNumber ? ('Sales order ' + t.customer.soNumber) : 'Shipped to', false) + down) : '';
      if (el) el.outerHTML = '<div id="ra-trace">' +
        custStep +
        step('pkg', 'Finished good · ' + t.finishedGood.batch, t.finishedGood.product + ' · ' + t.finishedGood.sku, true) + down +
        step('droplet', 'Oil batch · ' + (t.oilBatch ? t.oilBatch.batch : '—'), 'Compounded oil', false) + down +
        '<div class="sect" style="margin:var(--s-tight) 0 var(--s-snug)">Raw materials</div>' + mats + '</div>';
    }).catch(function () { var el = ov.querySelector('#ra-trace'); if (el) el.textContent = 'Can\'t connect. Try again.'; });
  }

  async function loadView() {
    var R = ROLES[st.role]; var item = R.nav.filter(function (n) { return n[0] === st.nav; })[0] || R.nav[0]; st.nav = item[0];
    $('ra-title').textContent = item[1];
    if (item[3] === '__dash__') return loadDashboard();
    // G4: `loadTutorialView` is defined in web/tutorial.js, a classic script loaded AFTER this
    // one (index.html) — by the time this branch can actually run (a nav click, always after
    // boot()), that script has already executed and the global exists. `typeof` (never a bare
    // reference) so a build that dropped tutorial.js degrades to an honest message instead of a
    // ReferenceError. RA_VIEWS/registerViews (this file's window.RA hook) is NOT wired into this
    // render path yet (see that var's own comment above) — this is the real dispatch.
    if (item[3] === '__tutorial__') { return (typeof loadTutorialView === 'function') ? loadTutorialView() : ($('ra-view').innerHTML = errBox('Tutorials aren\'t available in this build.')); }
    // Load the unit dictionary once (uomId → code) so quantity cells + create pickers read units.
    if (!st._uomsLoaded) { st._uomsLoaded = true; try { var ur = await tunnel('/v1/uoms?limit=100'); ((ur.json && ur.json.data) || []).forEach(function (u) { UOM[u.uomId] = u.uomCode || u.uomName; }); } catch (e) { st._uomsLoaded = false; } }
    var V = $('ra-view'); V.innerHTML = '<div class="loading">Loading…</div>';
    var masked = item[4] === true;
    var res;
    try { res = await tunnel(item[3] + '?limit=100'); }
    catch (e) { V.innerHTML = errBox('Can\'t connect. Try again.'); return; }
    if (res.status === 403) { V.innerHTML = errBox('Your role doesn\'t have access to this.'); return; }
    // RP-PROC-007: a route can exist but be honestly unavailable (e.g. a feature whose backing
    // table isn't provisioned yet) — surface that message instead of silently falling through to
    // "No records yet", which would wrongly imply the table is just empty.
    if (res.status >= 400) { V.innerHTML = errBox((res.json && res.json.error && res.json.error.message) || ('Not available right now (' + res.status + ').')); return; }
    var rows = (res.json && res.json.data) || [];
    // Portal-audit WS1: the envelope hoists a page's nextCursor into meta.cursor — keep it so the
    // list can page past the first 100 rows via "Load more" (previously rows >100 were unreachable).
    var cursor = (res.json && res.json.meta && res.json.meta.cursor) || null;
    // Stash the loaded page so search can filter it WITHOUT re-rendering the panel (the search input
    // is rendered once here and only #ra-results / #ra-count repaint — this kills the cursor-jump).
    st._view = { item: item, rows: rows, masked: masked, serverQ: null, serverRows: null, cursor: cursor };
    var cols = columns(rows, item[3]);
    var byStatus = {}; rows.forEach(function (r) { var s = (r.status || r.overallResult || '').toString().toLowerCase(); if (s) byStatus[s] = (byStatus[s] || 0) + 1; });
    var sKeys = Object.keys(byStatus);
    // UX-C: total + up to three real status counts. The filler tiles ("Live", a count of table
    // columns as "Fields", "DB source of truth") said nothing about the records; masking is
    // already shown by the "Aliases only" chip on the table card itself.
    var kpis = kpi(item[2], String(rows.length), 'Total') +
      sKeys.slice(0, 3).map(function (k, i) { return kpi(['activity', 'flask', 'layers'][i], String(byStatus[k]), label(k)); }).join('');
    var kpiBand = '<div class="stats">' + kpis + '</div>';
    var cdef = CREATE[item[3]] || CREATE_DOC[item[3]];
    var canNew = cdef && can(cdef.perm);
    // data-tutorial-target="ra-new-record" (G4): one generic target, valid because only ONE
    // view's "+ New" button is ever on screen at a time — a tutorial action step reaches this
    // only after its own preceding target step already navigated to the right workspace/view.
    var newBtn = canNew ? '<button id="ra-new" data-tutorial-target="ra-new-record" class="btn p">+ New</button>' : '';
    if (!rows.length && !st.search.trim()) {
      V.innerHTML = kpiBand + '<div class="card empty"><h3>No records yet</h3>' + (newBtn ? '<div style="margin-top:var(--s-base)">' + newBtn + '</div>' : '') + '</div>';
      var nb0 = $('ra-new'); if (nb0) nb0.onclick = function () { CREATE_DOC[item[3]] ? openCreateDoc(item[3]) : openCreate(item[3]); };
      return;
    }
    var shell = '<div class="card">' +
      '<div class="card-hd"><h2>' + item[1] + '</h2>' + (masked ? '<span class="chip k">Aliases only</span>' : '') +
      '<span class="n" id="ra-count"></span>' +
      '<input id="ra-search" class="fld" value="' + st.search.replace(/"/g, '') + '" placeholder="Search" aria-label="Search" style="max-width:220px;margin-left:auto">' + newBtn + '</div>' +
      '<div id="ra-results"></div></div>';
    V.innerHTML = kpiBand + shell;
    paintResults();
    var nb = $('ra-new'); if (nb) nb.onclick = function () { CREATE_DOC[item[3]] ? openCreateDoc(item[3]) : openCreate(item[3]); };
    var si = $('ra-search'); if (si) {
      si.addEventListener('input', function (e) { st.search = e.target.value; paintResults(); clearTimeout(st._st); st._st = setTimeout(searchServer, 380); });
      if (st.search) { si.focus(); si.setSelectionRange(si.value.length, si.value.length); }
    }
  }
  // Repaint ONLY the results table + count (never the search input) — client-filters the loaded page,
  // or the whole-table server matches when we have them for the current query.
  function paintResults() {
    var v = st._view; if (!v) return; var item = v.item, masked = v.masked;
    var q = st.search.trim().toLowerCase();
    var base = (q && v.serverQ === st.search.trim() && v.serverRows) ? v.serverRows : v.rows;
    var shown = base.filter(function (r) { return !q || JSON.stringify(r).toLowerCase().indexOf(q) >= 0; });
    // WS3: type-aware sort by the clicked column (asc/desc toggle). Sorts all LOADED rows on the
    // raw values (Load more loads the rest), and works for every column — including enriched ones
    // (vendorName / skuCode / aliasName) the backend can't cheaply sort. Default (no sortKey) keeps
    // the server's newest-first order.
    if (v.sortKey) {
      var sk = v.sortKey, dir = v.sortDir === 'asc' ? 1 : -1;
      shown = shown.slice().sort(function (a, b) {
        var av = a[sk], bv = b[sk], ae = (av == null || av === ''), be = (bv == null || bv === '');
        if (ae || be) return ae && be ? 0 : (ae ? 1 : -1); // blanks always last, either direction
        return cmpVals(av, bv) * dir;
      });
    }
    var cols = columns(v.rows, item[3]);
    _acts = {}; _actSeq = 0;
    var hasActions = !!ACTIONS[item[3]] || !!EDIT[item[3]] || !!PRINTABLE[item[3]] || !!DETAIL[item[3]];
    var cnt = $('ra-count'); if (cnt) cnt.textContent = shown.length + ' of ' + v.rows.length;
    var el = $('ra-results'); if (!el) return;
    if (!shown.length) {
      el.innerHTML = '<div class="empty"><h3>No results for "' + escHtml(st.search.trim()) + '"</h3><button id="ra-clear" class="btn" style="margin:var(--s-snug) auto 0">Clear search</button></div>';
      var cl = $('ra-clear'); if (cl) cl.onclick = function () { st.search = ''; var s = $('ra-search'); if (s) { s.value = ''; s.focus(); } paintResults(); };
      return;
    }
    var head = cols.map(function (c) {
      var active = v.sortKey === c; var arrow = active ? (v.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      return '<th data-sort="' + c + '" title="Sort by ' + label(c) + '"' + (active ? ' class="on"' : '') + '>' + label(c) + arrow + '</th>';
    }).join('') +
      (hasActions ? '<th class="r">Actions</th>' : '');
    // Row click drills into an inline row-expansion, not a modal (PORTING_GUIDE.md "Drawer / inline
    // detail" — the tr itself is the trigger, kept keyboard-operable with tabindex + Enter/Space
    // since it's not a native button; aria-expanded reflects open/closed state for AT).
    var clickable = !!DETAIL[item[3]];
    var body = shown.map(function (r) { var k = clickable ? ('rd' + (_actSeq++)) : ''; if (clickable) _acts[k] = { detail: true, r: r }; return '<tr' + (clickable ? ' id="' + k + '" data-k="' + k + '" class="ra-drow" style="cursor:pointer" tabindex="0" aria-expanded="false"' : '') + '>' + cols.map(function (c) { return '<td>' + fmt(c, r[c], r) + '</td>'; }).join('') +
      (hasActions ? '<td class="r">' + rowActionsCell(item[3], r) + '</td>' : '') + '</tr>'; }).join('');
    // WS1: "Load more" pages past the first 100 rows (cursor lives on the view). Hidden while a
    // search term is active — search runs its own whole-table server pass (searchServer).
    var more = (v.cursor && !q) ? '<div class="tfoot" style="justify-content:center"><button id="ra-more" class="btn sm">Load more</button></div>' : '';
    el.innerHTML = '<div style="overflow-x:auto"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' + more;
    wireActions();
    if (clickable) [].forEach.call(el.querySelectorAll('.ra-drow'), function (tr) {
      function activate(e) { if (e.target.closest('.ra-act')) return; var a = _acts[tr.getAttribute('data-k')]; if (a && a.detail) toggleRowDetail(tr, item[3], a.r); }
      tr.onclick = activate;
      tr.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); activate(e); } };
    });
    var mb = $('ra-more'); if (mb) mb.onclick = loadMore;
    // WS3: clicking a header sorts by that column; clicking the active column flips the direction.
    [].forEach.call(el.querySelectorAll('th[data-sort]'), function (th) {
      th.onclick = function () {
        var c = th.getAttribute('data-sort');
        if (v.sortKey === c) v.sortDir = v.sortDir === 'asc' ? 'desc' : 'asc';
        else { v.sortKey = c; v.sortDir = 'asc'; }
        paintResults();
      };
    });
  }
  // WS3: type-aware comparator — numbers numerically, dates chronologically, else natural-order
  // string compare; blanks/nulls always sort last regardless of direction sign at the call site.
  function cmpVals(a, b) {
    var ae = (a == null || a === ''), be = (b == null || b === '');
    if (ae || be) return ae && be ? 0 : (ae ? 1 : -1);
    var sa = String(a).trim(), sb = String(b).trim();
    if (/^-?[\d,]*\.?\d+$/.test(sa) && /^-?[\d,]*\.?\d+$/.test(sb)) return Number(sa.replace(/,/g, '')) - Number(sb.replace(/,/g, ''));
    var da = Date.parse(sa), db = Date.parse(sb);
    if (!isNaN(da) && !isNaN(db)) return da - db;
    return sa.localeCompare(sb, undefined, { numeric: true });
  }
  // WS1: fetch the next cursor page, append to the loaded rows, and repaint. Errors leave the
  // button ready to retry. When the server returns no further cursor, the button disappears.
  async function loadMore() {
    var v = st._view; if (!v || !v.cursor) return;
    var btn = $('ra-more'); if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }
    var res; try { res = await tunnel(v.item[3] + '?limit=100&cursor=' + encodeURIComponent(v.cursor)); }
    catch (e) { if (btn) { btn.textContent = 'Load more'; btn.disabled = false; } return; }
    var more = (res.json && res.json.data) || [];
    v.rows = v.rows.concat(more);
    v.cursor = (res.json && res.json.meta && res.json.meta.cursor) || null;
    paintResults();
  }
  // Whole-table search (beyond the loaded page) — updates the cache then repaints; input untouched.
  async function searchServer() {
    var v = st._view; if (!v) return; var q = st.search.trim(); if (!q) return;
    var res; try { res = await tunnel('/v1/search?resource=' + encodeURIComponent(v.item[3]) + '&q=' + encodeURIComponent(q) + '&limit=200'); } catch (e) { return; }
    if (res && res.status < 400 && res.json && res.json.data && st.search.trim() === q) { v.serverQ = q; v.serverRows = res.json.data; paintResults(); }
  }
  function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'; }); }
  // SYS-04 — shared field validation: required, max length, format (regex), numeric bounds.
  function validateField(f, v) {
    v = v == null ? '' : String(v).trim();
    if (f.req && !v) return f.l + ' is required.';
    if (!v) return null;
    if (f.maxlen && v.length > f.maxlen) return f.l + ' must be at most ' + f.maxlen + ' characters.';
    if (f.pat) { try { if (!(new RegExp('^(?:' + f.pat + ')$', 'i').test(v))) return f.patMsg || (f.l + ' is not in the expected format.'); } catch (e) {} }
    if (f.t === 'number') { var n = Number(v); if (isNaN(n)) return f.l + ' must be a number.'; if (f.min != null && n < f.min) return f.l + ' must be at least ' + f.min + '.'; if (f.max != null && n > f.max) return f.l + ' must be at most ' + f.max + '.'; }
    return null;
  }
  // NotBuilt-style: state the specific reason, per PORTING_GUIDE.md §Empty/error/loading — never a
  // generic spinner. Callers already pass a specific message (RP-PROC-007 etc.); this just frames it.
  function errBox(m) { return '<div class="card notbuilt"><h2>Couldn\'t load</h2><p>' + m + '</p></div>'; }

  // Module 12 dashboard alerts — fill the header bell from /v1/alerts (real, role-filtered counts).
  // Map an alert kind → the nav key of the screen that resolves it, for the CURRENT role.
  function alertNavKey(kind) {
    var nav = (ROLES[st.role] && ROLES[st.role].nav) || [];
    var frags = {
      approval: ['purchase-orders', 'purchase-requests', 'rfqs'],
      qc: ['qc-inspections', 'packaging-qc', 'production-qc', 'qc-result'],
      stock: ['stock-requirements', 'inventory-batches', '/v1/materials'],
      expiry: ['rm-batches', 'inventory-batches', 'rm-batch']
    }[kind] || [];
    for (var f = 0; f < frags.length; f++) {
      for (var i = 0; i < nav.length; i++) { if (String(nav[i][3]).indexOf(frags[f]) >= 0) return nav[i][0]; }
    }
    return null;
  }
  function loadAlerts() {
    tunnel('/v1/alerts').then(function (res) {
      var d = res.json && res.json.data; if (!d) return;
      // A count that went UP since the last look is news; the first load is not.
      if (window.RaSound && loadAlerts.seen != null && d.total > loadAlerts.seen) {
        RaSound.play((d.alerts || []).some(function (a) { return a.severity === 'high'; }) ? 'alert' : 'notify');
      }
      loadAlerts.seen = d.total;
      var badge = $('ra-bell-badge'); if (badge) { if (d.total > 0) { badge.textContent = d.total > 99 ? '99+' : d.total; badge.style.display = 'inline'; } else { badge.style.display = 'none'; } }
      var pop = $('ra-bell-pop'); if (!pop) return;
      pop.innerHTML = (d.alerts && d.alerts.length) ? ('<div class="sect" style="padding:var(--s-tight) var(--s-tight) var(--s-snug)">Alerts</div>' + d.alerts.map(function (a) {
        var col = a.severity === 'high' ? 'var(--red)' : (a.severity === 'med' ? 'var(--amber)' : 'var(--accent-ink)');
        var nk = alertNavKey(a.kind);
        return '<div ' + (nk ? 'data-alert-nav="' + nk + '" ' : '') + ' style="display:flex;align-items:center;gap:var(--s-snug);padding:var(--s-tight) var(--s-snug);border-radius:var(--r-sm);' + (nk ? 'cursor:pointer' : '') + '"><span class="sw-dot" style="width:8px;height:8px;border-radius:var(--r-pill);background:' + col + ';flex:none"></span><div style="flex:1;min-width:0"><div style="font:var(--w-med) var(--t-body)/1.3 var(--font-ui)">' + a.title + (nk ? ' &rsaquo;' : '') + '</div><div style="font:var(--w-reg) var(--t-cap)/1.3 var(--font-ui);color:var(--ink-3)">' + a.sub + '</div></div><span style="font:var(--w-med) var(--t-h3)/1 var(--font-ui);color:' + col + '">' + a.count + '</span></div>';
      }).join('')) : '<div class="loading" style="padding:var(--s-base)">No alerts</div>';
      [].forEach.call(pop.querySelectorAll('[data-alert-nav]'), function (el) {
        el.onclick = function (e) { e.stopPropagation(); st.nav = el.getAttribute('data-alert-nav'); st.search = ''; pop.style.display = 'none'; shell(); };
      });
    }).catch(function () {});
  }
  // Switch to another workspace the signed-in session already holds a role for — no second login
  // (addendum §5/§8). Keeps the same session/token; only st.role + the rendered rail/nav change.
  function switchRole(newRole) {
    if (!ROLES[newRole] || newRole === st.role) return;
    st.role = newRole; st.nav = ROLES[newRole].nav[0][0]; st.search = '';
    shell();
  }
  function wireShell() {
    [].forEach.call(document.querySelectorAll('[data-nav]'), function (b) { b.onclick = function () { navTo(b.getAttribute('data-nav')); }; });
    var home = function () { navTo(ROLES[st.role].nav[0][0]); };
    if ($('ra-home')) $('ra-home').onclick = home;
    if ($('ra-dock-home')) $('ra-dock-home').onclick = home;
    $('ra-logout').onclick = function () { ariaReset(); session = null; st.role = null; st.drawer = false; document.body.classList.remove('rail-off', 'rail-open', 'dock-away'); try { localStorage.removeItem('ra_rt'); } catch (e) {} showLogin(); };
    /* UX-F: the sound on/off toggle sits beside Sign out, in the reference shell's rail-min style. */
    if (window.RaSound && RaSound.mountToggle(document.querySelector('#ra-side .rme'), $('ra-logout'), 'rail-min', 'position:static;margin-left:auto')) $('ra-logout').style.marginLeft = '0';
    var wsw = $('ra-wsw'); if (wsw) wsw.onchange = function () { switchRole(wsw.value); };
    var bell = $('ra-bell'); if (bell) bell.onclick = function (e) { e.stopPropagation(); var pop = $('ra-bell-pop'); pop.style.display = pop.style.display === 'none' ? 'block' : 'none'; };
    if (!window.__raBellOutside) { window.__raBellOutside = true; document.addEventListener('click', function () { var pop = $('ra-bell-pop'); if (pop) pop.style.display = 'none'; }); }
    // The rail's own .rail-min only closes it; the dock's toggle opens and closes it (desktop:
    // body.rail-off folds the grid track; phone: body.rail-open slides it in as a drawer).
    var burger = $('ra-burger'); if (burger) burger.onclick = function () { st.drawer = false; applyResponsive(); };
    var dockToggle = $('ra-dock-toggle'); if (dockToggle) dockToggle.onclick = function () { st.drawer = !st.drawer; applyResponsive(); };
    var bg = $('ra-drawer-bg'); if (bg) bg.onclick = function () { st.drawer = false; applyResponsive(); };
    var handle = $('ra-dock-handle'); if (handle) handle.onclick = function () { document.body.classList.remove('dock-away'); };
    if ($('ra-aria')) $('ra-aria').onclick = toggleAria;
    if ($('ra-aria-dock')) $('ra-aria-dock').onclick = toggleAria;
    if (_aria) { _aria.setContext(ariaContext()); }
    applyResponsive();
    applyNetBanner();
  }
  if (!window.__raRailKeyWired) {
    window.__raRailKeyWired = true;
    // QuickDock keys: ⌘K Ask Aria (as ALEMBIC Admin/Agent), ⌘\ rail, ⌘1–9 destinations, ⌘/ the
    // go-to palette; Escape closes.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && _aria && _aria.isOpen()) { _aria.close(); return; }
      if (e.key === 'Escape' && st.drawer) { st.drawer = false; applyResponsive(); return; }
      if (!st.role || !(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'k' || e.key === 'K') { e.preventDefault(); toggleAria(); return; }
      if (e.key === '/') { e.preventDefault(); openPalette(); return; }
      if (e.key === '\\') { e.preventDefault(); st.drawer = !st.drawer; applyResponsive(); return; }
      var i = parseInt(e.key, 10), R = ROLES[st.role];
      if (i >= 1 && i <= 9 && R && R.nav[i - 1]) { e.preventDefault(); navTo(R.nav[i - 1][0]); }
    });
    // Dock retract (reference QuickDock): while the desktop rail is open the dock steps out of the
    // way at rest and returns when the pointer nears the bottom edge. With the rail folded the dock
    // IS the navigation, so rac-console.css pins it (body.rail-off .qdock).
    var awayT = null;
    document.addEventListener('mousemove', function (e) {
      if (!st.role) return;
      if (e.clientY > window.innerHeight - 64) { clearTimeout(awayT); document.body.classList.remove('dock-away'); }
      else if (!document.body.classList.contains('dock-away') && st.drawer && window.innerWidth > 1023) {
        clearTimeout(awayT); awayT = setTimeout(function () { if (st.drawer) document.body.classList.add('dock-away'); }, 2400);
      }
    }, { passive: true });
  }
  // Rail state, as the reference's useRailToggle: desktop folds the grid track (body.rail-off,
  // the default), phone opens an off-canvas drawer (body.rail-open). `inert`/`aria-hidden` keep a
  // closed rail out of the tab order and off the screen reader.
  function applyResponsive() {
    var open = !!st.drawer, phone = window.innerWidth <= 1023;
    document.body.classList.toggle('rail-off', !phone && !open);
    document.body.classList.toggle('rail-open', phone && open);
    if (!open) document.body.classList.remove('dock-away');
    var side = $('ra-side');
    if (side) {
      if (open) { side.removeAttribute('inert'); side.removeAttribute('aria-hidden'); }
      else { side.setAttribute('inert', ''); side.setAttribute('aria-hidden', 'true'); }
    }
    var t = $('ra-dock-toggle'); if (t) { t.setAttribute('aria-pressed', String(open)); t.setAttribute('aria-label', open ? 'Hide navigation' : 'Show navigation'); }
  }
  // Truthful offline/degraded banner (addendum §13): says exactly what it is — the last data
  // loaded — and never implies anything typed while offline is queued for later replay, because
  // nothing here is. Inventory/QC/production writes need the live secure channel; every write
  // path already surfaces "Could not reach the secure channel" on failure rather than queuing.
  function applyNetBanner() {
    var b = $('ra-net-banner'); if (!b) return;
    b.classList.toggle('show', navigator.onLine === false);
  }
  if (!window.__raNetWired) {
    window.__raNetWired = true;
    window.addEventListener('online', applyNetBanner);
    window.addEventListener('offline', applyNetBanner);
  }
  window.addEventListener('resize', function () { if (st.role) { applyResponsive(); } });

  /* ---------------- login ---------------- */
  // PB-04 / SB-02: password sign-in is retired for launch (FINAL_OS §2.4/§9). The only online
  // staff identity rail is ALEMBIC's — one email-OTP sign-in there, then "Open Factory" mints a
  // short-lived signed assertion this console exchanges (see `loginWithAssertion`/`boot` below)
  // for the same `{accessToken, refreshToken, user}` shape `/auth/login` used to mint, so
  // `enterPortal` and everything downstream of it is unchanged. `backend/cluster-org/src/auth/
  // auth.service.ts` refuses `/auth/login` unconditionally once APP_ENV=prod.
  //
  // UX-C: the same sign-in card as web-platform/platform.js and web-vault/vault.js (.login-wrap/
  // .login-card, web/ui-contract/shell.css) — console name, one line, one button.
  function showLogin() {
    $('app').className = '';
    $('app').innerHTML =
      '<div class="login-wrap"><div class="login-card">' +
        '<img class="brand-logo brand-logo--login" src="/logo/raw-logo.png" srcset="/logo/raw-logo.png 1x, /logo/raw-logo@2x.png 2x, /logo/raw-logo@3x.png 3x" width="88" height="40" alt="RAW Aromachem">' +
        '<h1 class="mark">Factory</h1>' +
        '<p class="sub">Raw Aroma Chem production.</p>' +
        '<a id="lb" href="' + (ALEMBIC_CONSOLE_URL || '#') + '" class="btn p"' + (ALEMBIC_CONSOLE_URL ? '' : ' aria-disabled="true"') + '>Sign in via ALEMBIC &rarr;</a>' +
        '<div id="lerr" class="err" role="alert">' + (ALEMBIC_CONSOLE_URL ? '' : 'Sign-in isn\'t set up for this build.') + '</div>' +
      '</div></div>';
  }

  /** Exchange an ALEMBIC-signed assertion for a session, the same shape `/auth/login` used
   *  to mint (`loginWithAssertion` on the RawProd backend derives roles/perms from ITS OWN
   *  `iam.user_master`, never from the assertion — see that file's header). */
  function loginWithAssertion(token) {
    return tunnel('/auth/alembic-assertion', { method: 'POST', body: { assertion: token } });
  }

  // Establish the session from a login/refresh result, persist the refresh token (survives reloads),
  // fetch real permissions, and render the shell. Returns false if NONE of the JWT's roles has a
  // portal. When it holds MORE than one, every one with a portal is kept on session.availableRoles
  // so the workspace switcher (shell(), addendum §5/§8) can move between them without a second login.
  function enterPortal(d) {
    var payload = {}; try { payload = JSON.parse(atob(d.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (x) {}
    var seen = {}, avail = (payload.roles || []).map(roleView).filter(function (r) { return ROLES[r] && !seen[r] && (seen[r] = 1); });
    var v = avail[0] || null;
    if (!ROLES[v]) return false;
    session = { token: d.accessToken, user: d.user, roles: payload.roles || [], perms: [], availableRoles: avail };
    try { if (d.refreshToken) localStorage.setItem('ra_rt', d.refreshToken); } catch (e) {}
    st.role = v; st.nav = ROLES[v].nav[0][0]; st.search = '';
    tunnel('/me').then(function (m) { var me = m.json && m.json.data; if (me && me.permissions) session.perms = me.permissions; }).catch(function () {}).then(function () { shell(); });
    return true;
  }

  // PB-04 / SB-02: a redirect back from ALEMBIC's "Open Factory" lands here with
  // `#assertion=<token>` in the URL fragment (never a query string a server would log).
  // Checked BEFORE any stored refresh token, so a fresh explicit sign-in always wins over a
  // stale one — and the fragment is scrubbed with `history.replaceState` (fires no
  // `hashchange`) before the exchange even starts, so a single-use token never lingers in the
  // address bar for longer than it takes to read it.
  function consumeAssertionFromHash() {
    var m = /(?:^|[#&])assertion=([^&]+)/.exec(location.hash);
    if (!m) return null;
    var token = decodeURIComponent(m[1]);
    history.replaceState(null, '', location.pathname + location.search);
    return loginWithAssertion(token).then(function (res) {
      var d = res.json && res.json.data;
      if (res.status < 400 && d && d.accessToken && enterPortal(d)) return;
      showLogin();
      var le = $('lerr');
      if (le) le.textContent = (res.json && res.json.error && res.json.error.message) || 'Sign-in didn\'t complete. Try again.';
    }).catch(function () {
      showLogin();
      var le = $('lerr'); if (le) le.textContent = 'Can\'t connect. Try again.';
    });
  }

  function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
    var assertionExchange = consumeAssertionFromHash();
    if (assertionExchange) { assertionExchange.then(function () {}); return; }
    var rt = null; try { rt = localStorage.getItem('ra_rt'); } catch (e) {}
    if (!rt) { showLogin(); return; }
    // Returning user — restore the session from the stored refresh token instead of forcing re-login.
    tunnel('/auth/refresh', { method: 'POST', body: { refreshToken: rt } }).then(function (res) {
      var d = res.json && res.json.data;
      if (res.status < 400 && d && d.accessToken && enterPortal(d)) return;
      try { localStorage.removeItem('ra_rt'); } catch (e) {}
      showLogin();
    }).catch(function () { try { localStorage.removeItem('ra_rt'); } catch (e) {} showLogin(); });
  }
  if (document.readyState !== 'loading') boot(); else document.addEventListener('DOMContentLoaded', boot);
