/* Platform Operations console — installable PWA for platform_super_admin only. Built from
 * EXISTING admin/platform endpoints (backend/backend-kernel/src/health,
 * backend/cluster-platform/src/flags, backend/api/src/audit). No business-data caching
 * (see sw.js — API calls are network-only); no tenant business data or Formula Vault
 * plaintext is ever requested or rendered here (this console has no formula:* permission
 * at all — platform_super_admin's grant is `platform:flag:write` + `iam:user_master:read`
 * only, per scripts/ra-roles.ts).
 *
 * Tenant list, provider health, deeper (outbox/worker-lag) diagnostics, and deployment/build
 * identity are backed by `backend/api/src/platform-ops` (§6/§113 — `platformops:console:read`,
 * platform_super_admin only, fail-closed for every other role). A caller who reaches this
 * console without that permission (e.g. holding only `iam:user_master:read`) still sees an
 * honest "unavailable — missing permission" card on those screens rather than a silent 403 or
 * fabricated data; "no fake data, no dead controls" still holds.
 */
(function () {
  'use strict';

  var API = (typeof window.PLATFORM_API === 'string') ? window.PLATFORM_API
    : (/(localhost|127\.0\.0\.1)/.test(location.hostname) ? location.origin.replace(/:\d+$/, ':3000') : '');

  /* ---- encrypted tunnel (own implementation, same wire contract as backend/api/src/crypto;
     verified against session-keys.service.ts's exact HKDF salt/info + iv|ct|tag layout) ---- */
  var aesKey = null, keyId = null, handshakePromise = null;
  function te(s) { return new TextEncoder().encode(s); }
  function b64(bytes) { var s = '', CHUNK = 0x8000; for (var i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)); return btoa(s); }
  function ub64(s) { var bin = atob(s), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function handshake() {
    if (aesKey) return Promise.resolve();
    if (handshakePromise) return handshakePromise;
    handshakePromise = (async function () {
      var kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      var pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      var res = await fetch(API + '/crypto/handshake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientPub: b64(pub) }) });
      var hs = (await res.json()).data;
      var serverKey = await crypto.subtle.importKey('raw', ub64(hs.serverPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      var shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, kp.privateKey, 256);
      var hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
      var bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te('ra-session-v1') }, hk, 256);
      aesKey = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      keyId = hs.keyId;
    })();
    return handshakePromise;
  }
  async function seal(pt) { var iv = crypto.getRandomValues(new Uint8Array(12)); var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, aesKey, te(pt))); var out = new Uint8Array(12 + ct.length); out.set(iv, 0); out.set(ct, 12); return b64(out); }
  async function open(blob) { var raw = ub64(blob); var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, aesKey, raw.slice(12)); return new TextDecoder().decode(pt); }
  async function tunnel(path, opts) {
    opts = opts || {};
    await handshake();
    var payload = { method: (opts.method || 'GET').toUpperCase(), path: path };
    if (opts.body !== undefined) payload.body = opts.body;
    if (session.token) payload.token = session.token;
    var res = await fetch(API + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ra-key': keyId }, body: JSON.stringify({ enc: await seal(JSON.stringify(payload)) }) });
    var envelope = await res.json();
    if (!envelope || !envelope.enc) { aesKey = null; handshakePromise = null; throw new PlatformError('NETWORK', 'Could not reach the backend. Try again.', 0); }
    var inner = JSON.parse(await open(envelope.enc));
    var body = inner.body ? JSON.parse(inner.body) : null;
    return { status: inner.status, json: body };
  }
  function PlatformError(code, message, status) { this.code = code; this.message = message; this.status = status; }
  PlatformError.prototype = Object.create(Error.prototype);
  async function api(path, opts) {
    var r = await tunnel(path, opts);
    if (r.status >= 400) { var err = (r.json && r.json.error) || {}; throw new PlatformError(err.code || 'UNKNOWN', err.message || ('Request failed (' + r.status + ')'), r.status); }
    return r.json ? r.json.data : null;
  }

  /* Health is @Public() — usable to prove connectivity even before login, but the rest of
   * the console still requires a platform_super_admin session. */
  function publicHealth() {
    return fetch(API + '/health').then(function (r) { return r.json(); });
  }

  /* ---- session (in-memory; a reload returns to login — no persisted admin credential) ---- */
  var session = { token: null, iat: 0, email: null, roles: [], permissions: [] };
  function hasPerm(p) { return session.permissions.indexOf(p) >= 0; }

  /* PB-04 / SB-02: password sign-in is retired for launch (FINAL_OS §2.4/§9). The only
   * online staff identity rail is ALEMBIC's — one email-OTP sign-in there buys a short-lived
   * signed assertion this console exchanges for its OWN session, exactly the shape
   * `POST /auth/login` used to mint. `backend/cluster-org/src/auth/auth.service.ts` refuses
   * `/auth/login` unconditionally once APP_ENV=prod, so this is not merely the preferred
   * door — it is, in production, the only one. */
  async function loginWithAssertion(assertion) {
    var data = await api('/auth/alembic-assertion', { method: 'POST', body: { assertion: assertion } });
    session.token = data.accessToken;
    session.email = (data.user && data.user.email) || null;
    var me = await api('/me');
    session.roles = me.roles || [];
    session.permissions = me.permissions || [];
  }
  function logout() { session.token = null; session.email = null; session.roles = []; session.permissions = []; location.hash = ''; render(); }

  /* Where "Sign in via ALEMBIC" sends the browser: ALEMBIC's own console, which mints the
   * assertion and returns here with it in the URL FRAGMENT (never a query string a server
   * would log) at `#assertion=<token>`. Set at deploy time, same convention as `PLATFORM_API`
   * above — unset is an honest "not configured" card, never a guessed URL. */
  var ALEMBIC_CONSOLE_URL = (typeof window.ALEMBIC_CONSOLE_URL === 'string') ? window.ALEMBIC_CONSOLE_URL : '';

  /* Consumes `#assertion=...` left in the URL by an ALEMBIC redirect, exchanges it for a
   * session, and scrubs the fragment with `history.replaceState` — which does NOT fire
   * `hashchange`, so this cannot loop back into itself. A single-use token is worthless a
   * moment after this call regardless, but it should not sit in the address bar either. */
  var consumingAssertion = false;
  async function tryConsumeAssertion() {
    var m = /(?:^|[#&])assertion=([^&]+)/.exec(location.hash);
    if (!m || consumingAssertion) return false;
    consumingAssertion = true;
    var token = decodeURIComponent(m[1]);
    // Scrub the fragment BEFORE the exchange — a single-use token must not sit in the address
    // bar even for the duration of one network round trip.
    history.replaceState(null, '', location.pathname + location.search);
    try {
      await loginWithAssertion(token);
      if (!hasPerm('platform:flag:write') && !hasPerm('iam:user_master:read') && !hasPerm('platformops:console:read')) {
        toast('Signed in, but this account holds no Platform Operations permission. Contact an admin for the platform_super_admin role.', true);
        logout();
      }
    } catch (e) {
      toast('Could not complete sign-in from ALEMBIC: ' + ((e instanceof PlatformError) ? e.message : 'unknown error'), true);
    }
    consumingAssertion = false;
    return true;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  /* ---- tiny DOM helpers (own copy — this console shares no code with web-vault either) ---- */
  function h(tag, attrs, children) {
    var el = document.createElement(tag); attrs = attrs || {};
    for (var k in attrs) {
      if (k === 'class') el.className = attrs[k];
      else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c == null) return; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function icon(path, size) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', size || 14); svg.setAttribute('height', size || 14);
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('class', 'ic');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', path); svg.appendChild(p);
    return svg;
  }
  var ICONS = {
    activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
    sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    building: 'M3 21h18M6 21V4h8v17M14 9h4v12M9 8h.01M9 12h.01M9 16h.01',
    clipboard: 'M9 4h6v3H9zM8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2',
    tag: 'M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7 7h.01',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    menu: 'M3 6h18M3 12h18M3 18h18',
  };
  function toast(msg, bad) { var t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, [h('span', { class: 'd' }), msg]); document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3400); }
  var dialogRoot = null;
  function closeDialog() { if (dialogRoot) { dialogRoot.remove(); dialogRoot = null; } }
  function openDialog(title, bodyFn) {
    closeDialog();
    var scrim = h('div', { class: 'xp-scrim open', onclick: closeDialog });
    var body = h('div', { class: 'xp-sheet-bd' });
    var sheet = h('div', { class: 'xp-sheet open', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      [h('div', { class: 'xp-sheet-hd' }, [h('h2', {}, [title]), h('button', { class: 'xp', 'aria-label': 'Close', onclick: closeDialog }, ['×'])]), body]);
    sheet.addEventListener('click', function (e) { e.stopPropagation(); });
    dialogRoot = h('div', {}, [scrim, sheet]);
    document.body.appendChild(dialogRoot);
    bodyFn(body, closeDialog);
    document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { closeDialog(); document.removeEventListener('keydown', onKey); } });
  }
  function fmtDt(v) { if (!v) return '—'; var d = new Date(v); return isNaN(d) ? String(v) : d.toLocaleString(); }
  function notBuilt(title, why, needs) {
    return h('div', { class: 'card notbuilt' }, [h('h2', {}, [title]), h('p', {}, [why]), needs ? h('div', { class: 'needs' }, [needs]) : null]);
  }
  function skeletonCard() { return h('div', { class: 'card' }, [h('div', { class: 'skl' })]); }

  window.addEventListener('hashchange', render);
  function currentView() { return location.hash.replace(/^#\/?/, '') || 'health'; }

  var root = document.getElementById('root');

  /* PB-04 / SB-02: no password form. The only door is ALEMBIC — a platform_super_admin
   * signs in there (email OTP) and clicks "Open Platform", which lands here with an
   * assertion this console exchanges automatically (see `tryConsumeAssertion` above). This
   * screen renders only when there is no session AND no assertion in the URL to consume. */
  function renderLogin() {
    root.innerHTML = '';
    var err = h('div', { class: 'err' });
    var goBtn = h('a', {
      class: 'btn p', style: 'width:100%;justify-content:center;text-decoration:none',
      href: ALEMBIC_CONSOLE_URL || '#',
    }, ['Sign in via ALEMBIC →']);
    if (!ALEMBIC_CONSOLE_URL) {
      goBtn.setAttribute('aria-disabled', 'true');
      goBtn.style.opacity = '0.5'; goBtn.style.pointerEvents = 'none';
      err.textContent = 'This build has no ALEMBIC console configured (ALEMBIC_CONSOLE_URL is unset).';
    }
    var card = h('div', { class: 'login-card' }, [
      h('div', { class: 'mark' }, ['Platform Operations']),
      h('div', { class: 'sub' }, ['Raw Aroma Chem — internal only. Never shows tenant business data or Formula Vault plaintext.']),
      h('p', { style: 'color:var(--ink-3)' }, ['Sign in on ALEMBIC, then choose "Open Platform" — one login, no separate password.']),
      goBtn, err,
    ]);
    root.appendChild(h('div', { class: 'login-wrap' }, [card]));
  }

  var NAV = [
    { id: 'health', label: 'Environment & diagnostics', icon: 'activity' },
    { id: 'flags', label: 'Feature flags', icon: 'sliders', need: 'platform:flag:write' },
    { id: 'tenants', label: 'Tenant list', icon: 'building' },
    { id: 'providers', label: 'Provider health', icon: 'activity' },
    { id: 'deploy', label: 'Deployment / build', icon: 'tag' },
    { id: 'support', label: 'Audit & support', icon: 'clipboard' },
  ];

  function renderShell(activeView, contentEl) {
    root.innerHTML = '';
    var navButtons = NAV.filter(function (n) { return !n.need || hasPerm(n.need); }).map(function (n) {
      return h('button', { class: 'ri' + (n.id === activeView ? ' on' : ''), onclick: function () { location.hash = '#/' + n.id; } }, [icon(ICONS[n.icon]), h('span', { class: 'nm' }, [n.label])]);
    });
    var rail = h('nav', { class: 'rail' }, [
      h('button', { class: 'rb' }, [h('div', {}, [h('div', { class: 'mark' }, ['Platform Ops']), h('div', { class: 'sub' }, ['INTERNAL ONLY'])])]),
      h('div', { class: 'rail-deep' }, [h('div', { class: 'rs' }, ['OPERATIONS']), h('div', {}, navButtons)]),
      h('div', { class: 'rme' }, [
        h('span', { class: 'av' }, [(session.email || '?').slice(0, 2).toUpperCase()]),
        h('span', { class: 'who' }, [session.email]),
        h('button', { class: 'btn sm', style: 'margin-left:auto', onclick: logout, 'aria-label': 'Sign out' }, [icon(ICONS.logout, 14)]),
      ]),
    ]);
    var banner = h('div', { class: 'platform-banner' }, [
      h('span', { class: 'dot' }), h('span', {}, ['PLATFORM OPERATIONS']), h('span', { class: 'vault-mark' }, ['INTERNAL']),
      h('span', {}, ['— no tenant business data or Formula Vault plaintext is ever available in this console.']),
      h('span', { class: 'who-when' }, [session.email + ' · ' + new Date().toLocaleString()]),
    ]);
    var toggle = h('button', { class: 'rail-toggle', 'aria-label': 'Toggle navigation', onclick: function () { rail.classList.toggle('open'); } }, [icon(ICONS.menu, 18)]);
    var label = (NAV.filter(function (n) { return n.id === activeView; })[0] || {}).label || 'Platform Operations';
    var main = h('div', { class: 'main' }, [banner, h('div', { class: 'bar' }, [toggle, h('h1', {}, [label])]), h('div', { class: 'content' }, [contentEl])]);
    root.appendChild(h('div', { class: 'app' }, [rail, main]));
  }

  /* ── environment & diagnostics (real: GET /health + GET /v1/platform/health) ─────────────── */
  async function screenHealth() {
    var content = h('div', {}, [skeletonCard()]);
    renderShell('health', content);
    try {
      var r = await publicHealth();
      var tiles = Object.keys(r.deps || {}).map(function (k) {
        return h('div', { class: 'health-tile' }, [h('div', { class: 'k' }, [k]), h('div', { class: 'v' }, [h('span', { class: 'chip ' + (r.deps[k] === 'up' ? 'g' : 'r') }, [r.deps[k]])])]);
      });
      var card = h('div', { class: 'card' }, [
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Environment health']), h('span', { class: 'chip ' + (r.status === 'ok' ? 'g' : 'a') }, [r.status])]),
        h('p', { style: 'color:var(--ink-3);margin-bottom:12px' }, ['Checked ' + fmtDt(r.at) + '. Source: GET /health (liveness + dependency probe).']),
        h('div', { class: 'health-grid' }, tiles),
      ]);
      content.innerHTML = ''; content.appendChild(card);
      if (!hasPerm('platformops:console:read')) {
        content.appendChild(notBuilt('Deeper diagnostics unavailable', 'Your role does not hold platformops:console:read.'));
        return;
      }
      try {
        var deep = await api('/v1/platform/health');
        var outboxRows = (deep.outbox || []).map(function (o) {
          return h('tr', {}, [
            h('td', { 'data-label': 'Schema' }, [o.schema]),
            h('td', { 'data-label': 'Backlog' }, [h('span', { class: 'chip ' + (o.backlog > 0 ? 'a' : 'g') }, [String(o.backlog)])]),
            h('td', { 'data-label': 'Oldest unpublished' }, [o.oldestUnpublishedSeconds != null ? (Math.round(o.oldestUnpublishedSeconds) + 's') : '—']),
          ]);
        });
        var diagCard = h('div', { class: 'card' }, [
          h('div', { class: 'card-hd' }, [h('h2', {}, ['Outbox backlog / worker lag'])]),
          h('p', { style: 'color:var(--ink-3);margin-bottom:12px' }, [deep.note]),
          outboxRows.length
            ? h('table', {}, [h('thead', {}, [h('tr', {}, [h('th', {}, ['Schema']), h('th', {}, ['Backlog']), h('th', {}, ['Oldest unpublished'])])]), h('tbody', {}, outboxRows)])
            : h('div', { class: 'empty' }, [h('h3', {}, ['No outbox tables found'])]),
        ]);
        content.appendChild(diagCard);
      } catch (e) {
        content.appendChild(notBuilt('Deeper diagnostics could not be loaded', e.message));
      }
    } catch (e) {
      content.innerHTML = ''; content.appendChild(notBuilt('Health check failed', e.message));
    }
  }

  /* ── feature flags (real: GET /v1/flags/snapshot, PUT /v1/admin/flags/:key) ───────────────── */
  async function screenFlags() {
    var content = h('div', {}, [skeletonCard()]);
    renderShell('flags', content);
    if (!hasPerm('platform:flag:write')) {
      content.innerHTML = ''; content.appendChild(notBuilt('Feature flags unavailable', 'Your role does not hold platform:flag:write.'));
      return;
    }
    try {
      var snap = await api('/v1/flags/snapshot');
      var rows = (snap.flags || []).map(function (f) {
        return h('tr', {}, [
          h('td', { class: 'mono', 'data-label': 'Key' }, [f.key]),
          h('td', { 'data-label': 'State' }, [h('span', { class: 'chip ' + (f.state === 'on' ? 'g' : f.state === 'degraded' ? 'a' : 'r') }, [f.state])]),
          h('td', { 'data-label': 'Action' }, [h('button', { class: 'btn sm', onclick: function () { toggleFlagDialog(f); } }, ['Change'])]),
        ]);
      });
      var card = h('div', { class: 'card' }, [
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Feature flags']), h('span', { class: 'n' }, ['snapshot v' + snap.version])]),
        rows.length ? h('table', {}, [h('thead', {}, [h('tr', {}, [h('th', {}, ['Key']), h('th', {}, ['State']), h('th', {}, ['Action'])])]), h('tbody', {}, rows)]) : h('div', { class: 'empty' }, [h('h3', {}, ['No flags registered'])]),
      ]);
      content.innerHTML = ''; content.appendChild(card);
    } catch (e) {
      content.innerHTML = ''; content.appendChild(notBuilt('Feature flags could not be loaded', e.message));
    }
  }
  function toggleFlagDialog(flag) {
    openDialog('Change flag: ' + flag.key, function (body, close) {
      var err = h('div', { class: 'err' });
      var env = h('select', { class: 'fld', style: 'width:100%' }, [h('option', { value: 'staging' }, ['staging']), h('option', { value: 'prod' }, ['prod'])]);
      var state = h('select', { class: 'fld', style: 'width:100%' }, [h('option', { value: 'on' }, ['on']), h('option', { value: 'degraded' }, ['degraded']), h('option', { value: 'off' }, ['off'])]);
      state.value = flag.state;
      var reason = h('textarea', { placeholder: 'Mandatory — written to flag_audit' });
      body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Environment']), env]));
      body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['New state']), state]));
      body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Reason (min 3 chars, mandatory)']), reason]));
      body.appendChild(err);
      var submit = h('button', { class: 'btn p' }, ['Save']);
      submit.addEventListener('click', async function () {
        if (reason.value.trim().length < 3) { err.textContent = 'A reason is required.'; return; }
        try {
          await api('/v1/admin/flags/' + encodeURIComponent(flag.key), { method: 'PUT', body: { env: env.value, state: state.value, reason: reason.value.trim() } });
          close(); toast('Flag updated.'); location.hash = location.hash; render();
        } catch (e) { err.textContent = e.message; }
      });
      body.appendChild(h('div', { style: 'display:flex;gap:8px;margin-top:14px' }, [submit, h('button', { class: 'btn', onclick: close }, ['Cancel'])]));
    });
  }

  /* ── audit & support (real route, honestly not-implemented server-side today) ─────────────── */
  async function screenSupport() {
    var content = h('div', {}, [skeletonCard()]);
    renderShell('support', content);
    try {
      var page = await api('/v1/login-history?limit=100');
      var rows = (page.items || []).map(function (r) { return h('tr', {}, [h('td', {}, [fmtDt(r.occurredAt)]), h('td', {}, [r.actor || '—'])]); });
      content.innerHTML = '';
      content.appendChild(h('div', { class: 'card' }, [h('div', { class: 'card-hd' }, [h('h2', {}, ['Login history'])]), h('table', {}, [h('tbody', {}, rows)])]));
    } catch (e) {
      content.innerHTML = '';
      content.appendChild(notBuilt(
        'Login history is not available',
        (e instanceof PlatformError ? e.message : 'The backend reports this feature is not implemented.'),
        'Needs: iam.login_history added to the Phase-1A Data Dictionary + @core/data-iam or @ra/data-org schema (backend/api/src/audit/audit.service.ts already documents this exact gap).',
      ));
    }
  }

  async function screenTenants() {
    var content = h('div', {}, [skeletonCard()]);
    renderShell('tenants', content);
    if (!hasPerm('platformops:console:read')) {
      content.innerHTML = ''; content.appendChild(notBuilt('Tenant list unavailable', 'Your role does not hold platformops:console:read.'));
      return;
    }
    try {
      var rows = await api('/v1/platform/tenants');
      var trs = (rows || []).map(function (t) {
        return h('tr', {}, [
          h('td', { class: 'mono', 'data-label': 'Code' }, [t.organizationCode || '—']),
          h('td', { 'data-label': 'Name' }, [t.organizationName || '—']),
          h('td', { 'data-label': 'Status' }, [h('span', { class: 'chip ' + (t.status === 'ACTIVE' ? 'g' : 'a') }, [t.status || '—'])]),
        ]);
      });
      var card = h('div', { class: 'card' }, [
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Tenants / organizations'])]),
        h('p', { style: 'color:var(--ink-3);margin-bottom:12px' }, ['RawProd is currently single-tenant (RAC/Raw Aroma Chem itself) — this lists org_master rows (identity + status only, no address/financial fields) as the closest existing registry, not multi-tenant SaaS billing data.']),
        trs.length
          ? h('table', {}, [h('thead', {}, [h('tr', {}, [h('th', {}, ['Code']), h('th', {}, ['Name']), h('th', {}, ['Status'])])]), h('tbody', {}, trs)])
          : h('div', { class: 'empty' }, [h('h3', {}, ['No organizations found'])]),
      ]);
      content.innerHTML = ''; content.appendChild(card);
    } catch (e) {
      content.innerHTML = ''; content.appendChild(notBuilt('Tenant list could not be loaded', e.message));
    }
  }
  async function screenProviders() {
    var content = h('div', {}, [skeletonCard()]);
    renderShell('providers', content);
    if (!hasPerm('platformops:console:read')) {
      content.innerHTML = ''; content.appendChild(notBuilt('Provider health unavailable', 'Your role does not hold platformops:console:read.'));
      return;
    }
    try {
      var rows = await api('/v1/platform/providers');
      var trs = (rows || []).map(function (p) {
        return h('tr', {}, [
          h('td', { class: 'mono', 'data-label': 'Connector' }, [p.id]),
          h('td', { 'data-label': 'Enabled' }, [h('span', { class: 'chip ' + (p.enabled ? 'g' : 'r') }, [p.enabled ? 'on' : 'off'])]),
          h('td', { 'data-label': 'Webhook set' }, [p.webhookConfigured ? 'yes' : 'no']),
          h('td', { 'data-label': 'Secret set' }, [p.secretConfigured ? 'yes' : 'no']),
          h('td', { 'data-label': 'Configured' }, [fmtDt(p.configuredAt) + (p.configuredBy ? (' · ' + p.configuredBy) : '')]),
        ]);
      });
      var card = h('div', { class: 'card' }, [
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Provider / connector health'])]),
        h('p', { style: 'color:var(--ink-3);margin-bottom:12px' }, ['Status only — never a secret. Source: bridge.connector_config (the ALEMBIC↔RawProd channel). No other self-service provider tables exist in this backend yet.']),
        trs.length
          ? h('table', {}, [h('thead', {}, [h('tr', {}, [h('th', {}, ['Connector']), h('th', {}, ['Enabled']), h('th', {}, ['Webhook set']), h('th', {}, ['Secret set']), h('th', {}, ['Configured'])])]), h('tbody', {}, trs)])
          : h('div', { class: 'empty' }, [h('h3', {}, ['No connectors configured'])]),
      ]);
      content.innerHTML = ''; content.appendChild(card);
    } catch (e) {
      content.innerHTML = ''; content.appendChild(notBuilt('Provider health could not be loaded', e.message));
    }
  }
  async function screenDeploy() {
    var content = h('div', {}, [skeletonCard()]);
    renderShell('deploy', content);
    if (!hasPerm('platformops:console:read')) {
      content.innerHTML = ''; content.appendChild(notBuilt('Build identity unavailable', 'Your role does not hold platformops:console:read.'));
      return;
    }
    try {
      var b = await api('/v1/platform/build');
      var card = h('div', { class: 'card' }, [
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Deployment / build identity'])]),
        h('div', { class: 'health-grid' }, [
          h('div', { class: 'health-tile' }, [h('div', { class: 'k' }, ['Git SHA']), h('div', { class: 'v mono' }, [b.gitSha || 'not set'])]),
          h('div', { class: 'health-tile' }, [h('div', { class: 'k' }, ['Build time']), h('div', { class: 'v' }, [b.buildTime || 'not set'])]),
          h('div', { class: 'health-tile' }, [h('div', { class: 'k' }, ['Environment']), h('div', { class: 'v' }, [b.appEnv])]),
        ]),
        (!b.gitSha || !b.buildTime) ? h('p', { style: 'color:var(--ink-3);margin-top:10px' }, ['"not set" is honest, not a bug — GIT_SHA/BUILD_TIME are populated by the deploy platform (or fall back to RENDER_GIT_COMMIT); nothing here is fabricated.']) : null,
      ]);
      content.innerHTML = ''; content.appendChild(card);
    } catch (e) {
      content.innerHTML = ''; content.appendChild(notBuilt('Build identity could not be loaded', e.message));
    }
  }

  async function render() {
    if (!session.token) {
      if (await tryConsumeAssertion()) { render(); return; }
      renderLogin();
      return;
    }
    var v = currentView();
    if (v === 'flags') return screenFlags();
    if (v === 'tenants') return screenTenants();
    if (v === 'providers') return screenProviders();
    if (v === 'deploy') return screenDeploy();
    if (v === 'support') return screenSupport();
    return screenHealth();
  }

  render();
})();
