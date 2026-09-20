/* RAW AROMA — integration layer: real login + encrypted transport + live per-role data.
 *
 * TRANSPORT: an ephemeral ECDH (P-256) handshake establishes an AES-256-GCM channel key; then
 * EVERY API call — login included — is tunnelled through a single POST /rpc carrying ciphertext.
 * The DevTools Network tab shows only /crypto/handshake (public keys) + opaque /rpc blobs: no
 * readable paths, tokens, or data. AUTH: the role comes from the DB (the JWT), never self-picked.
 * DATA: after login we pull the signed-in role's real records and feed them into the design.
 */
(function () {
  'use strict';
  var API = (window.RA && window.RA.api) || location.origin.replace(/:\d+$/, ':3000');
  var VIEW = {
    owner: 'superadmin', admin: 'admin', procurement: 'procurement', receiving: 'receiving',
    qc: 'qc', warehouse: 'warehouse', compounding: 'compounding', filling: 'filling', packaging: 'packaging',
  };
  var session = null;          // { token, user, role }
  var AES_KEY = null, KEY_ID = null, handshaking = null;
  var enc = function (s) { return new TextEncoder().encode(s); };
  function b64(bytes) { var s = '', C = 0x8000; for (var i = 0; i < bytes.length; i += C) s += String.fromCharCode.apply(null, bytes.subarray(i, i + C)); return btoa(s); }
  function ub64(str) { var bin = atob(str), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }

  /* ---- encrypted channel ---- */
  function handshake() {
    if (AES_KEY) return Promise.resolve();
    if (handshaking) return handshaking;
    handshaking = (async function () {
      var kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      var clientPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      var r = await fetch(API + '/crypto/handshake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientPub: b64(clientPub) }) });
      var hs = (await r.json()).data;
      var serverKey = await crypto.subtle.importKey('raw', ub64(hs.serverPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      var shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, kp.privateKey, 256);
      var hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
      var bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc('ra-session-v1') }, hk, 256);
      AES_KEY = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      KEY_ID = hs.keyId;
    })();
    return handshaking;
  }
  async function seal(str) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, AES_KEY, enc(str)));
    var out = new Uint8Array(12 + ct.length); out.set(iv, 0); out.set(ct, 12); return b64(out);
  }
  async function open(blob) {
    var buf = ub64(blob), iv = buf.slice(0, 12), data = buf.slice(12);
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, AES_KEY, data);
    return new TextDecoder().decode(pt);
  }

  /* ---- the tunnel: one POST /rpc, everything inside is sealed ---- */
  async function tunnel(path, opts) {
    opts = opts || {};
    await handshake();
    var payload = { method: (opts.method || 'GET').toUpperCase(), path: path };
    if (opts.body !== undefined) payload.body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
    if (session) payload.token = session.token;
    var sealed = await seal(JSON.stringify(payload));
    var r = await fetch(API + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ra-key': KEY_ID }, body: JSON.stringify({ enc: sealed }) });
    var outer = await r.json();
    if (!outer || !outer.data || !outer.data.enc) { AES_KEY = null; handshaking = null; throw new Error('channel error'); }
    var inner = JSON.parse(await open(outer.data.enc));   // { status, body }
    return { status: inner.status, json: inner.body ? JSON.parse(inner.body) : null };
  }
  window.RA = window.RA || {}; window.RA.api = API;
  window.RA.session = function () { return session; };
  window.RA.fetch = tunnel; // path, {method, body} → {status, json}

  /* ---- live per-role data: map real (masked) records into the design's row format ---- */
  function short(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
  function classOf() { return 'aroma'; }
  var LOADERS = {
    compounding: async function (set) {
      var r = await tunnel('/v1/production-order-ingredients?limit=40');
      var items = r.json && r.json.data; if (!items || !items.length) return;
      // Compounding sees masked LINE CODES (alias), a weight, and progress — never the formula.
      var rows = items.map(function (it, i) {
        var code = it.aliasName || it.rmAliasId || '••••••';
        var done = it.issuedQty === true;
        return ['cl' + i, ['P-' + short(it.productionOrderId, 4).toUpperCase(), code, classOf(), (it.requiredQty || '—') + ' g', { pct: done ? 100 : 0, label: done ? 'added' : 'queued' }]];
      });
      set({ rows: rows });
    },
    superadmin: async function (set) {
      var r = await tunnel('/v1/production-orders?limit=40');
      var items = r.json && r.json.data; if (!items || !items.length) return;
      var rows = items.map(function (it, i) {
        return ['sr' + i, ['V-' + short(it.productionOrderId, 4).toUpperCase(), '—', 'Production', short(it.formulaVersionId, 6), (it.orderQty || '—'), (it.status || 'inprogress').toLowerCase()]];
      });
      set({ rows: rows });
    },
    procurement: async function (set) {
      var r = await tunnel('/v1/purchase-orders?limit=40');
      var items = r.json && r.json.data; if (!items || !items.length) return;
      var rows = items.map(function (it, i) { return ['pr' + i, ['PO-' + short(it.purchaseOrderId, 6).toUpperCase(), '—', '—', 'aroma', (it.totalAmount || '—'), (it.status || 'draft').toLowerCase()]]; });
      set({ rows: rows });
    },
    qc: async function (set) {
      var r = await tunnel('/v1/qc-inspections?limit=40');
      var items = r.json && r.json.data; if (!items || !items.length) return;
      var rows = items.map(function (it, i) { return ['qr' + i, [short(it.rmBatchId, 8), short(it.qcInspectionId, 8), 'aroma', 'Inspection', (it.overallResult || 'pending').toLowerCase()]]; });
      set({ rows: rows });
    },
  };
  // The DC runtime re-renders on screen/role change but not on a bare post-mount setState, so we
  // write live data straight into the instance's _live store BEFORE entering the role's view.
  function writeLive(view, partial) {
    window.__raLive = window.__raLive || {};
    window.__raLive[view] = Object.assign({}, window.__raLive[view] || {}, partial);
  }
  function loadInto(role) {
    var view = VIEW[role] || role; var L = LOADERS[view];
    if (!L || !window.__raApp) return Promise.resolve();
    return L(function (partial) { writeLive(view, partial); }).catch(function () {});
  }

  /* ---- login overlay (matches the neumorphic-light design) ---- */
  var DROPLET = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l5.5 6.5a7 7 0 1 1-11 0z"/></svg>';
  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  var overlay = el(
    '<div id="ra-login" style="position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#E7EAF0;font-family:\'Urbanist\',system-ui,sans-serif;padding:24px;color-scheme:light">' +
      '<form id="ra-login-card" autocomplete="on" style="width:100%;max-width:380px;background:#EAEDF3;border-radius:28px;padding:40px 34px;box-shadow:6px 6px 16px rgba(158,171,197,.55),-6px -6px 16px rgba(255,255,255,.95);text-align:center">' +
        '<div style="width:58px;height:58px;border-radius:18px;background:#117C66;display:grid;place-items:center;margin:0 auto 22px;box-shadow:4px 4px 9px rgba(158,171,197,.55),-4px -4px 9px rgba(255,255,255,.95)">' + DROPLET + '</div>' +
        '<div style="font-family:\'JetBrains Mono\',monospace;font-size:11px;letter-spacing:.18em;color:#98A1B2;font-weight:700">RAW AROMA CHEM</div>' +
        '<h1 style="font-size:28px;font-weight:800;color:#2E3543;margin:6px 0 8px;letter-spacing:-.01em">Production Portal</h1>' +
        '<p style="font-size:13.5px;line-height:1.5;color:#697182;margin:0 0 24px">Sign in. Your role is assigned by an administrator — you see only what it allows.</p>' +
        '<label style="display:block;text-align:left;font-family:\'JetBrains Mono\',monospace;font-size:10px;letter-spacing:.12em;color:#98A1B2;font-weight:700;margin:0 0 7px">EMAIL</label>' +
        '<input id="ra-email" type="email" autocomplete="username" required placeholder="you@rawaroma.local" style="width:100%;padding:13px 15px;border:none;border-radius:13px;background:#E7EAF0;box-shadow:inset 3px 3px 6px rgba(158,171,197,.55),inset -3px -3px 6px rgba(255,255,255,.95);font-size:14px;color:#2E3543;font-family:inherit;margin-bottom:16px;outline:none">' +
        '<label style="display:block;text-align:left;font-family:\'JetBrains Mono\',monospace;font-size:10px;letter-spacing:.12em;color:#98A1B2;font-weight:700;margin:0 0 7px">PASSWORD</label>' +
        '<input id="ra-pass" type="password" autocomplete="current-password" required placeholder="••••••••••" style="width:100%;padding:13px 15px;border:none;border-radius:13px;background:#E7EAF0;box-shadow:inset 3px 3px 6px rgba(158,171,197,.55),inset -3px -3px 6px rgba(255,255,255,.95);font-size:14px;color:#2E3543;font-family:inherit;margin-bottom:8px;outline:none">' +
        '<div id="ra-error" style="min-height:18px;font-size:12.5px;color:#C0492E;font-weight:600;text-align:left;margin:2px 0 12px"></div>' +
        '<button id="ra-submit" type="submit" style="width:100%;padding:15px;border:none;border-radius:15px;background:#117C66;color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:5px 5px 12px rgba(158,171,197,.55),-5px -5px 12px rgba(255,255,255,.9)">Enter portal &rarr;</button>' +
        '<div style="margin-top:14px;font-family:\'JetBrains Mono\',monospace;font-size:10px;letter-spacing:.08em;color:#9aa6b2">&#128274; END-TO-END ENCRYPTED CHANNEL</div>' +
      '</form>' +
    '</div>'
  );
  function show() { overlay.style.display = 'flex'; }
  function hide() { overlay.style.display = 'none'; }
  function setError(m) { var e = document.getElementById('ra-error'); if (e) e.textContent = m || ''; }
  function setBusy(b) { var s = document.getElementById('ra-submit'); if (s) { s.disabled = b; s.style.opacity = b ? '.6' : '1'; s.textContent = b ? 'Securing channel…' : 'Enter portal →'; } }

  function enter() {
    var view = VIEW[session.role] || 'noaccess';
    var go = function () {
      // preload the role's real data, THEN render the dashboard (first paint = live, masked data)
      loadInto(session.role).then(function () {
        window.__raApp.enterAs(view, session); hide();
      });
    };
    (function wait() { if (window.__raApp && window.__raApp.enterAs) go(); else setTimeout(wait, 60); })();
  }
  function claimRole(token) { try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).roles[0]; } catch (e) { return null; } }

  function doLogin(ev) {
    if (ev) ev.preventDefault();
    setError(''); setBusy(true);
    var id = (document.getElementById('ra-email') || {}).value, pw = (document.getElementById('ra-pass') || {}).value;
    tunnel('/auth/login', { method: 'POST', body: { identifier: id, password: pw } })
      .then(function (res) {
        setBusy(false);
        var d = res.json && res.json.data;
        if (res.status >= 400 || !d || !d.accessToken) { setError((res.json && res.json.error && res.json.error.message) || 'Invalid email or password.'); return; }
        session = { token: d.accessToken, user: d.user, role: (d.user && d.user.role) || claimRole(d.accessToken) || 'noaccess' };
        window.RA._session = session; enter();
      })
      .catch(function () { setBusy(false); setError('Cannot establish a secure connection. Try again.'); });
  }

  function mount() {
    if (overlay.parentNode !== document.documentElement) document.documentElement.appendChild(overlay);
    if (!overlay.__wired) { overlay.querySelector('#ra-login-card').addEventListener('submit', doLogin); overlay.__wired = true; }
    if (!session) show();
  }
  function init() {
    mount(); handshake().catch(function () {});
    window.addEventListener('ra-app-ready', mount);
    window.addEventListener('ra-logout', function () { session = null; window.RA._session = null; window.__raLive = null; mount(); show(); });
  }
  if (document.body) init(); else window.addEventListener('DOMContentLoaded', init);
})();
