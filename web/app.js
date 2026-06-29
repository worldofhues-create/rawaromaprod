/* RAW AROMA — DB-driven portal (clean rebuild reusing the exact design tokens).
 * Source of truth = the backend/DB. Every table shows exactly what its endpoint returns, masked
 * per the signed-in role. Transport is the encrypted tunnel (only /crypto/handshake + /rpc on the
 * wire). Role comes from the DB (the JWT), never self-picked. Responsive on every device. */
(function () {
  'use strict';
  // Backend base. Local dev → :3000. Deployed → same-origin '' (Vercel rewrites /crypto + /rpc to
  // Render, so the backend host never appears in the network tab). Override with window.RA_API.
  var API = (typeof window.RA_API === 'string') ? window.RA_API
    : (/(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(location.hostname) ? location.origin.replace(/:\d+$/, ':3000') : '');

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
  async function open(bl) { var b = ub64(bl); var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, AES, b.slice(12)); return new TextDecoder().decode(pt); }
  async function tunnel(path, opts) {
    opts = opts || {}; await handshake();
    var p = { method: (opts.method || 'GET').toUpperCase(), path: path };
    if (opts.body !== undefined) p.body = opts.body;
    if (session) p.token = session.token;
    var r = await fetch(API + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ra-key': KID }, body: JSON.stringify({ enc: await seal(JSON.stringify(p)) }) });
    var outer = await r.json(); if (!outer.data || !outer.data.enc) { AES = null; hsP = null; throw new Error('channel'); }
    var inner = JSON.parse(await open(outer.data.enc)); return { status: inner.status, json: inner.body ? JSON.parse(inner.body) : null };
  }
  window.RA = { tunnel: tunnel };

  /* ---------------- design system: skins × light/dark (the exact mockup tokens) ---------------- */
  function skinTokens(skin, dark, A) {
    if (skin === 'glass') {
      if (dark) return "--page:radial-gradient(at 16% 14%, " + A + "44, transparent 46%),radial-gradient(at 84% 8%, #3A6FB03a, transparent 42%),radial-gradient(at 74% 90%, #6B4FA83a, transparent 46%),linear-gradient(150deg,#0E131A,#0A0D12);--bg:rgba(40,48,60,.5);--surface:rgba(44,53,66,.46);--well:rgba(14,19,26,.42);--track:rgba(255,255,255,.13);--cbord:rgba(255,255,255,.16);--wbord:rgba(255,255,255,.12);--cblur:blur(20px) saturate(1.4);--border:rgba(255,255,255,.1);--rai:0 14px 38px -12px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.14);--rai-sm:0 6px 16px -8px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.1);--ins:inset 0 2px 8px rgba(0,0,0,.42);--ins-sm:inset 0 1px 4px rgba(0,0,0,.36);--t1:#EEF1F6;--t2:#AEB7C3;--t3:#7E8794;--accent:" + A + ";--accent-soft:" + A + "33;--hov:rgba(255,255,255,.06);--barmute:rgba(255,255,255,.16)";
      return "--page:radial-gradient(at 16% 14%, " + A + "33, transparent 46%),radial-gradient(at 84% 8%, #5FA8FF40, transparent 42%),radial-gradient(at 72% 92%, #B49CFF3a, transparent 46%),linear-gradient(150deg,#EEF3F7,#E3E9F0);--bg:rgba(255,255,255,.5);--surface:rgba(255,255,255,.5);--well:rgba(255,255,255,.32);--track:rgba(255,255,255,.46);--cbord:rgba(255,255,255,.7);--wbord:rgba(255,255,255,.55);--cblur:blur(20px) saturate(1.5);--border:rgba(255,255,255,.55);--rai:0 12px 34px -12px rgba(40,60,80,.3),inset 0 1px 0 rgba(255,255,255,.7);--rai-sm:0 5px 16px -8px rgba(40,60,80,.24),inset 0 1px 0 rgba(255,255,255,.6);--ins:inset 0 2px 8px rgba(40,60,80,.16);--ins-sm:inset 0 1px 4px rgba(40,60,80,.14);--t1:#1E2A33;--t2:#4F5E6B;--t3:#7C8B98;--accent:" + A + ";--accent-soft:" + A + "26;--hov:rgba(255,255,255,.4);--barmute:rgba(120,140,160,.32)";
    }
    if (skin === 'skeuomorphic') {
      if (dark) return "--page:radial-gradient(130% 70% at 50% -10%, #2C313B, transparent 70%),linear-gradient(180deg,#1B1F25,#13161C);--bg:linear-gradient(180deg,#2F343D,#272B33);--surface:linear-gradient(180deg,#323843,#262A31);--well:linear-gradient(180deg,#1B1E24,#272B32);--track:linear-gradient(180deg,#141115,#22262C);--cbord:#13161B;--wbord:#13161B;--cblur:none;--border:rgba(255,255,255,.06);--rai:0 3px 7px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06);--rai-sm:0 2px 4px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.05);--ins:inset 0 2px 6px rgba(0,0,0,.5),inset 0 -1px 0 rgba(255,255,255,.04);--ins-sm:inset 0 1px 4px rgba(0,0,0,.46);--t1:#E9ECF1;--t2:#A3ABB7;--t3:#727A86;--accent:" + A + ";--accent-soft:" + A + "33;--hov:rgba(255,255,255,.05);--barmute:rgba(255,255,255,.14)";
      return "--page:radial-gradient(130% 70% at 50% -8%, #EDF1F5, transparent 70%),linear-gradient(180deg,#DFE3E9,#CACFD9);--bg:linear-gradient(180deg,#FCFDFF,#ECEFF3);--surface:linear-gradient(180deg,#FDFEFF,#ECEFF4);--well:linear-gradient(180deg,#DFE3EA,#EFF2F6);--track:linear-gradient(180deg,#C9CFD8,#DDE2E8);--cbord:#C3C9D3;--wbord:#C3C9D3;--cblur:none;--border:rgba(40,52,68,.13);--rai:0 2px 3px rgba(40,52,68,.16),0 7px 16px -6px rgba(40,52,68,.2),inset 0 1px 0 rgba(255,255,255,.9);--rai-sm:0 1px 2px rgba(40,52,68,.2),inset 0 1px 0 rgba(255,255,255,.9);--ins:inset 0 2px 5px rgba(40,52,68,.2),inset 0 -1px 0 rgba(255,255,255,.85);--ins-sm:inset 0 1px 3px rgba(40,52,68,.18);--t1:#272D38;--t2:#5C6573;--t3:#8A94A1;--accent:" + A + ";--accent-soft:" + A + "1f;--hov:rgba(40,52,68,.05);--barmute:rgba(120,135,155,.36)";
    }
    if (dark) return "--page:#24272F;--bg:#24272F;--surface:#282C35;--well:#24272F;--track:#1C1F26;--cbord:transparent;--wbord:transparent;--cblur:none;--border:rgba(255,255,255,.07);--rai:6px 6px 15px rgba(0,0,0,.5),-6px -6px 15px rgba(255,255,255,.05);--rai-sm:4px 4px 9px rgba(0,0,0,.5),-4px -4px 9px rgba(255,255,255,.05);--ins:inset 4px 4px 10px rgba(0,0,0,.5),inset -4px -4px 10px rgba(255,255,255,.05);--ins-sm:inset 3px 3px 6px rgba(0,0,0,.5),inset -3px -3px 6px rgba(255,255,255,.05);--t1:#ECEEF3;--t2:#A6ADBA;--t3:#727A86;--accent:" + A + ";--accent-soft:" + A + "33;--hov:rgba(255,255,255,.04);--barmute:rgba(255,255,255,.13)";
    return "--page:#E7EAF0;--bg:#E7EAF0;--surface:#EAEDF3;--well:#E7EAF0;--track:#D7DCE7;--cbord:transparent;--wbord:transparent;--cblur:none;--border:rgba(120,134,162,.2);--rai:6px 6px 15px rgba(158,171,197,.55),-6px -6px 15px rgba(255,255,255,.95);--rai-sm:4px 4px 9px rgba(158,171,197,.55),-4px -4px 9px rgba(255,255,255,.95);--ins:inset 4px 4px 10px rgba(158,171,197,.55),inset -4px -4px 10px rgba(255,255,255,.95);--ins-sm:inset 3px 3px 6px rgba(158,171,197,.55),inset -3px -3px 6px rgba(255,255,255,.95);--t1:#2E3543;--t2:#697182;--t3:#98A1B2;--accent:" + A + ";--accent-soft:" + A + "1f;--hov:rgba(120,134,162,.07);--barmute:rgba(150,165,185,.4)";
  }

  var ICONS = { grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z', layers: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5', lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4', users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75', shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', clipboard: 'M9 4h6v3H9zM8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2', sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6', truck: 'M1 4h13v11H1zM14 8h4l3 3v4h-7zM6 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0M21 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0', box: 'M21 8 12 3 3 8v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8', flask: 'M9 3h6M10 3v6L5 19a1 1 0 0 0 1 1.5h12A1 1 0 0 0 19 19l-5-10V3M7.5 14h9', beaker: 'M6 3h12M8 3v7l-3 8a1 1 0 0 0 1 1.3h12A1 1 0 0 0 19 18l-3-8V3', droplet: 'M12 3l5.5 6.5a7 7 0 1 1-11 0z', tag: 'M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7 7h.01', refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', calendar: 'M3 5h18v16H3zM3 9h18M8 3v4M16 3v4', activity: 'M22 12h-4l-3 9L9 3l-3 9H2', bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0', search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3', logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', pkg: 'M16 3 4 7v10l8 4 8-4V7zM4 7l8 4 8-4M12 11v10', building: 'M3 21h18M6 21V4h8v17M14 9h4v12M9 8h.01M9 12h.01M9 16h.01', sun: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z', shelf: 'M3 7h18M3 12h18M3 17h18M7 7v10M17 7v10', mappin: 'M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11zM12 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5', panel: 'M4 4h16v16H4zM10 4v16', alert: 'M12 9v4M12 17h.01M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z' };
  function icon(k, sz) { return '<svg width="' + (sz || 18) + '" height="' + (sz || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="' + (ICONS[k] || ICONS.grid) + '"/></svg>'; }

  var STATUS = { pending: ['#F8EFD8', '#9A6B1E', '#D9A53B'], pass: ['#E2F1E9', '#2E7D55', '#34A56F'], fail: ['#FBE6E1', '#C0492E', '#D85A38'], approved: ['#E2F1E9', '#2E7D55', '#34A56F'], ordered: ['#E5EDF7', '#2D5C8A', '#3B7BC0'], draft: ['#EBEDF0', '#5A626C', '#9298A2'], received: ['#E2F1E9', '#2E7D55', '#34A56F'], inprogress: ['#E5EDF7', '#2D5C8A', '#3B7BC0'], active: ['#E2F1E9', '#2E7D55', '#34A56F'], confirmed: ['#E2F1E9', '#2E7D55', '#34A56F'], pending_approval: ['#F8EFD8', '#9A6B1E', '#D9A53B'] };

  /* ---------------- role → nav → real endpoints (Phase-1 modules, DB-driven) ---------------- */
  // nav tuple: [key, label, icon, endpoint, masked?]. Aligned to the Phase-1 module per role.
  var ROLES = {
    superadmin: { label: 'Super Admin', dept: 'Controller', user: 'Owner', nav: [
      ['runs', 'Master runs', 'layers', '/v1/production-orders'], ['formulas', 'Formula vault', 'lock', '/v1/formulas'],
      ['materials', 'Materials', 'box', '/v1/materials'], ['users', 'Users', 'users', '/v1/users'],
      ['audit', 'Audit log', 'clipboard', '/v1/formula-event-hist'] ] },
    admin: { label: 'Admin', dept: 'Access & Governance', user: 'Admin', nav: [
      ['users', 'Users', 'users', '/v1/users'], ['roles', 'Roles', 'shield', '/v1/roles'],
      ['perms', 'Permissions', 'lock', '/v1/permissions'] ] },
    procurement: { label: 'Procurement', dept: 'Procurement', user: 'Procurement', nav: [
      ['pos', 'Purchase orders', 'clipboard', '/v1/purchase-orders'], ['prs', 'Purchase requests', 'list', '/v1/purchase-requests'],
      ['vendors', 'Suppliers', 'truck', '/v1/vendors'], ['materials', 'Materials', 'box', '/v1/materials'] ] },
    receiving: { label: 'Receiving', dept: 'Receiving', user: 'Receiving', nav: [
      ['gate', 'Gate entries', 'truck', '/v1/gate-entries'], ['grns', 'Goods receipt', 'clipboard', '/v1/grns'],
      ['batches', 'Batches', 'layers', '/v1/rm-batches'] ] },
    qc: { label: 'QC Laboratory', dept: 'Quality Control', user: 'QC', nav: [
      ['queue', 'Test queue', 'flask', '/v1/qc-inspections'], ['results', 'Results', 'clipboard', '/v1/qc-result-details'],
      ['samples', 'Sample retention', 'beaker', '/v1/qc-sample-retentions'] ] },
    warehouse: { label: 'Warehouse', dept: 'Warehouse', user: 'Warehouse', nav: [
      ['stock', 'Stock', 'box', '/v1/inventory-batches'], ['rm', 'RM batches', 'layers', '/v1/rm-batches'],
      ['transfers', 'Transfers', 'refresh', '/v1/stock-transfers'], ['racks', 'Racks', 'shelf', '/v1/racks'] ] },
    compounding: { label: 'Compounding', dept: 'Compounding', user: 'Compounding', nav: [
      ['work', 'Worksheets', 'beaker', '/v1/production-order-ingredients', true], ['orders', 'Production orders', 'grid', '/v1/production-orders'],
      ['mixing', 'Mixing sessions', 'flask', '/v1/mixing-sessions'], ['oil', 'Oil batches', 'droplet', '/v1/oil-batches'] ] },
    filling: { label: 'Filling', dept: 'Filling', user: 'Filling', nav: [
      ['tickets', 'Fill tickets', 'droplet', '/v1/filling-sessions'], ['orders', 'Package orders', 'box', '/v1/package-orders'],
      ['oil', 'Bulk lots', 'layers', '/v1/oil-batches'] ] },
    packaging: { label: 'Packaging', dept: 'Packaging', user: 'Packaging', nav: [
      ['orders', 'Pack orders', 'box', '/v1/package-orders'], ['fg', 'Finished goods', 'pkg', '/v1/finished-good-batches'],
      ['skus', 'Product SKUs', 'tag', '/v1/product-skus'] ] }
  };
  // Curated, readable columns per endpoint (DB field names). Fallback = a smart generic picker.
  var COLS = {
    '/v1/users': ['userName', 'email', 'employeeCode', 'mobileNumber', 'isActive', 'status'],
    '/v1/roles': ['roleCode', 'roleName', 'status'],
    '/v1/permissions': ['permissionCode', 'moduleName', 'permissionName', 'status'],
    '/v1/production-orders': ['productionOrderId', 'orderQty', 'formulaVersionId', 'actualStartDt', 'status'],
    '/v1/production-order-ingredients': ['aliasName', 'rmAliasId', 'requiredQty', 'issuedQty', 'status'],
    '/v1/formulas': ['formulaCode', 'formulaName', 'status'],
    '/v1/formula-types': ['typeCode', 'typeName', 'status'],
    '/v1/formula-event-hist': ['eventType', 'eventDt', 'formulaId', 'remarks'],
    '/v1/materials': ['materialCode', 'materialName', 'status'],
    '/v1/rm-aliases': ['aliasName', 'materialId', 'status'],
    '/v1/vendors': ['vendorCode', 'vendorName', 'status'],
    '/v1/purchase-orders': ['poNumber', 'totalAmount', 'vendorId', 'status'],
    '/v1/purchase-requests': ['prNumber', 'requiredDate', 'status'],
    '/v1/gate-entries': ['gateEntryNumber', 'vehicleNumber', 'driverName', 'status'],
    '/v1/grns': ['grnNumber', 'batchId', 'status'],
    '/v1/rm-batches': ['batchNumber', 'vendorId', 'status'],
    '/v1/qc-inspections': ['rmBatchId', 'overallResult', 'inspectionDt', 'status'],
    '/v1/qc-result-details': ['observedValue', 'result', 'status'],
    '/v1/inventory-batches': ['rmBatchId', 'availableQty', 'reservedQty', 'status'],
    '/v1/stock-transfers': ['transferNumber', 'status'],
    '/v1/racks': ['rackCode', 'rackName', 'status'],
    '/v1/mixing-sessions': ['sessionStartDt', 'sessionEndDt', 'status'],
    '/v1/oil-batches': ['batchNumber', 'producedQty', 'producedDt', 'status'],
    '/v1/filling-sessions': ['sessionStartDt', 'sessionEndDt', 'status'],
    '/v1/package-orders': ['orderQty', 'productSkuId', 'status'],
    '/v1/finished-good-batches': ['batchNumber', 'producedQty', 'manufacturingDate', 'status'],
    '/v1/product-skus': ['skuCode', 'packSize', 'status']
  };
  // Every role opens on a rich, DB-aggregated dashboard (endpoint sentinel '__dash__' → /v1/dashboard).
  Object.keys(ROLES).forEach(function (k) {
    var label = k === 'warehouse' ? 'Floor map' : 'Dashboard';
    var ic = k === 'warehouse' ? 'mappin' : (k === 'superadmin' ? 'activity' : 'grid');
    ROLES[k].nav.unshift(['dashboard', label, ic, '__dash__']);
  });
  var VIEW = { owner: 'superadmin' };
  function roleView(r) { return VIEW[r] || r; }

  /* ---------------- state + helpers ---------------- */
  var st = { skin: 'neumorphic', dark: false, role: null, nav: null, search: '', collapsed: false, drawer: false };
  var ACCENT = '#117C66';
  var $ = function (id) { return document.getElementById(id); };
  function setTheme() { $('root').setAttribute('style', skinTokens(st.skin, st.dark, ACCENT) + ";font-family:'Urbanist',system-ui,sans-serif;color:var(--t1);min-height:100vh;color-scheme:" + (st.dark ? 'dark' : 'light')); }

  // Curate which fields to show + how, from a real row object (DB is the source).
  var HIDE = { createdDt: 1, updatedDt: 1, createdBy: 1, updatedBy: 1 };
  function sensitive(k) { return /hash|secret|token|password|salt|enc_?payload|enc_?iv|enc_?tag|encpayload|enciv|enctag|encryption|vaultlocation/i.test(k); }
  function isUuid(v) { return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/.test(v); }
  function label(k) { return k.replace(/([A-Z])/g, ' $1').replace(/Id\b/, '').replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }).trim(); }
  function fmt(k, v) {
    if (v === null || v === undefined || v === '') return '<span style="color:var(--t3)">—</span>';
    if (typeof v === 'boolean') return v ? '<span style="color:#2E7D55;font-weight:700">Yes</span>' : '<span style="color:var(--t3)">No</span>';
    if (k === 'status' || k === 'overallResult' || k === 'approvalStatus') { var s = STATUS[String(v).toLowerCase()] || ['var(--well)', 'var(--t2)', '#9298A2']; return '<span style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;background:' + s[0] + ';color:' + s[1] + '"><i style="width:6px;height:6px;border-radius:50%;background:' + s[2] + '"></i>' + v + '</span>'; }
    if (isUuid(v)) return '<span style="font-family:\'JetBrains Mono\',monospace;font-size:12px;color:var(--t2)">' + String(v).slice(0, 8).toUpperCase() + '</span>';
    if (/Dt$|Date$|_dt$/.test(k) && typeof v === 'string' && v.indexOf('T') > 0) return '<span style="color:var(--t2)">' + v.slice(0, 10) + '</span>';
    if (/code|number|alias/i.test(k)) return '<span style="font-family:\'JetBrains Mono\',monospace;font-size:12.5px;font-weight:600">' + v + '</span>';
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

  /* ---------------- render: shell + data view ---------------- */
  function shell() {
    $('app').style.display = ''; // clear the login override → .ra-shell CSS (flex desktop / block mobile)
    var R = ROLES[st.role]; var initials = (R.user || 'RA').slice(0, 2).toUpperCase();
    var navHtml = R.nav.map(function (n) {
      var on = st.nav === n[0];
      return '<button data-nav="' + n[0] + '" class="ra-nav" style="display:flex;align-items:center;gap:13px;width:100%;padding:10px 12px;border:none;border-radius:13px;cursor:pointer;font-size:13.5px;text-align:left;font-family:inherit;' +
        (on ? 'color:var(--accent);background:var(--accent-soft);box-shadow:var(--ins-sm);font-weight:700' : 'color:var(--t2);background:transparent;font-weight:600') + '">' +
        '<span style="display:grid;place-items:center;flex:none">' + icon(n[2], 18) + '</span><span class="ra-nav-l">' + n[1] + '</span></button>';
    }).join('');
    var skins = [['neumorphic', 'Neuro'], ['glass', 'Glass'], ['skeuomorphic', 'Skeuo']].map(function (s) {
      return '<button data-skin="' + s[0] + '" style="padding:7px 12px;border:none;border-radius:9px;font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;background:' + (st.skin === s[0] ? 'var(--accent)' : 'transparent') + ';color:' + (st.skin === s[0] ? '#fff' : 'var(--t3)') + '">' + s[1] + '</button>';
    }).join('');
    $('app').innerHTML =
      '<div id="ra-drawer-bg" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:40"></div>' +
      '<aside id="ra-side" style="width:256px;flex:none;background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:24px;box-shadow:var(--rai);padding:18px 14px 14px;display:flex;flex-direction:column;position:sticky;top:14px;height:calc(100vh - 28px);margin:14px 0 14px 14px;z-index:50">' +
        '<div style="display:flex;align-items:center;gap:12px;padding:0 4px 16px">' +
          '<div style="width:40px;height:40px;border-radius:13px;background:var(--accent);color:#fff;display:grid;place-items:center;box-shadow:var(--rai-sm);flex:none">' + icon('droplet', 20) + '</div>' +
          '<div style="line-height:1.15"><div style="font-weight:800;font-size:15px">Raw Aroma Chem</div><div style="font-family:\'JetBrains Mono\',monospace;font-size:9px;letter-spacing:.14em;color:var(--t3)">PRODUCTION PORTAL</div></div></div>' +
        '<div style="font-family:\'JetBrains Mono\',monospace;font-size:10px;letter-spacing:.13em;color:var(--t3);font-weight:700;padding:4px 6px 10px">' + R.dept.toUpperCase() + '</div>' +
        '<nav style="display:flex;flex-direction:column;gap:4px;overflow:auto">' + navHtml + '</nav>' +
        '<div style="margin-top:auto;display:flex;align-items:center;gap:11px;padding:12px 6px 2px;border-top:1px solid var(--border)">' +
          '<div style="width:38px;height:38px;border-radius:12px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:800;font-size:13px;flex:none">' + initials + '</div>' +
          '<div style="line-height:1.2;flex:1;min-width:0"><div style="font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + R.user + '</div><div style="font-size:11px;color:var(--t3)">' + R.label + '</div></div>' +
          '<button id="ra-logout" title="Sign out" style="border:none;background:var(--well);box-shadow:var(--ins-sm);color:var(--t2);width:34px;height:34px;border-radius:10px;cursor:pointer;display:grid;place-items:center;flex:none">' + icon('logout', 16) + '</button></div>' +
      '</aside>' +
      '<main style="flex:1;min-width:0;padding:14px 18px 24px;display:flex;flex-direction:column;gap:16px">' +
        '<header style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">' +
          '<button id="ra-burger" style="display:none;border:none;background:var(--surface);box-shadow:var(--rai-sm);color:var(--t1);width:42px;height:42px;border-radius:12px;cursor:pointer;place-items:center">' + icon('panel', 18) + '</button>' +
          '<div style="flex:1;min-width:120px"><div id="ra-title" style="font-size:21px;font-weight:800;letter-spacing:-.01em">' + R.label + '</div><div style="font-size:12.5px;color:var(--t3)">Raw Aroma Chem / ' + R.dept + '</div></div>' +
          '<div style="display:flex;align-items:center;gap:7px;background:var(--surface);border:1px solid var(--cbord);border-radius:13px;padding:5px;box-shadow:var(--rai-sm)">' + skins + '</div>' +
          '<button id="ra-dark" title="Toggle light / dark" style="border:none;background:var(--surface);box-shadow:var(--rai-sm);color:var(--t2);width:42px;height:42px;border-radius:13px;cursor:pointer;display:grid;place-items:center">' + icon(st.dark ? 'sun' : 'moon', 18) + '</button>' +
        '</header>' +
        '<section id="ra-view"></section>' +
      '</main>';
    wireShell();
    setTheme();
    loadView();
  }

  function kpi(ic, value, lab) {
    return '<div style="flex:1;min-width:180px;background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:18px;box-shadow:var(--rai);padding:18px 20px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between"><div style="width:40px;height:40px;border-radius:12px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center">' + icon(ic, 20) + '</div></div>' +
      '<div style="font-size:30px;font-weight:800;margin:14px 0 2px;letter-spacing:-.02em">' + value + '</div>' +
      '<div style="font-size:12.5px;color:var(--t3);font-weight:600">' + lab + '</div></div>';
  }

  /* ================= rich dashboards (the original mockup designs, real DB data) ================= */
  // Olfactive family palette (the mockup's CLS) — recolours per light/dark.
  var CLS = { natural: ['#2E6B4A', '#5FBF93', 'Natural'], aroma: ['#2D5C8A', '#5C9BDA', 'Aroma chem'], base: ['#9A6B1E', '#D6A24A', 'Base'], solvent: ['#5A626C', '#9AA3B2', 'Solvent'] };
  function clsCol(k) { var c = CLS[k] || CLS.aroma; return st.dark ? c[1] : c[0]; }
  function card(inner, pad, extra) { return '<div style="background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:20px;box-shadow:var(--rai);padding:' + (pad || '20px') + ';' + (extra || '') + '">' + inner + '</div>'; }
  function badge(ic, txt) { return '<div style="display:inline-flex;align-items:center;gap:7px;font-family:\'JetBrains Mono\',monospace;font-size:9.5px;letter-spacing:.16em;font-weight:700;color:var(--t3)"><span style="display:grid;place-items:center;width:24px;height:24px;border-radius:8px;background:var(--accent-soft);color:var(--accent)">' + icon(ic, 13) + '</span>' + txt + '</div>'; }
  function relTime(ts) {
    if (!ts) return ''; var t = Date.parse(String(ts).replace(' ', 'T')); if (isNaN(t)) return '';
    var s = Math.max(1, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago'; var m = Math.round(s / 60); if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60); if (h < 24) return h + 'h ago'; var d = Math.round(h / 24);
    return d === 1 ? 'Yesterday' : d + 'd ago';
  }
  // Deterministic mini bar-chart (the kpiBars motif) — stable per value, decorative chrome.
  function miniBars(seed) {
    var s = (Math.abs(Math.round(seed)) || 3) % 9973 + 7, out = '';
    for (var i = 0; i < 7; i++) { s = (s * 48271) % 2147483647 || 7; var h = 5 + (s % 18); out += '<i style="flex:1;border-radius:2px 2px 1px 1px;height:' + h + 'px;background:' + (i === 6 ? 'var(--accent)' : 'var(--barmute)') + '"></i>'; }
    return '<div style="display:flex;align-items:flex-end;gap:3px;height:24px;margin-top:14px">' + out + '</div>';
  }
  function kpiRich(ic, value, lab, chip, seed) {
    return '<div style="flex:1;min-width:185px;background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:18px;box-shadow:var(--rai);padding:17px 19px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between"><div style="width:38px;height:38px;border-radius:11px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center">' + icon(ic, 19) + '</div>' +
      (chip ? '<span style="font-size:11px;font-weight:800;padding:4px 9px;border-radius:999px;background:var(--bg);color:var(--t3);box-shadow:var(--ins-sm)">' + chip + '</span>' : '') + '</div>' +
      '<div style="font-size:29px;font-weight:800;margin:13px 0 1px;letter-spacing:-.02em">' + value + '</div>' +
      '<div style="font-size:12.5px;color:var(--t3);font-weight:600">' + lab + '</div>' + miniBars(seed) + '</div>';
  }
  // SVG ring gauge / donut.
  function ring(pct, center, sub, color) {
    var C = 2 * Math.PI * 52, dash = (C * Math.max(0, Math.min(100, pct)) / 100).toFixed(1) + ' ' + C.toFixed(1);
    return '<div style="position:relative;width:140px;height:140px;margin:0 auto"><svg width="140" height="140" viewBox="0 0 140 140" style="transform:rotate(-90deg)">' +
      '<circle cx="70" cy="70" r="52" fill="none" stroke="var(--track)" stroke-width="13"/>' +
      '<circle cx="70" cy="70" r="52" fill="none" stroke="' + (color || 'var(--accent)') + '" stroke-width="13" stroke-linecap="round" stroke-dasharray="' + dash + '"/></svg>' +
      '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center"><div style="font-size:26px;font-weight:800;letter-spacing:-.02em">' + center + '</div>' +
      '<div style="font-size:10px;font-family:\'JetBrains Mono\',monospace;letter-spacing:.1em;color:var(--t3);text-transform:uppercase">' + (sub || '') + '</div></div></div>';
  }
  // The three-card hero band (mockup buildCelox): INSIGHT · PIPELINE SIGNALS · OUTPUT(donut).
  var NOTE = {
    superadmin: 'Every run is tied to its real product here — and only here. Below the vault, codes go anonymous.',
    procurement: 'Purchasing is tracking to plan — supplier lead times are holding and reorders are clearing on time.',
    receiving: 'Inbound is flowing — most deliveries matched their POs on the first pass with no holds raised.',
    qc: 'Quality is on target — the pass rate holds near threshold with a short retest queue.',
    compounding: 'Compounding is tracking to schedule — mixing sessions are progressing against masked worksheets.',
    filling: 'Filling output is steady — bulk lots are feeding the line with no shortfalls.',
    packaging: 'Packaging is keeping pace — finished-goods batches are sealing and labelling on schedule.',
    admin: 'Access is healthy — active users are stable and roles are fully defined.',
    warehouse: 'Storage is balanced — themed zones are within capacity with flammables held apart.'
  };
  function gaugeFor(p, role) {
    if (role === 'qc') return [p.counts.qcPassRate, 'Pass rate'];
    if (role === 'warehouse') return [p.counts.zoneCapAvg, 'Capacity'];
    if (role === 'admin') return [p.counts.usersTotal ? Math.round(p.counts.usersActive / p.counts.usersTotal * 100) : 0, 'Active users'];
    return [p.planActual.pct, 'Planned & actual'];
  }
  function heroBand(p, role, kset) {
    var hero = kset[0], sig = [kset[1], kset[2], kset[3]];
    var g = gaugeFor(p, role), gc = g[0] >= 70 ? 'var(--accent)' : (g[0] >= 40 ? '#E0A33B' : '#D85A38');
    var insight = card(
      badge('activity', 'INSIGHT') +
      '<div style="font-size:40px;font-weight:800;letter-spacing:-.03em;margin:16px 0 2px">' + hero[1] + '</div>' +
      '<div style="font-size:13px;color:var(--t2);font-weight:700">' + hero[2] + '</div>' +
      '<p style="font-size:12.5px;line-height:1.55;color:var(--t3);margin:14px 0 0">' + (NOTE[role] || NOTE.superadmin) + '</p>' +
      miniBars((hero[1] + '').length * 31 + 5), '22px');
    var rows = sig.map(function (m, i) {
      var dot = ['#D85A38', '#E0A33B', 'var(--accent)'][i];
      return '<div style="display:flex;align-items:center;gap:11px;padding:9px 0;border-bottom:1px solid var(--border)">' +
        '<i style="width:8px;height:8px;border-radius:3px;background:' + dot + ';flex:none"></i>' +
        '<div style="flex:1;font-size:13px;font-weight:600;color:var(--t2)">' + m[2] + '</div>' +
        '<div style="font-size:16px;font-weight:800">' + m[1] + '</div></div>';
    }).join('');
    var signals = card(badge('alert', 'PIPELINE SIGNALS') + '<div style="margin-top:14px">' + rows + '</div>', '22px');
    var output = card(badge('layers', 'OUTPUT') + '<div style="margin:16px 0 4px">' + ring(g[0], g[0] + '%', g[1], gc) + '</div>' +
      '<div style="display:flex;gap:10px;margin-top:6px">' +
      [kset[1], kset[2]].map(function (m, i) { return '<div style="flex:1;background:var(--well);box-shadow:var(--ins-sm);border-radius:12px;padding:10px 12px"><div style="font-size:9px;font-family:\'JetBrains Mono\',monospace;letter-spacing:.1em;color:var(--t3)">' + ['TOP', 'MED'][i] + '</div><div style="font-size:13px;font-weight:800;margin-top:2px">' + m[1] + '</div><div style="font-size:10.5px;color:var(--t3)">' + m[2] + '</div></div>'; }).join('') +
      '</div>', '22px');
    return '<div data-grid style="display:grid;grid-template-columns:1.25fr 1fr 1fr;gap:14px">' + insight + signals + output + '</div>';
  }
  // Side panel — donut / bars / feed / pipeline (mockup buildSide), real data.
  function sideDonut(p) {
    var q = p.qc, tot = q.pass + q.fail, pct = tot ? Math.round(q.pass / tot * 100) : 0;
    var legend = [['Pass', q.pass, '#34A56F'], ['Fail', q.fail, '#D85A38'], ['Pending', q.pending, '#D9A53B']].map(function (l) {
      return '<div style="display:flex;align-items:center;gap:9px;padding:7px 0"><i style="width:9px;height:9px;border-radius:3px;background:' + l[2] + '"></i><div style="flex:1;font-size:13px;color:var(--t2);font-weight:600">' + l[0] + '</div><div style="font-weight:800">' + l[1] + '</div></div>';
    }).join('');
    return '<div style="margin:6px 0 10px">' + ring(pct, pct + '%', 'Pass', '#34A56F') + '</div>' + legend;
  }
  function sideBars(items) {
    return items.map(function (it) {
      return '<div style="padding:9px 0"><div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:7px"><span style="font-weight:700;color:var(--t2)">' + it.label + '</span><span style="font-weight:800">' + it.pct + '%</span></div>' +
        '<div style="height:9px;border-radius:5px;background:var(--well);box-shadow:var(--ins-sm);overflow:hidden"><i style="display:block;width:' + it.pct + '%;height:100%;background:' + clsCol(it.cls) + ';border-radius:5px"></i></div></div>';
    }).join('');
  }
  function sidePipe(items) {
    var max = Math.max.apply(null, items.map(function (i) { return i[1]; })) || 1;
    return items.map(function (it) {
      return '<div style="display:flex;align-items:center;gap:11px;padding:6px 0"><div style="width:86px;font-size:12px;font-weight:700;color:var(--t2);flex:none">' + it[0] + '</div>' +
        '<div style="flex:1;height:9px;border-radius:5px;background:var(--well);box-shadow:var(--ins-sm);overflow:hidden"><i style="display:block;width:' + Math.round(it[1] / max * 100) + '%;height:100%;background:var(--accent);opacity:.85;border-radius:5px"></i></div>' +
        '<div style="width:26px;text-align:right;font-weight:800;font-size:13px">' + it[1] + '</div></div>';
    }).join('');
  }
  function sideFeed(items) {
    if (!items.length) return '<div style="color:var(--t3);font-size:13px;padding:20px 0">No recent activity.</div>';
    return items.map(function (it) {
      return '<div style="display:flex;gap:11px;padding:10px 0;border-bottom:1px solid var(--border)"><i style="width:8px;height:8px;border-radius:50%;background:' + it.dot + ';margin-top:5px;flex:none"></i>' +
        '<div style="flex:1"><div style="font-size:13px;font-weight:600;color:var(--t1);line-height:1.4">' + it.text + '</div><div style="font-size:11px;color:var(--t3);margin-top:2px">' + relTime(it.ts) + '</div></div></div>';
    }).join('');
  }
  function sidePanel(p, role) {
    var spec = {
      superadmin: ['Production pipeline', 'Units in flight across the floor', sidePipe(p.pipeline)],
      procurement: ['Spend by supplier', 'Share of PO value', sideBars(p.spendByVendor)],
      qc: ['Batch results', "Today's testing outcomes", sideDonut(p)],
      receiving: ['Dock activity', 'Inbound, latest first', sideFeed(p.feed)],
      filling: ['Line activity', 'Filling line, latest first', sideFeed(p.feed)],
      packaging: ['Packaging activity', 'Finished goods, latest first', sideFeed(p.feed)],
      admin: ['Audit log', 'Recent governance events', sideFeed(p.feed)],
      compounding: ['Mixing room', 'Recent activity', sideFeed(p.feed)]
    }[role] || ['Activity', 'Latest first', sideFeed(p.feed)];
    return card('<div style="font-weight:800;font-size:15px">' + spec[0] + '</div><div style="font-size:12px;color:var(--t3);margin:2px 0 12px">' + spec[1] + '</div>' + spec[2]);
  }
  // Super-Admin chain of custody — the REAL 24-step flow grouped into 10 stages, with the formula-
  // vault masking boundary in its true position (after Formula Selection). Flex layout (no absolute
  // coords) so it stays correct + responsive. Data is live from /v1/dashboard.flow.
  var FLOW_PRE = [['stockPlanning', 'Stock planning', 'list'], ['procurement', 'Procurement', 'clipboard'], ['receiving', 'Receiving', 'truck'], ['qc', 'Quality control', 'flask'], ['storage', 'Inventory storage', 'box']];
  var FLOW_POST = [['compounding', 'Compounding', 'beaker'], ['productionQc', 'Production QC', 'activity'], ['packaging', 'Packaging', 'pkg'], ['salesDispatch', 'Sales & dispatch', 'truck']];
  var ARROW_R = '<span style="display:grid;place-items:center;color:var(--t3);flex:none;align-self:center"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>';
  var ARROW_D = '<div style="display:flex;justify-content:center;padding:3px 0"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--t3)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg></div>';
  function stageCard(num, name, ic, stage, masked) {
    stage = stage || { count: 0, codes: [] };
    var codes = (stage.codes || []).map(function (c) {
      return '<div style="display:flex;flex-direction:column;padding:3px 0"><span style="font-family:\'JetBrains Mono\',monospace;font-size:12px;font-weight:700;color:' + (masked ? 'var(--t2)' : 'var(--accent)') + '">' + c.code + '</span><span style="font-size:10px;color:var(--t3)">' + c.sub + '</span></div>';
    }).join('') || '<div style="font-size:11px;color:var(--t3);padding:3px 0">—</div>';
    return '<div style="flex:1;min-width:152px;background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:14px;box-shadow:var(--rai-sm);padding:12px 13px">' +
      '<div style="display:flex;align-items:center;gap:7px;margin-bottom:8px">' +
      '<span style="width:21px;height:21px;border-radius:7px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;font-size:11px;font-weight:800;flex:none">' + num + '</span>' +
      '<span style="display:grid;place-items:center;color:var(--t2);flex:none">' + icon(ic, 14) + '</span>' +
      '<span style="font-weight:700;font-size:12.5px;flex:1;line-height:1.1;letter-spacing:-.01em">' + name + '</span>' +
      '<span style="font-size:10px;font-family:\'JetBrains Mono\',monospace;color:var(--t3);flex:none">' + stage.count + '</span></div>' + codes + '</div>';
  }
  function flowRow(metas, p, start, masked) {
    var parts = [];
    metas.forEach(function (m, i) {
      parts.push(stageCard(start + i, m[1], m[2], p.flow[m[0]], masked));
      if (i < metas.length - 1) parts.push(ARROW_R);
    });
    return '<div style="display:flex;align-items:stretch;gap:7px;flex-wrap:wrap">' + parts.join('') + '</div>';
  }
  function flowGraph(p) {
    var rev = p.reveal.product, fv = p.flow.formula || { count: 0, codes: [] };
    var fcodes = (fv.codes || []).map(function (c) { return c.code; }).join(' · ');
    var sub = rev ? ('selects ' + (fcodes || 'the formula') + ' — everything below shows aliases only') : ('protected — ' + fv.count + ' formulas sealed');
    var vault = '<div style="display:flex;align-items:center;gap:13px;background:var(--accent);color:#fff;border-radius:16px;padding:14px 18px;box-shadow:var(--rai-sm)">' +
      '<span style="width:40px;height:40px;border-radius:12px;background:rgba(255,255,255,.18);display:grid;place-items:center;flex:none">' + icon('lock', 20) + '</span>' +
      '<div style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap"><span style="font-weight:800;font-size:14px">6 · Formula selection</span><span style="font-size:9px;font-family:\'JetBrains Mono\',monospace;letter-spacing:.12em;opacity:.85">VAULT · MASKING BOUNDARY</span></div>' +
      '<div style="font-size:11.5px;opacity:.92;margin-top:2px">' + sub + '</div></div>' +
      '<span style="font-size:10px;font-family:\'JetBrains Mono\',monospace;opacity:.85;flex:none">' + fv.count + ' formulas</span></div>';
    function divider(txt, col) { return '<div style="display:flex;align-items:center;gap:10px;margin:4px 0"><span style="font-size:10px;font-family:\'JetBrains Mono\',monospace;color:' + col + ';letter-spacing:.12em;flex:none">' + txt + '</span><div style="flex:1;height:1px;background:var(--border)"></div></div>'; }
    return card(
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px"><div style="flex:1"><div style="font-weight:800;font-size:16px">Chain of custody</div><div style="font-size:12px;color:var(--t3)">The real 24-step flow · stock planning &rarr; customer delivery</div></div>' +
      '<span style="font-family:\'JetBrains Mono\',monospace;font-size:10px;color:var(--accent);border:1px solid var(--accent-soft);border-radius:8px;padding:4px 9px;flex:none">' + (rev ? 'IDENTITY VISIBLE' : 'ANONYMISED') + '</span></div>' +
      divider('IDENTITY VISIBLE', 'var(--t3)') +
      flowRow(FLOW_PRE, p, 1, false) +
      ARROW_D + vault + ARROW_D +
      divider('&#128274; ANONYMISED — ALIASES ONLY', 'var(--accent)') +
      flowRow(FLOW_POST, p, 7, true) +
      '<div style="font-size:10.5px;color:var(--t3);margin-top:12px;line-height:1.5">1 stock planning &middot; 2 procurement (PR&rarr;RFQ&rarr;quote&rarr;PO) &middot; 3 receiving (gate&rarr;GRN&rarr;batch) &middot; 4 QC &middot; 5 storage &middot; 6 formula vault &middot; 7 compounding (pick&rarr;issue&rarr;mix&rarr;oil) &middot; 8 production QC &middot; 9 packaging (fill&rarr;FG) &middot; 10 sales &amp; dispatch.</div>'
    , '18px 20px');
  }
  function runsTable(p) {
    var head = ['Run', 'Product', 'Stage', 'Batch', 'Target', 'Status'].map(function (h) { return '<th style="padding:13px 22px;text-align:left;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--t3);border-bottom:1px solid var(--border);white-space:nowrap">' + h + '</th>'; }).join('');
    var body = p.runs.map(function (r) {
      return '<tr><td style="padding:13px 22px;border-bottom:1px solid var(--border);font-family:\'JetBrains Mono\',monospace;font-size:12.5px;font-weight:700">' + r.run + '</td>' +
        '<td style="padding:13px 22px;border-bottom:1px solid var(--border);font-weight:700;font-size:13px">' + r.product + '</td>' +
        '<td style="padding:13px 22px;border-bottom:1px solid var(--border);font-size:13px;color:var(--t2)">' + r.stage + '</td>' +
        '<td style="padding:13px 22px;border-bottom:1px solid var(--border);font-family:\'JetBrains Mono\',monospace;font-size:12.5px">' + r.batch + '</td>' +
        '<td style="padding:13px 22px;border-bottom:1px solid var(--border);font-size:13px">' + r.target + '</td>' +
        '<td style="padding:13px 22px;border-bottom:1px solid var(--border)">' + fmt('status', r.status) + '</td></tr>';
    }).join('');
    return card('<div style="font-weight:800;font-size:15px;padding:4px 4px 14px">Master run index</div><div style="overflow-x:auto"><table style="width:100%;min-width:620px;border-collapse:collapse"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>', '12px 6px 6px');
  }
  // Warehouse floor zone map (mockup buildWarehouse), real zones + rack counts + batch occupancy.
  function warehouseMap(p) {
    var zones = p.zones.map(function (z) {
      var capCol = z.capPct >= 85 ? '#D85A38' : (z.capPct >= 65 ? '#E0A33B' : 'var(--accent)');
      var cells = ''; for (var i = 0; i < 12; i++) { var on = i < Math.round(z.capPct / 100 * 12); cells += '<i style="border-radius:3px;height:16px;background:' + (on ? clsCol(z.cls) : 'var(--well)') + ';box-shadow:' + (on ? 'none' : 'var(--ins-sm)') + '"></i>'; }
      return '<div style="background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:18px;box-shadow:var(--rai);padding:17px 18px">' +
        '<div style="display:flex;align-items:center;gap:9px;margin-bottom:3px"><i style="width:11px;height:11px;border-radius:4px;background:' + clsCol(z.cls) + '"></i><div style="font-weight:800;font-size:14.5px;flex:1">' + z.name + '</div>' + (z.code === 'Z4' ? '<span style="font-size:9px;font-family:\'JetBrains Mono\',monospace;color:#C0492E;border:1px solid #D85A3833;border-radius:6px;padding:2px 6px">FLAMMABLE</span>' : '') + '</div>' +
        '<div style="font-size:11.5px;color:var(--t3);margin-bottom:12px">' + z.racks + ' racks · ' + z.batches + ' batches stored</div>' +
        '<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:5px;margin-bottom:12px">' + cells + '</div>' +
        '<div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:6px"><span style="color:var(--t3);font-weight:600">Capacity used</span><span style="font-weight:800;color:' + capCol + '">' + z.capPct + '%</span></div>' +
        '<div style="height:9px;border-radius:5px;background:var(--well);box-shadow:var(--ins-sm);overflow:hidden"><i style="display:block;width:' + z.capPct + '%;height:100%;background:' + capCol + ';border-radius:5px"></i></div></div>';
    }).join('');
    var workSeed = p.counts.skusStored * 7 + p.counts.invOnHand;
    var bars = ''; var s = workSeed; for (var i = 0; i < 14; i++) { s = (s * 48271) % 2147483647 || 11; var h = 14 + (s % 46); bars += '<i style="flex:1;border-radius:3px 3px 0 0;height:' + h + 'px;background:var(--accent);opacity:.82"></i>'; }
    var workload = card(badge('activity', 'STORAGE WORKLOAD') + '<div style="display:flex;align-items:flex-end;gap:4px;height:74px;margin:16px 0 4px">' + bars + '</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:10px;font-family:\'JetBrains Mono\',monospace;color:var(--t3)"><span>06:00</span><span>12:00</span><span>18:00</span></div>', '20px');
    return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin-bottom:16px">' + zones + '</div>' +
      '<div data-grid style="display:grid;grid-template-columns:1fr 1fr;gap:14px">' + workload +
      card('<div style="font-weight:800;font-size:15px;margin-bottom:4px">Floor summary</div><div style="font-size:12.5px;color:var(--t3);margin-bottom:14px">Live totals across the warehouse</div>' +
        [['SKUs stored', p.counts.skusStored], ['Units on hand', p.counts.invOnHand], ['Storage zones', p.counts.zones], ['Total racks', p.counts.racks]].map(function (r) {
          return '<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border)"><span style="font-size:13px;color:var(--t2);font-weight:600">' + r[0] + '</span><span style="font-weight:800;font-size:15px">' + r[1] + '</span></div>';
        }).join('')) + '</div>';
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
      compounding: [['beaker', c.mixing, 'Mixing sessions'], ['layers', c.runsActive, 'Active runs'], ['droplet', c.oilBatches, 'Oil batches'], ['activity', p.planActual.pct + '%', 'Plan attainment']],
      filling: [['droplet', c.fillSessions, 'Fill sessions'], ['activity', c.unitsFilled.toLocaleString(), 'Units filled'], ['layers', c.oilBatches, 'Bulk lots'], ['box', c.packageOrders, 'Pack orders']],
      packaging: [['box', c.packageOrders, 'Pack orders'], ['pkg', c.fgBatches, 'Finished batches'], ['activity', c.unitsPacked.toLocaleString(), 'Units packed'], ['truck', c.salesOrders, 'Sales orders']]
    };
    return (S[role] || S.superadmin).map(function (k) { var v = String(k[1]); return [k[0], v, k[2], '', (parseInt(v, 10) || v.length) * 13 + 3]; });
  }
  async function loadDashboard() {
    var V = $('ra-view'); V.innerHTML = '<div style="padding:60px;text-align:center;color:var(--t3);font-family:\'JetBrains Mono\',monospace;font-size:12px">LOADING · ENCRYPTED CHANNEL…</div>';
    var res;
    try { res = await tunnel('/v1/dashboard'); } catch (e) { V.innerHTML = errBox('Could not reach the secure channel.'); return; }
    if (res.status === 403) { V.innerHTML = errBox('Your role does not have a dashboard yet.'); return; }
    var p = res.json && res.json.data;
    if (!p) { V.innerHTML = errBox('No dashboard data returned.'); return; }
    st.dash = p;
    var role = st.role, kset = kpiSet(p, role);
    var kpis = '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:16px">' + kset.map(function (k) { return kpiRich(k[0], k[1], k[2], k[3], k[4]); }).join('') + '</div>';
    var html = kpis;
    if (role === 'warehouse') {
      html += warehouseMap(p);
    } else if (role === 'superadmin') {
      html += '<div style="margin-bottom:16px">' + heroBand(p, role, kset) + '</div>' + '<div style="margin-bottom:16px">' + flowGraph(p) + '</div>' +
        '<div data-grid style="display:grid;grid-template-columns:1.6fr 1fr;gap:14px">' + runsTable(p) + sidePanel(p, role) + '</div>';
    } else {
      html += '<div style="margin-bottom:16px">' + heroBand(p, role, kset) + '</div>' + sidePanel(p, role);
    }
    V.innerHTML = html;
    applyDashCols();
  }
  // Stack multi-column dashboard grids on narrow screens (remembers each grid's desktop template).
  function applyDashCols() {
    var narrow = window.innerWidth <= 980;
    [].forEach.call(document.querySelectorAll('#ra-view [data-grid]'), function (el) {
      if (!el.getAttribute('data-cols')) el.setAttribute('data-cols', el.style.gridTemplateColumns);
      el.style.gridTemplateColumns = narrow ? '1fr' : el.getAttribute('data-cols');
    });
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
  var ACTIONS = {
    '/v1/purchase-requests': [
      { label: 'Submit', perm: 'procurement:purchase_request:write', when: function (r) { return UP(r.status) === 'DRAFT'; }, path: function (r) { return '/v1/purchase-requests/' + r.purchaseRequestId + '/submit'; }, body: { approvalLevel: 1 } },
      { label: 'Approve', perm: 'procurement:purchase_request:write', tone: 'good', when: function (r) { return UP(r.status) === 'SUBMITTED'; }, path: function (r) { return '/v1/purchase-requests/' + r.purchaseRequestId + '/approve'; }, body: {} }
    ],
    '/v1/purchase-orders': [
      { label: 'Approve', perm: 'procurement:purchase_order:write', tone: 'good', when: function (r) { return UP(r.status) === 'DRAFT'; }, path: function (r) { return '/v1/purchase-orders/' + r.purchaseOrderId + '/approve'; }, body: {} },
      { label: 'Issue', perm: 'procurement:purchase_order:write', when: function (r) { return ['ISSUED', 'ACKNOWLEDGED', 'DRAFT'].indexOf(UP(r.status)) < 0; }, path: function (r) { return '/v1/purchase-orders/' + r.purchaseOrderId + '/issue'; }, body: {} },
      { label: 'Acknowledge', perm: 'procurement:purchase_order:write', when: function (r) { return UP(r.status) === 'ISSUED'; }, path: function (r) { return '/v1/purchase-orders/' + r.purchaseOrderId + '/acknowledge'; }, body: {} }
    ],
    '/v1/rm-batches': [
      { label: 'Release to stock', perm: 'inventory:rm_batch_master:write', when: function (r) { return UP(r.status) !== 'RELEASED'; }, path: function (r) { return '/v1/rm-batches/' + r.rmBatchId + '/release'; }, body: {} }
    ],
    '/v1/qc-inspections': [
      { label: 'Accept', perm: 'quality:qc_inspections:write', tone: 'good', when: function () { return true; }, path: function (r) { return '/v1/qc-inspections/' + r.qcInspectionId + '/disposition'; }, body: { dispositionCode: 'ACCEPT' } },
      { label: 'Reject', perm: 'quality:qc_inspections:write', tone: 'bad', when: function () { return true; }, path: function (r) { return '/v1/qc-inspections/' + r.qcInspectionId + '/disposition'; }, body: { dispositionCode: 'REJECT' } },
      { label: 'Rework', perm: 'quality:qc_inspections:write', tone: 'warn', when: function () { return true; }, path: function (r) { return '/v1/qc-inspections/' + r.qcInspectionId + '/disposition'; }, body: { dispositionCode: 'REWORK' } }
    ],
    '/v1/mixing-sessions': [
      { label: 'End session', perm: 'production:secure_mixing_session:write', when: function (r) { return UP(r.status).indexOf('PROGRESS') >= 0; }, path: function (r) { return '/v1/mixing-sessions/' + r.secureMixingSessionId + '/end'; }, body: {} }
    ],
    '/v1/filling-sessions': [
      { label: 'End fill', perm: 'packaging:filling_session:write', when: function (r) { return UP(r.status) !== 'DONE'; }, path: function (r) { return '/v1/filling-sessions/' + r.fillingSessionId + '/end'; }, body: {} }
    ]
  };
  function actionsFor(endpoint, r) { var defs = ACTIONS[endpoint]; return defs ? defs.filter(function (a) { return can(a.perm) && a.when(r); }) : null; }
  function rowActionsCell(endpoint, r) {
    var avail = actionsFor(endpoint, r);
    if (!avail || !avail.length) return '<span style="color:var(--t3);font-size:11px">—</span>';
    return avail.map(function (a) {
      var bg = a.tone === 'bad' ? '#C0492E' : a.tone === 'warn' ? '#9A6B1E' : a.tone === 'good' ? '#2E7D55' : 'var(--accent)';
      var body = a.body === null ? '' : JSON.stringify(a.body).replace(/'/g, '&#39;');
      return '<button class="ra-act" data-path="' + a.path(r) + '" data-body=\'' + body + '\' style="margin:2px 4px 2px 0;padding:6px 12px;border:none;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;color:#fff;background:' + bg + ';box-shadow:var(--rai-sm);white-space:nowrap">' + a.label + '</button>';
    }).join('');
  }
  function toast(msg, tone) {
    var t = document.createElement('div'); t.textContent = msg;
    t.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:300;padding:11px 20px;border-radius:13px;font-size:13px;font-weight:700;color:#fff;box-shadow:0 12px 34px rgba(0,0,0,.28);background:' + (tone === 'bad' ? '#C0492E' : '#1D9E75');
    document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .35s'; t.style.opacity = '0'; setTimeout(function () { if (t.parentNode) t.remove(); }, 360); }, 1900);
  }
  function wireActions() {
    [].forEach.call(document.querySelectorAll('.ra-act'), function (b) {
      b.onclick = async function () {
        var path = b.getAttribute('data-path'), bodyStr = b.getAttribute('data-body'), old = b.textContent;
        b.disabled = true; b.style.opacity = '.6'; b.textContent = '…';
        try {
          var opts = { method: 'POST' }; if (bodyStr) { try { opts.body = JSON.parse(bodyStr); } catch (e) {} }
          var res = await tunnel(path, opts);
          if (res.status >= 400) { b.disabled = false; b.style.opacity = '1'; b.textContent = old; toast((res.json && res.json.error && res.json.error.message) || ('Action failed (' + res.status + ')'), 'bad'); return; }
          toast(old + ' done ✓', 'good'); loadView();
        } catch (e) { b.disabled = false; b.style.opacity = '1'; b.textContent = old; toast('Could not reach the secure channel', 'bad'); }
      };
    });
  }

  async function loadView() {
    var R = ROLES[st.role]; var item = R.nav.filter(function (n) { return n[0] === st.nav; })[0] || R.nav[0]; st.nav = item[0];
    $('ra-title').textContent = item[1];
    if (item[3] === '__dash__') return loadDashboard();
    var V = $('ra-view'); V.innerHTML = '<div style="padding:60px;text-align:center;color:var(--t3);font-family:\'JetBrains Mono\',monospace;font-size:12px">LOADING · ENCRYPTED CHANNEL…</div>';
    var masked = item[4] === true;
    var res;
    try { res = await tunnel(item[3] + '?limit=100'); } catch (e) { V.innerHTML = errBox('Could not reach the secure channel.'); return; }
    if (res.status === 403) { V.innerHTML = errBox('Your role does not have access to this data.'); return; }
    var rows = (res.json && res.json.data) || [];
    var cols = columns(rows, item[3]);
    // KPIs from the real data (counts + status breakdown)
    var byStatus = {}; rows.forEach(function (r) { var s = (r.status || r.overallResult || '').toString().toLowerCase(); if (s) byStatus[s] = (byStatus[s] || 0) + 1; });
    var sKeys = Object.keys(byStatus);
    var kpis = kpi(item[2], String(rows.length), 'Total ' + item[1].toLowerCase()) +
      (sKeys[0] ? kpi('activity', String(byStatus[sKeys[0]]), label(sKeys[0])) : kpi('grid', '—', 'Live')) +
      (sKeys[1] ? kpi('flask', String(byStatus[sKeys[1]]), label(sKeys[1])) : kpi('layers', cols.length ? String(cols.length) : '—', 'Fields')) +
      kpi('lock', masked ? 'Masked' : 'Live', masked ? 'Alias-protected' : 'DB source of truth');
    var table;
    if (!rows.length) {
      table = '<div style="background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:20px;box-shadow:var(--rai);padding:48px;text-align:center"><div style="color:var(--t2);font-weight:700;margin-bottom:6px">No records yet</div><div style="font-size:13px;color:var(--t3)">This table is empty in the database. It fills as the ' + item[1].toLowerCase() + ' module is used.</div></div>';
    } else {
      var q = st.search.trim().toLowerCase();
      var shown = rows.filter(function (r) { return !q || JSON.stringify(r).toLowerCase().indexOf(q) >= 0; });
      var hasActions = !!ACTIONS[item[3]];
      var head = cols.map(function (c) { return '<th style="padding:13px 22px;text-align:left;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--t3);border-bottom:1px solid var(--border);white-space:nowrap">' + label(c) + '</th>'; }).join('') +
        (hasActions ? '<th style="padding:13px 22px;text-align:right;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--t3);border-bottom:1px solid var(--border);white-space:nowrap">Actions</th>' : '');
      var body = shown.map(function (r) { return '<tr>' + cols.map(function (c) { return '<td style="padding:14px 22px;border-bottom:1px solid var(--border);white-space:nowrap;font-size:13px;color:var(--t1)">' + fmt(c, r[c]) + '</td>'; }).join('') +
        (hasActions ? '<td style="padding:10px 22px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap">' + rowActionsCell(item[3], r) + '</td>' : '') + '</tr>'; }).join('');
      table = '<div style="background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:20px;box-shadow:var(--rai);overflow:hidden">' +
        '<div style="display:flex;align-items:center;gap:12px;padding:16px 22px;flex-wrap:wrap"><div style="font-weight:800;font-size:15px;flex:1">' + item[1] + (masked ? ' <span style="font-size:11px;color:var(--accent);font-family:\'JetBrains Mono\',monospace">· ALIASES ONLY</span>' : '') + '</div>' +
        '<div style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--t3)">' + shown.length + ' of ' + rows.length + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;background:var(--well);border:1px solid var(--wbord);border-radius:11px;padding:8px 13px;box-shadow:var(--ins-sm);color:var(--t3)">' + icon('search', 15) + '<input id="ra-search" value="' + st.search.replace(/"/g, '') + '" placeholder="Search…" style="border:none;background:none;outline:none;font-family:inherit;font-size:13px;color:var(--t1);width:130px"></div></div>' +
        '<div style="overflow-x:auto"><table style="width:100%;min-width:560px;border-collapse:collapse"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div></div>';
    }
    V.innerHTML = '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:16px">' + kpis + '</div>' + table;
    wireActions();
    var si = $('ra-search'); if (si) si.addEventListener('input', function (e) { st.search = e.target.value; loadView(); setTimeout(function () { var s2 = $('ra-search'); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } }, 0); });
  }
  function errBox(m) { return '<div style="background:var(--surface);border:1px solid var(--cbord);border-radius:20px;box-shadow:var(--rai);padding:40px;text-align:center;color:#C0492E;font-weight:600">' + m + '</div>'; }

  // Theme changes only re-apply the CSS variables + restyle the toggles — NO data re-fetch.
  // Every card/table reads var(--*), so they recolor instantly without re-rendering.
  function repaintTheme() {
    setTheme();
    [].forEach.call(document.querySelectorAll('[data-skin]'), function (b) {
      var on = b.getAttribute('data-skin') === st.skin;
      b.style.background = on ? 'var(--accent)' : 'transparent'; b.style.color = on ? '#fff' : 'var(--t3)';
    });
    var d = $('ra-dark'); if (d) d.innerHTML = icon(st.dark ? 'sun' : 'moon', 18);
  }
  function wireShell() {
    [].forEach.call(document.querySelectorAll('[data-nav]'), function (b) { b.onclick = function () { if (st.nav === b.getAttribute('data-nav') && !st.drawer) return; st.nav = b.getAttribute('data-nav'); st.search = ''; st.drawer = false; shell(); }; });
    [].forEach.call(document.querySelectorAll('[data-skin]'), function (b) { b.onclick = function () { st.skin = b.getAttribute('data-skin'); repaintTheme(); }; });
    $('ra-dark').onclick = function () { st.dark = !st.dark; repaintTheme(); };
    $('ra-logout').onclick = function () { session = null; st.role = null; showLogin(); };
    var burger = $('ra-burger'); if (burger) burger.onclick = function () { st.drawer = !st.drawer; applyResponsive(); };
    var bg = $('ra-drawer-bg'); if (bg) bg.onclick = function () { st.drawer = false; applyResponsive(); };
    applyResponsive();
  }
  function applyResponsive() {
    var mobile = window.innerWidth <= 860; var side = $('ra-side'), burger = $('ra-burger'), bg = $('ra-drawer-bg');
    if (!side) return;
    if (mobile) {
      burger.style.display = 'grid';
      side.style.position = 'fixed'; side.style.top = '0'; side.style.left = '0'; side.style.height = '100vh'; side.style.margin = '0'; side.style.borderRadius = '0 22px 22px 0';
      side.style.transform = st.drawer ? 'translateX(0)' : 'translateX(-110%)'; side.style.transition = 'transform .28s cubic-bezier(.4,0,.2,1)';
      bg.style.display = st.drawer ? 'block' : 'none';
    } else {
      burger.style.display = 'none'; bg.style.display = 'none';
      side.style.position = 'sticky'; side.style.top = '14px'; side.style.height = 'calc(100vh - 28px)'; side.style.margin = '14px 0 14px 14px'; side.style.borderRadius = '24px'; side.style.transform = 'none';
    }
  }
  window.addEventListener('resize', function () { if (st.role) { applyResponsive(); applyDashCols(); } });

  /* ---------------- login ---------------- */
  function showLogin() {
    $('app').style.display = 'block'; // login is a single centered card, not the sidebar+main flex
    $('app').innerHTML =
      '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">' +
      '<form id="lf" style="width:100%;max-width:380px;background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:28px;padding:40px 34px;box-shadow:var(--rai);text-align:center">' +
        '<div style="width:58px;height:58px;border-radius:18px;background:var(--accent);color:#fff;display:grid;place-items:center;margin:0 auto 22px;box-shadow:var(--rai-sm)">' + icon('droplet', 26) + '</div>' +
        '<div style="font-family:\'JetBrains Mono\',monospace;font-size:11px;letter-spacing:.18em;color:var(--t3);font-weight:700">RAW AROMA CHEM</div>' +
        '<h1 style="font-size:28px;font-weight:800;margin:6px 0 8px;letter-spacing:-.01em">Production Portal</h1>' +
        '<p style="font-size:13.5px;line-height:1.5;color:var(--t3);margin:0 0 24px">Sign in. Your role is assigned by an administrator — you see only what it allows.</p>' +
        '<input id="le" type="email" autocomplete="username" required placeholder="you@rawaroma.local" style="width:100%;padding:13px 15px;border:none;border-radius:13px;background:var(--well);box-shadow:var(--ins-sm);font-size:14px;color:var(--t1);font-family:inherit;margin-bottom:14px;outline:none">' +
        '<input id="lp" type="password" autocomplete="current-password" required placeholder="Password" style="width:100%;padding:13px 15px;border:none;border-radius:13px;background:var(--well);box-shadow:var(--ins-sm);font-size:14px;color:var(--t1);font-family:inherit;margin-bottom:8px;outline:none">' +
        '<div id="lerr" style="min-height:18px;font-size:12.5px;color:#C0492E;font-weight:600;text-align:left;margin:2px 0 12px"></div>' +
        '<button id="lb" type="submit" style="width:100%;padding:15px;border:none;border-radius:15px;background:var(--accent);color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:var(--rai-sm)">Enter portal &rarr;</button>' +
        '<div style="margin-top:14px;font-family:\'JetBrains Mono\',monospace;font-size:10px;letter-spacing:.08em;color:var(--t3)">&#128274; END-TO-END ENCRYPTED CHANNEL</div>' +
      '</form></div>';
    setTheme();
    $('lf').onsubmit = function (e) {
      e.preventDefault(); var lb = $('lb'), le = $('lerr'); le.textContent = ''; lb.disabled = true; lb.textContent = 'Securing channel…';
      tunnel('/auth/login', { method: 'POST', body: { identifier: $('le').value, password: $('lp').value } }).then(function (res) {
        lb.disabled = false; lb.innerHTML = 'Enter portal &rarr;';
        var d = res.json && res.json.data;
        if (res.status >= 400 || !d || !d.accessToken) { le.textContent = (res.json && res.json.error && res.json.error.message) || 'Invalid email or password.'; return; }
        var payload = {}; try { payload = JSON.parse(atob(d.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (x) {}
        var role = (payload.roles || [])[0] || null;
        session = { token: d.accessToken, user: d.user, roles: payload.roles || [], perms: payload.permissions || [] };
        var v = roleView(role); if (!ROLES[v]) { le.textContent = 'No portal is assigned to your role yet.'; session = null; return; }
        st.role = v; st.nav = ROLES[v].nav[0][0]; st.search = ''; shell();
      }).catch(function () { lb.disabled = false; lb.innerHTML = 'Enter portal &rarr;'; le.textContent = 'Cannot establish a secure connection.'; });
    };
  }

  function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
    showLogin();
  }
  if (document.readyState !== 'loading') boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
