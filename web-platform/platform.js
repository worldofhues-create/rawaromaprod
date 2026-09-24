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

  // Backend base: same-origin '' always, unless overridden with window.PLATFORM_API — see
  // web/shell.js's own header comment for why a localhost-only :3000 guess here is wrong for
  // this codebase's actual (nginx reverse-proxy, same origin) local and deployed topology.
  var API = (typeof window.PLATFORM_API === 'string') ? window.PLATFORM_API : '';

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
    if (!envelope || !envelope.data || !envelope.data.enc) { aesKey = null; handshakePromise = null; throw new PlatformError('NETWORK', 'Can\'t connect. Try again.', 0); }
    var inner = JSON.parse(await open(envelope.data.enc));
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
        toast('This account has no Platform access. Ask an admin for the platform role.', true);
        logout();
      }
    } catch (e) {
      toast('Sign-in didn\'t complete. ' + ((e instanceof PlatformError) ? e.message : 'Try again.'), true);
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
    panel: 'M4 4h16v16H4zM10 4v16',
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
  // UX-C: the one sign-in card all three RawProd consoles share (web/shell.js showLogin,
  // web-vault/vault.js renderLogin) — console name, one line, one button.
  function renderLogin() {
    root.innerHTML = '';
    var err = h('div', { class: 'err', role: 'alert' });
    var goBtn = h('a', { class: 'btn p', href: ALEMBIC_CONSOLE_URL || '#' }, ['Sign in via ALEMBIC →']);
    if (!ALEMBIC_CONSOLE_URL) {
      goBtn.setAttribute('aria-disabled', 'true');
      err.textContent = 'Sign-in isn\'t set up for this build.';
    }
    var card = h('div', { class: 'login-card' }, [
      h('h1', { class: 'mark' }, ['Platform']),
      h('p', { class: 'sub' }, ['Raw Aroma Chem platform operations.']),
      goBtn, err,
    ]);
    root.appendChild(h('div', { class: 'login-wrap' }, [card]));
  }

  var NAV = [
    { id: 'health', label: 'Health', icon: 'activity' },
    { id: 'flags', label: 'Feature flags', icon: 'sliders', need: 'platform:flag:write' },
    { id: 'tenants', label: 'Tenants', icon: 'building' },
    { id: 'providers', label: 'Providers', icon: 'activity' },
    { id: 'deploy', label: 'Build', icon: 'tag' },
    { id: 'support', label: 'Login history', icon: 'clipboard' },
    // G4: in-app tutorial. No `need` — screenTutorial() itself decides which lessons (if any)
    // the signed-in session may see (same fine-grained per-permission gate as web/tutorial.js);
    // an account with zero visible lessons still gets an honest empty state, same as every other
    // "unavailable" card this console already renders.
    { id: 'tutorial', label: 'Tutorials', icon: 'clipboard' },
  ];

  // Topbar + floating dock, rail off-canvas by default (ALEMBIC parity correction — see
  // web/ui-contract/shell.css's header comment + ALEMBIC_GUIDE_CORRECTIONS.md). The dock carries
  // the same NAV set as the rail so every route stays reachable with the rail collapsed; HOT picks
  // which ones keep a labelled segment in the phone tab-bar variant (platform.css max-width:1024).
  function renderShell(activeView, contentEl) {
    root.innerHTML = '';
    var visible = NAV.filter(function (n) { return !n.need || hasPerm(n.need); });
    var HOT = {}; visible.slice(0, 4).forEach(function (n) { HOT[n.id] = 1; });
    var navButtons = visible.map(function (n) {
      // data-tutorial-target="platform-nav-<id>" (G4): the one dedicated attribute the tutorial
      // runner's target steps use to locate this real nav button.
      return h('button', { class: 'ri' + (n.id === activeView ? ' on' : ''), 'data-tutorial-target': 'platform-nav-' + n.id, onclick: function () { location.hash = '#/' + n.id; } }, [icon(ICONS[n.icon]), h('span', { class: 'nm' }, [n.label])]);
    });
    var rail = h('nav', { class: 'rail' }, [
      h('button', { class: 'rail-toggle', 'aria-label': 'Hide navigation', onclick: function () { rail.classList.remove('open'); } }, [icon(ICONS.panel, 16)]),
      h('button', { class: 'rb', 'aria-label': 'Platform, Raw Aroma Chem', onclick: function () { location.hash = '#/health'; } }, [h('span', { class: 'm', 'aria-hidden': 'true' }, ['RAC']), h('span', { class: 't' }, ['Platform', h('small', {}, ['Raw Aroma Chem'])])]),
      h('div', { class: 'rail-deep' }, [h('div', { class: 'rs' }, ['Operations']), h('div', {}, navButtons)]),
      h('div', { class: 'rme' }, [
        h('span', { class: 'av' }, [(session.email || '?').slice(0, 2).toUpperCase()]),
        h('span', { class: 'who' }, [session.email]),
        h('button', { class: 'btn sm', style: 'margin-left:auto', onclick: logout, 'aria-label': 'Sign out', title: 'Sign out' }, [icon(ICONS.logout, 14)]),
      ]),
    ]);
    var banner = h('div', { class: 'platform-banner' }, [
      h('span', { class: 'dot' }), h('span', {}, ['Internal']),
      h('span', { class: 'who-when' }, [session.email]),
    ]);
    var label = (visible.filter(function (n) { return n.id === activeView; })[0] || {}).label || 'Platform';
    var main = h('div', { class: 'main' }, [banner, h('div', { class: 'bar' }, [h('h1', {}, [label])]), h('div', { class: 'content' }, [contentEl])]);
    var dock = h('div', { class: 'qdock', role: 'navigation', 'aria-label': 'Sections' },
      [h('button', { class: 'qb dock-toggle hot', 'aria-label': 'Show navigation', title: 'Sections', onclick: function () { rail.classList.toggle('open'); } }, [icon(ICONS.panel, 17), h('span', { class: 'nm' }, ['Sections'])]), h('span', { class: 'sep' })]
      .concat(visible.map(function (n) {
        return h('button', { class: 'qb' + (n.id === activeView ? ' on' : '') + (HOT[n.id] ? ' hot' : ''), title: n.label, 'aria-label': n.label, onclick: function () { location.hash = '#/' + n.id; } }, [icon(ICONS[n.icon], 17), h('span', { class: 'nm' }, [n.label])]);
      })));
    root.appendChild(h('div', { class: 'app' }, [rail, main, dock]));
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
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Services']), r.status ? h('span', { class: 'chip ' + (r.status === 'ok' ? 'g' : 'a') }, [r.status]) : null, r.at ? h('span', { class: 'n' }, ['Checked ' + fmtDt(r.at)]) : null]),
        h('div', { class: 'health-grid' }, tiles),
      ]);
      content.innerHTML = ''; content.appendChild(card);
      if (!hasPerm('platformops:console:read')) {
        content.appendChild(notBuilt('Diagnostics unavailable', 'Your role doesn\'t include this.'));
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
          h('div', { class: 'card-hd' }, [h('h2', {}, ['Outbox'])]),
          outboxRows.length
            ? h('table', {}, [h('thead', {}, [h('tr', {}, [h('th', {}, ['Schema']), h('th', {}, ['Backlog']), h('th', {}, ['Oldest unpublished'])])]), h('tbody', {}, outboxRows)])
            : h('div', { class: 'empty' }, [h('h3', {}, ['No outbox tables found'])]),
        ]);
        content.appendChild(diagCard);
      } catch (e) {
        content.appendChild(notBuilt('Diagnostics didn\'t load', e.message));
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
      content.innerHTML = ''; content.appendChild(notBuilt('Feature flags unavailable', 'Your role doesn\'t include this.'));
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
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Feature flags']), h('span', { class: 'n' }, ['Version ' + snap.version])]),
        rows.length ? h('table', {}, [h('thead', {}, [h('tr', {}, [h('th', {}, ['Key']), h('th', {}, ['State']), h('th', {}, ['Action'])])]), h('tbody', {}, rows)]) : h('div', { class: 'empty' }, [h('h3', {}, ['No flags registered'])]),
      ]);
      content.innerHTML = ''; content.appendChild(card);
    } catch (e) {
      content.innerHTML = ''; content.appendChild(notBuilt('Feature flags didn\'t load', e.message));
    }
  }
  function toggleFlagDialog(flag) {
    openDialog('Change flag: ' + flag.key, function (body, close) {
      var err = h('div', { class: 'err' });
      var env = h('select', { class: 'fld', style: 'width:100%' }, [h('option', { value: 'staging' }, ['staging']), h('option', { value: 'prod' }, ['prod'])]);
      var state = h('select', { class: 'fld', style: 'width:100%' }, [h('option', { value: 'on' }, ['on']), h('option', { value: 'degraded' }, ['degraded']), h('option', { value: 'off' }, ['off'])]);
      state.value = flag.state;
      var reason = h('textarea', { placeholder: 'Why this change?' });
      body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Environment']), env]));
      body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['New state']), state]));
      body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Reason']), reason]));
      body.appendChild(err);
      var submit = h('button', { class: 'btn p', 'data-tutorial-target': 'platform-flag-save' }, ['Save']);
      submit.addEventListener('click', async function () {
        if (reason.value.trim().length < 3) { err.textContent = 'A reason is required.'; return; }
        try {
          await api('/v1/admin/flags/' + encodeURIComponent(flag.key), { method: 'PUT', body: { env: env.value, state: state.value, reason: reason.value.trim() } });
          close(); toast('Flag updated'); location.hash = location.hash; render();
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
        'Login history unavailable',
        (e instanceof PlatformError ? e.message : 'Not available yet.'),
      ));
    }
  }

  async function screenTenants() {
    var content = h('div', {}, [skeletonCard()]);
    renderShell('tenants', content);
    if (!hasPerm('platformops:console:read')) {
      content.innerHTML = ''; content.appendChild(notBuilt('Tenants unavailable', 'Your role doesn\'t include this.'));
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
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Organizations'])]),
        trs.length
          ? h('table', {}, [h('thead', {}, [h('tr', {}, [h('th', {}, ['Code']), h('th', {}, ['Name']), h('th', {}, ['Status'])])]), h('tbody', {}, trs)])
          : h('div', { class: 'empty' }, [h('h3', {}, ['No organizations found'])]),
      ]);
      content.innerHTML = ''; content.appendChild(card);
    } catch (e) {
      content.innerHTML = ''; content.appendChild(notBuilt('Tenants didn\'t load', e.message));
    }
  }
  async function screenProviders() {
    var content = h('div', {}, [skeletonCard()]);
    renderShell('providers', content);
    if (!hasPerm('platformops:console:read')) {
      content.innerHTML = ''; content.appendChild(notBuilt('Providers unavailable', 'Your role doesn\'t include this.'));
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
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Connectors'])]),
        trs.length
          ? h('table', {}, [h('thead', {}, [h('tr', {}, [h('th', {}, ['Connector']), h('th', {}, ['Enabled']), h('th', {}, ['Webhook set']), h('th', {}, ['Secret set']), h('th', {}, ['Configured'])])]), h('tbody', {}, trs)])
          : h('div', { class: 'empty' }, [h('h3', {}, ['No connectors configured'])]),
      ]);
      content.innerHTML = ''; content.appendChild(card);
    } catch (e) {
      content.innerHTML = ''; content.appendChild(notBuilt('Providers didn\'t load', e.message));
    }
  }
  async function screenDeploy() {
    var content = h('div', {}, [skeletonCard()]);
    renderShell('deploy', content);
    if (!hasPerm('platformops:console:read')) {
      content.innerHTML = ''; content.appendChild(notBuilt('Build unavailable', 'Your role doesn\'t include this.'));
      return;
    }
    try {
      var b = await api('/v1/platform/build');
      var card = h('div', { class: 'card' }, [
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Build'])]),
        h('div', { class: 'health-grid' }, [
          h('div', { class: 'health-tile' }, [h('div', { class: 'k' }, ['Git SHA']), h('div', { class: 'v mono' }, [b.gitSha || 'not set'])]),
          h('div', { class: 'health-tile' }, [h('div', { class: 'k' }, ['Build time']), h('div', { class: 'v' }, [b.buildTime || 'not set'])]),
          h('div', { class: 'health-tile' }, [h('div', { class: 'k' }, ['Environment']), h('div', { class: 'v' }, [b.appEnv])]),
        ]),
      ]);
      content.innerHTML = ''; content.appendChild(card);
    } catch (e) {
      content.innerHTML = ''; content.appendChild(notBuilt('Build didn\'t load', e.message));
    }
  }

  /* ── tutorials (G4): self-service, fetched from the tutorial engine's own registry ───────── */
  var TUTORIAL_TRACK = 'platform';
  var tutorialLessons = null, tutorialProgress = null;
  function tutorialLessonPerms(lesson) {
    var perms = [];
    (lesson.steps || []).forEach(function (s) { if (s.permission) perms.push(s.permission); });
    return perms;
  }
  // Hides a lesson ENTIRELY unless every permission its action/verify steps name is held — the
  // fine-grained gate ALEMBIC's own port lacked (ticket G4); this console's own `hasPerm` is its
  // `can()`-equivalent (see this file's own header comment).
  function tutorialVisibleLessons() {
    return (tutorialLessons || []).filter(function (l) {
      return l.track === TUTORIAL_TRACK && tutorialLessonPerms(l).every(hasPerm);
    });
  }
  function tutorialProgressFor(lessonId) {
    return (tutorialProgress || []).filter(function (p) { return p.lessonId === lessonId && p.role === TUTORIAL_TRACK; })[0] || null;
  }
  function tutorialUpsertProgress(row) {
    if (!row) return;
    tutorialProgress = tutorialProgress || [];
    for (var i = 0; i < tutorialProgress.length; i++) {
      if (tutorialProgress[i].lessonId === row.lessonId && tutorialProgress[i].role === row.role) { tutorialProgress[i] = row; return; }
    }
    tutorialProgress.push(row);
  }
  function tutorialPost(lessonId, event) {
    return api('/v1/tutorial/progress/' + encodeURIComponent(lessonId), { method: 'POST', body: { role: TUTORIAL_TRACK, event: event } });
  }
  var _tutHlEl = null;
  function tutorialClearHighlight() {
    if (_tutHlEl) { _tutHlEl.style.boxShadow = ''; _tutHlEl.style.zIndex = ''; _tutHlEl = null; }
  }
  // Same real spotlight trick as web/tutorial.js's tutorialHighlight — an oversized second
  // box-shadow dims the viewport while the targeted element stays a "hole."
  function tutorialHighlight(targetAttr) {
    tutorialClearHighlight();
    if (!targetAttr) return null;
    var el = document.querySelector('[data-tutorial-target="' + targetAttr + '"]');
    if (!el) return null;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    if (!el.style.position) el.style.position = 'relative';
    el.style.zIndex = '999';
    el.style.boxShadow = '0 0 0 3px var(--accent), 0 0 0 6000px rgba(20,20,19,.55)';
    _tutHlEl = el;
    return el;
  }
  function tutorialGetPath(obj, path) {
    if (!path) return obj;
    var cur = obj, parts = path.split('.');
    for (var i = 0; i < parts.length; i++) { if (cur === null || cur === undefined) return undefined; cur = cur[parts[i]]; }
    return cur;
  }
  function tutorialPollVerify(check, onDone) {
    var stopped = false, haveBaseline = false, baseline = null, startedAt = Date.now();
    var pollMs = check.pollMs || 1500, timeoutMs = check.timeoutMs || 30000;
    function passes(json) {
      var val = tutorialGetPath(json, check.assert.path);
      switch (check.assert.op) {
        case 'exists': return Array.isArray(val) ? val.length > 0 : (val !== undefined && val !== null && val !== '');
        case 'equals': return JSON.stringify(val) === JSON.stringify(check.assert.value);
        case 'matches': try { return new RegExp(check.assert.pattern).test(val === undefined ? '' : String(val)); } catch (e) { return false; }
        case 'changed':
          if (!haveBaseline) { baseline = JSON.stringify(val); haveBaseline = true; return false; }
          return JSON.stringify(val) !== baseline;
        default: return false;
      }
    }
    function tick() {
      if (stopped) return;
      if (Date.now() - startedAt > timeoutMs) { onDone(false); return; }
      tunnel(check.path, { method: check.method || 'GET' }).then(function (res) {
        if (stopped) return;
        var pass = res.status < 400 && passes(res.json || {});
        if (pass) { onDone(true); return; }
        setTimeout(tick, pollMs);
      }).catch(function () { if (!stopped) setTimeout(tick, pollMs); });
    }
    tick();
    return function stop() { stopped = true; };
  }
  var _tutRunnerStop = null;
  function tutorialOpenRunner(lesson, progressRow) {
    if (_tutRunnerStop) { _tutRunnerStop(); _tutRunnerStop = null; }
    var idx = Math.min(progressRow.stepIndex, lesson.steps.length - 1);
    var step = lesson.steps[idx];
    var target = (step.kind === 'target' || step.kind === 'action') ? step.target : null;
    tutorialHighlight(target);
    openDialog(step.title || lesson.title, function (body, close) {
      body.appendChild(h('div', { class: 'sub', style: 'margin-bottom:8px' }, ['Step ' + (idx + 1) + ' of ' + lesson.steps.length]));
      body.appendChild(h('p', { style: 'color:var(--ink-2)' }, [step.body]));
      if (step.kind === 'action' && step.safety === 'confirm-required') {
        body.appendChild(h('p', { class: 'err' }, ['This can\'t be undone. You\'ll be asked to confirm first.']));
      }
      var verifyNote = null;
      if (step.kind === 'verify') {
        verifyNote = h('div', { class: 'sub' }, ['Waiting for the change…']);
        body.appendChild(verifyNote);
      }
      var actions = h('div', { style: 'display:flex;gap:8px;margin-top:14px' }, [
        h('button', { class: 'btn', onclick: function () {
          close(); tutorialClearHighlight();
          if (_tutRunnerStop) { _tutRunnerStop(); _tutRunnerStop = null; }
          tutorialPost(lesson.id, { type: 'dismiss' }).then(function (row) { tutorialUpsertProgress(row); }).catch(function () {});
        } }, ['Close']),
      ]);
      if (step.kind !== 'verify') {
        actions.appendChild(h('button', { class: 'btn p', onclick: function () {
          close();
          tutorialPost(lesson.id, { type: 'advance', tutorialVersion: lesson.version }).then(function (row) {
            tutorialUpsertProgress(row);
            if (row.status === 'completed') { tutorialClearHighlight(); toast('Tutorial complete'); return; }
            tutorialOpenRunner(lesson, row);
          }).catch(function (e) { toast(e.message, true); });
        } }, [idx + 1 >= lesson.steps.length ? 'Finish' : 'Next']));
      }
      body.appendChild(actions);
      if (step.kind === 'verify') {
        _tutRunnerStop = tutorialPollVerify(step.check, function (passed) {
          if (!passed) { if (verifyNote) verifyNote.textContent = 'Still waiting. Close and resume any time from Tutorials.'; return; }
          if (verifyNote) verifyNote.textContent = 'Done';
          tutorialPost(lesson.id, { type: 'advance', tutorialVersion: lesson.version }).then(function (row) {
            tutorialUpsertProgress(row);
            close(); tutorialClearHighlight();
            if (row.status === 'completed') { toast('Tutorial complete'); return; }
            tutorialOpenRunner(lesson, row);
          }).catch(function (e) { toast(e.message, true); });
        });
      }
    });
  }
  function tutorialStartOrResume(lesson) {
    tutorialPost(lesson.id, { type: 'start' }).then(function (row) { tutorialUpsertProgress(row); tutorialOpenRunner(lesson, row); }).catch(function (e) { toast(e.message, true); });
  }
  async function screenTutorial() {
    var content = h('div', {}, [skeletonCard()]);
    renderShell('tutorial', content);
    try {
      tutorialLessons = await api('/v1/tutorial/lessons');
      tutorialProgress = await api('/v1/tutorial/progress');
    } catch (e) {
      content.innerHTML = ''; content.appendChild(notBuilt('Tutorials didn\'t load', e.message));
      return;
    }
    content.innerHTML = '';
    var lessons = tutorialVisibleLessons();
    if (!lessons.length) {
      content.appendChild(notBuilt('No tutorials yet', 'None match your role.'));
    } else {
      lessons.forEach(function (l) {
        var prog = tutorialProgressFor(l.id);
        var status = prog ? prog.status : 'not_started';
        var label = status === 'completed' ? 'Replay' : (status === 'in_progress' ? 'Resume' : 'Start');
        content.appendChild(h('div', { class: 'card' }, [
          h('div', { class: 'card-hd' }, [h('h2', {}, [l.title]), h('span', { class: 'chip ' + (status === 'completed' ? 'g' : status === 'in_progress' ? 'b' : 'n') }, [status.replace(/_/g, ' ')])]),
          h('p', { class: 'card-note' }, [l.summary]),
          h('button', { class: 'btn p', onclick: function () { tutorialStartOrResume(l); } }, [label]),
        ]));
      });
    }
    content.appendChild(h('div', { class: 'card' }, [
      h('button', { class: 'btn', style: 'color:var(--red)', onclick: function () {
        openDialog('Reset progress?', function (body, close) {
          body.appendChild(h('p', { style: 'color:var(--ink-2)' }, ['Clears your tutorial progress in every workspace. This can\'t be undone.']));
          body.appendChild(h('div', { style: 'display:flex;gap:8px;margin-top:14px' }, [
            h('button', { class: 'btn', onclick: close }, ['Cancel']),
            h('button', { class: 'btn p', onclick: function () {
              api('/v1/tutorial/reset', { method: 'POST' }).then(function () { close(); toast('Progress reset'); tutorialProgress = []; screenTutorial(); }).catch(function (e) { toast(e.message, true); });
            } }, ['Reset']),
          ]));
        });
      } }, ['Reset progress']),
    ]));
  }

  async function render() {
    if (!session.token) {
      if (await tryConsumeAssertion()) { render(); return; }
      renderLogin();
      return;
    }
    var v = currentView();
    if (v === 'flags') return screenFlags();
    if (v === 'tutorial') return screenTutorial();
    if (v === 'tenants') return screenTenants();
    if (v === 'providers') return screenProviders();
    if (v === 'deploy') return screenDeploy();
    if (v === 'support') return screenSupport();
    return screenHealth();
  }

  render();
})();
