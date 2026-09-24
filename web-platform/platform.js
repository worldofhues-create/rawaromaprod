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
  function toast(msg, bad) { var t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, [h('span', { class: 'd' }), msg]); document.body.appendChild(t); if (window.RaSound) { if (bad) RaSound.play('alert'); else RaSound.cue(msg); } setTimeout(function () { t.remove(); }, 3400); }
  var dialogRoot = null;
  function closeDialog() { if (dialogRoot) { dialogRoot.remove(); dialogRoot = null; } }
  function openDialog(title, bodyFn) {
    closeDialog();
    var scrim = h('div', { class: 'xp-scrim open', onclick: closeDialog });
    var body = h('div', { class: 'xp-sheet-bd' });
    var sheet = h('div', { class: 'glass glass-deep xp-sheet open', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: 'max-width:520px' },
      [h('div', { class: 'xp-sheet-hd' }, [h('h2', { class: 't-h1' }, [title]), h('button', { class: 'xp', 'aria-label': 'Close', onclick: closeDialog }, [raw(CI.x)])]), body]);
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
      h('img', { class: 'brand-logo brand-logo--login', src: '/logo/raw-logo.png', srcset: '/logo/raw-logo.png 1x, /logo/raw-logo@2x.png 2x, /logo/raw-logo@3x.png 3x', width: '88', height: '40', alt: 'RAW Aromachem' }),
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

  /* ---- reference shell kit — vanilla port of rac-console.jsx (BrandMark, rail toggle, QuickDock,
   * ExpandSheet markup, usePageEnter), the same markup web/shell.js renders; this console shares
   * no code with it, so the kit is repeated here. Styling is rac-console.css, vendored verbatim. */
  var CI = {
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M13.5 6.5 8 12l5.5 5.5"/><path d="M19 5v14"/></svg>',
    cmd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 6.6a2.6 2.6 0 1 0-2.6 2.6H9V6.6zM15 6.6a2.6 2.6 0 1 1 2.6 2.6H15V6.6zM9 17.4a2.6 2.6 0 1 1-2.6-2.6H9v2.6zM15 17.4a2.6 2.6 0 1 0 2.6-2.6H15v2.6z"/><rect x="9" y="9.2" width="6" height="5.6"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.4l1.7 6 5.9.7-4.4 4 1.3 5.8L12 15.9 7.5 18.9l1.3-5.8-4.4-4 5.9-.7z"/></svg>',
  };
  function raw(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  // BrandMark — the RAW logo (UX-D, release/ui/BRAND_ASSETS.md): reversed art on the ink rail.
  function brandMark(sub, onInk) {
    return raw('<span class="brandmark' + (onInk ? ' on-ink' : '') + '">' + (onInk ? '<img class="brand-logo brand-logo--rail" src="/logo/raw-logo-ondark.png" srcset="/logo/raw-logo-ondark.png 1x, /logo/raw-logo-ondark@2x.png 2x, /logo/raw-logo-ondark@3x.png 3x" width="66" height="30" alt="">' : '<img class="brand-logo brand-logo--rail" src="/logo/raw-logo.png" srcset="/logo/raw-logo.png 1x, /logo/raw-logo@2x.png 2x, /logo/raw-logo@3x.png 3x" width="66" height="30" alt="">') + '<span class="bt">Alembic<small>' + sub + '</small></span></span>');
  }
  // Rail state, as the reference's useRailToggle: collapsed by default (body.rail-off, the dock is
  // the navigation); on a phone the rail opens as a drawer (body.rail-open).
  var railOpen = false, prevView = null;
  function applyRail() {
    var phone = window.innerWidth <= 1023;
    document.body.classList.toggle('rail-off', !!session.token && !phone && !railOpen);
    document.body.classList.toggle('rail-open', !!session.token && phone && railOpen);
    var r = document.getElementById('pv-rail');
    if (r) { if (railOpen) { r.removeAttribute('inert'); r.removeAttribute('aria-hidden'); } else { r.setAttribute('inert', ''); r.setAttribute('aria-hidden', 'true'); } }
    var t = document.getElementById('pv-dock-toggle');
    if (t) { t.setAttribute('aria-pressed', String(railOpen)); t.setAttribute('aria-label', railOpen ? 'Hide navigation' : 'Show navigation'); }
  }
  function setRail(v) { railOpen = v; applyRail(); }
  function go(id) { if (window.innerWidth <= 1023) railOpen = false; if (location.hash === '#/' + id) { render(); return; } location.hash = '#/' + id; }
  function visibleNav() { return NAV.filter(function (n) { return !n.need || hasPerm(n.need); }); }
  window.addEventListener('resize', applyRail);
  /* ---- Ask Aria (UX-E): ALEMBIC's own panel (aria-panel.js, AlembicAria.mount), fetched the first
   * time it opens and opened from the top bar and the dock's "Ask Aria · ⌘K", as in ALEMBIC.
   * Answers: ALEMBIC's /api/v1/copilot/ask needs an ALEMBIC staff session, this console holds a
   * RawProd one, its CSP is connect-src 'self' and no RawProd vhost proxies to ALEMBIC — so the
   * panel opens in an honest "Aria answers in ALEMBIC" state and invents nothing (same choice and
   * reasoning as web/shell.js's Ask Aria block). */
  var ARIA_HERE = 'I answer from ALEMBIC\'s records, and this console has no connection to them yet. Ask me in ALEMBIC Admin.';
  var ariaApi = null, ariaLoading = null, ariaCtx = 'Platform';
  function loadAria() {
    if (typeof AlembicAria !== 'undefined') return Promise.resolve();
    if (ariaLoading) return ariaLoading;
    ariaLoading = new Promise(function (ok, no) {
      var sc = document.createElement('script'); sc.src = '/aria-panel.js';
      sc.onload = ok; sc.onerror = function () { ariaLoading = null; no(new Error('aria')); };
      document.head.appendChild(sc);
    });
    return ariaLoading;
  }
  function toggleAria() {
    loadAria().then(function () {
      if (!ariaApi) {
        ariaApi = AlembicAria.mount({ context: ariaCtx, prompts: ['Where can I ask Aria?'], parent: document.body,
          ask: function () { return Promise.resolve({ ok: true, via: 'refusal', text: ARIA_HERE, cited: [] }); } });
        var fix = function () { var p = ariaApi.element.querySelector('.aria-empty > p'); if (p && p.textContent !== ARIA_HERE) p.textContent = ARIA_HERE; };
        new MutationObserver(fix).observe(ariaApi.element, { childList: true, subtree: true }); fix();
      }
      ariaApi.setContext(ariaCtx); ariaApi.toggle();
    }).catch(function () { toast('Aria didn\'t load. Try again.', true); });
  }
  // QuickDock keys: ⌘K Ask Aria (as ALEMBIC Admin/Agent), ⌘\ rail, ⌘1–9 destinations, ⌘/ the
  // go-to palette; Escape closes.
  document.addEventListener('keydown', function (e) {
    if (!session.token) return;
    if (e.key === 'Escape' && ariaApi && ariaApi.isOpen()) { ariaApi.close(); return; }
    if (e.key === 'Escape' && railOpen) { setRail(false); return; }
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === 'k' || e.key === 'K') { e.preventDefault(); toggleAria(); return; }
    if (e.key === '/') { e.preventDefault(); openPalette(); return; }
    if (e.key === '\\') { e.preventDefault(); setRail(!railOpen); return; }
    var i = parseInt(e.key, 10), v = visibleNav();
    if (i >= 1 && i <= 9 && v[i - 1]) { e.preventDefault(); go(v[i - 1].id); }
  });
  function closePalette() { var w = document.getElementById('pv-cmdk'); if (w) w.remove(); }
  // Go-to palette (⌘/): every destination this role holds, filterable, Enter to go.
  function openPalette() {
    if (document.getElementById('pv-cmdk')) { closePalette(); return; }
    var v = visibleNav(), idx = 0, rows = [];
    var q = h('input', { type: 'text', placeholder: 'Go to…', 'aria-label': 'Go to', autocomplete: 'off' });
    var list = h('ul', { role: 'listbox' });
    var wrap = h('div', { id: 'pv-cmdk' }, [h('div', { class: 'xp-scrim open', onclick: closePalette }),
      h('div', { class: 'glass glass-deep cmdk', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Go to' }, [q, list])]);
    function paint() {
      var t = q.value.trim().toLowerCase();
      rows = v.filter(function (n) { return !t || n.label.toLowerCase().indexOf(t) >= 0; });
      if (idx >= rows.length) idx = 0;
      list.innerHTML = '';
      rows.forEach(function (n, i) {
        list.appendChild(h('li', {}, [h('button', { type: 'button', class: i === idx ? 'on' : '', onclick: function () { closePalette(); go(n.id); } },
          [icon(ICONS[n.icon], 15), n.label, h('span', { class: 'sc' }, ['⌘' + (v.indexOf(n) + 1)])])]));
      });
    }
    q.addEventListener('input', function () { idx = 0; paint(); });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(rows.length - 1, idx + 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); paint(); }
      else if (e.key === 'Enter' && rows[idx]) { e.preventDefault(); closePalette(); go(rows[idx].id); }
      else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    });
    document.body.appendChild(wrap); paint(); q.focus();
  }
  // Dock retract (reference QuickDock): with the desktop rail open the dock steps aside at rest
  // and returns near the bottom edge; with the rail folded rac-console.css pins it.
  var awayT = null;
  document.addEventListener('mousemove', function (e) {
    if (!session.token) return;
    if (e.clientY > window.innerHeight - 64) { clearTimeout(awayT); document.body.classList.remove('dock-away'); }
    else if (railOpen && window.innerWidth > 1023 && !document.body.classList.contains('dock-away')) {
      clearTimeout(awayT); awayT = setTimeout(function () { if (railOpen) document.body.classList.add('dock-away'); }, 2400);
    }
  }, { passive: true });

  // The reference Admin/Agent shell, 1:1: rail · top bar (platform brand, page title) · region ·
  // floating glass dock (brand tile, rail toggle, destinations with ⌘1–9, command palette). Below
  // 1024 the dock is the reference tab bar, keeping the first destinations (HOT) plus Sections.
  function renderShell(activeView, contentEl) {
    root.innerHTML = '';
    var visible = visibleNav();
    var HOT = {}; visible.slice(0, 3).forEach(function (n) { HOT[n.id] = 1; });
    var navButtons = visible.map(function (n) {
      return h('button', { type: 'button', class: 'ri' + (n.id === activeView ? ' on' : ''), 'aria-current': n.id === activeView ? 'page' : null,
        'data-tutorial-target': 'platform-nav-' + n.id, onclick: function () { go(n.id); } }, [icon(ICONS[n.icon]), h('span', { class: 'nm' }, [n.label])]);
    });
    var rail = h('nav', { class: 'rail', id: 'pv-rail', 'aria-label': 'Platform navigation' }, [
      h('button', { type: 'button', class: 'rail-min', 'aria-label': 'Minimise navigation', onclick: function () { setRail(false); } }, [raw(CI.collapse)]),
      h('button', { type: 'button', class: 'rb', style: 'padding-right:44px;background:none;border:0;cursor:pointer;text-align:left;width:100%', 'aria-label': 'Health', onclick: function () { go(visible[0].id); } }, [brandMark('Platform', true)]),
      h('div', { class: 'rail-deep' }, [h('div', {}, [h('div', { class: 'rs' }, ['OPERATIONS'])].concat(navButtons))]),
      h('div', { class: 'rme' }, [
        h('span', { class: 'av' }, [(session.email || '?').slice(0, 2).toUpperCase()]),
        h('span', { class: 'who' }, [session.email]),
        
        h('button', { type: 'button', class: 'rail-min', style: 'position:static;margin-left:auto', onclick: function () { railOpen = false; if (ariaApi) { ariaApi.destroy(); ariaApi = null; } document.body.classList.remove('rail-off', 'rail-open', 'dock-away'); logout(); }, 'aria-label': 'Sign out', title: 'Sign out' }, [icon(ICONS.logout, 13)]),
      ]),
    ]);
    /* UX-F: the sound on/off toggle sits beside Sign out, in the reference shell's rail-min style. */
    var rme = rail.querySelector('.rme'); if (window.RaSound && rme) { var so = rme.lastChild; if (RaSound.mountToggle(rme, so, 'rail-min', 'position:static;margin-left:auto')) so.style.marginLeft = '0'; }
    var label = (visible.filter(function (n) { return n.id === activeView; })[0] || {}).label || 'Platform';
    ariaCtx = 'Platform · ' + label; if (ariaApi) ariaApi.setContext(ariaCtx);
    var bar = h('div', { class: 'bar' }, [
      h('span', { class: 'bar-brand' }, ['Alembic', h('i', {}, ['·']), 'RawAromaChem']),
      h('h1', {}, [label]),
      h('span', { class: 'chip n' }, ['Internal']),
      h('span', { style: 'flex:1' }),
      h('button', { type: 'button', class: 'gbtn acc', 'aria-label': 'Ask Aria', onclick: toggleAria }, [raw(CI.spark), ' Ask Aria']),
    ]);
    var view = h('section', { class: 'pageview' }, [contentEl]);
    var main = h('div', { class: 'main' }, [ bar, h('div', { class: 'content' }, [view])]);
    var dock = h('div', { class: 'glass glass-deep qdock', role: 'toolbar', 'aria-label': 'Quick access' },
      [h('button', { type: 'button', class: 'brandmark qd-brand', 'aria-label': 'Health', onclick: function () { go(visible[0].id); } }, [raw('<img class="brand-logo brand-logo--dock" src="/logo/raw-logo.png" srcset="/logo/raw-logo.png 1x, /logo/raw-logo@2x.png 2x, /logo/raw-logo@3x.png 3x" width="48" height="22" alt="">')]),
       h('button', { type: 'button', id: 'pv-dock-toggle', class: 'qb dk-navtoggle hot', 'aria-label': 'Show navigation', 'aria-pressed': 'false', onclick: function () { setRail(!railOpen); } },
         [raw(CI.menu), h('span', { class: 'kb' }, ['Sections', h('span', { class: 'kc' }, [' · ⌘\\'])])]),
       h('span', { class: 'sep' })]
      .concat(visible.map(function (n, i) {
        var on = n.id === activeView;
        return h('button', { type: 'button', class: 'qb' + (on ? ' on' : '') + (HOT[n.id] ? ' hot' : ''), 'aria-label': n.label, 'aria-pressed': String(on), onclick: function () { go(n.id); } },
          [icon(ICONS[n.icon], 17), h('span', { class: 'kb' }, [n.label, i < 9 ? h('span', { class: 'kc' }, [' · ⌘' + (i + 1)]) : null])]);
      }))
      .concat([h('span', { class: 'sep' }), h('button', { type: 'button', class: 'qb hot', 'aria-label': 'Ask Aria', onclick: toggleAria }, [raw(CI.cmd), h('span', { class: 'kb' }, ['Ask Aria', h('span', { class: 'kc' }, [' · ⌘K'])])])]));
    var handle = h('button', { type: 'button', class: 'dock-handle', 'aria-label': 'Show quick access dock', onclick: function () { document.body.classList.remove('dock-away'); } }, [h('i')]);
    root.appendChild(h('div', { class: 'app' }, [rail, h('div', { class: 'rail-scrim', onclick: function () { setRail(false); } }), main, handle, dock]));
    applyRail();
    // usePageEnter — the resting state is correct; the offset is an attribute removed on a timer.
    var order = visible.map(function (n) { return n.id; }), a = order.indexOf(prevView), b = order.indexOf(activeView);
    if (a >= 0 && b >= 0 && a !== b) {
      view.setAttribute('data-enter', b > a ? 'r' : 'l');
      setTimeout(function () { view.setAttribute('data-settling', ''); view.removeAttribute('data-enter'); }, 20);
      setTimeout(function () { view.removeAttribute('data-settling'); }, 460);
    }
    prevView = activeView;
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
