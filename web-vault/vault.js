/* Formula Vault console — a separate, NON-PWA client for the existing formula backend
 * routes only (backend/cluster-formula). No manifest, no service worker (any stray SW for
 * this origin/scope is unregistered on load), no localStorage/IndexedDB/sessionStorage for
 * formula (or session) data — the access token lives in a JS closure variable only and is
 * lost on reload by design (§109.4 "short idle session"). No analytics. No formula payload
 * ever appears in a URL, query string, or console.log.
 *
 * Transport: the SAME encrypted /crypto/handshake + /rpc tunnel every RawProd client uses
 * (backend/api/src/crypto) — an ECDH-derived AES-256-GCM session wraps the whole request
 * (method/path/body/bearer token) into one opaque blob, so the browser network tab never
 * shows a readable path, token, or payload for any Vault call either.
 *
 * Visual language: ALEMBIC tokens (alembic-tokens.css) + the component recipes in
 * release/ui/PORTING_GUIDE.md (vault.css). The only permitted departure is the secure-zone
 * banner / reveal-panel (§7 of the addendum names this the one allowed difference: SECURITY
 * CONTEXT, not a separate brand).
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------------------------
   * 0. kill any stray service worker for this origin (defence in depth — none is registered
   *    by this app, but a prior local-dev experiment or a misconfigured deploy might have
   *    left one behind; §109.4 requires this console never run offline/cached).
   * --------------------------------------------------------------------------------------- */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      regs.forEach(function (r) { r.unregister(); });
    }).catch(function () {});
  }

  /* ---------------------------------------------------------------------------------------
   * 1. backend base + encrypted tunnel (own implementation — this console shares no code
   *    with web/app.js, per the lane boundary; the WIRE PROTOCOL is the same because it's
   *    the backend's existing contract, not a copy of that file).
   * --------------------------------------------------------------------------------------- */
  var API = (typeof window.VAULT_API === 'string') ? window.VAULT_API
    : (/(localhost|127\.0\.0\.1)/.test(location.hostname) ? location.origin.replace(/:\d+$/, ':3000') : '');

  var aesKey = null, keyId = null, handshakePromise = null;
  function te(s) { return new TextEncoder().encode(s); }
  function b64(bytes) {
    var s = '', CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(s);
  }
  function ub64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function handshake() {
    if (aesKey) return Promise.resolve();
    if (handshakePromise) return handshakePromise;
    handshakePromise = (async function () {
      var kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      var pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      var res = await fetch(API + '/crypto/handshake', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientPub: b64(pub) }),
      });
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
  async function seal(plaintext) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, aesKey, te(plaintext)));
    var out = new Uint8Array(12 + ct.length);
    out.set(iv, 0); out.set(ct, 12);
    return b64(out);
  }
  async function open(blob) {
    var raw = ub64(blob);
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, aesKey, raw.slice(12));
    return new TextDecoder().decode(pt);
  }

  /** POST any REST call through the single opaque /rpc envelope. Never call fetch() directly
   * for a formula/vault route elsewhere in this file — this is the one chokepoint, so "no
   * formula payload in the network tab" is true by construction, not by convention. */
  async function tunnel(path, opts) {
    opts = opts || {};
    await handshake();
    var payload = { method: (opts.method || 'GET').toUpperCase(), path: path };
    if (opts.body !== undefined) payload.body = opts.body;
    if (session.token) payload.token = session.token;
    var res = await fetch(API + '/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ra-key': keyId },
      body: JSON.stringify({ enc: await seal(JSON.stringify(payload)) }),
    });
    var envelope = await res.json();
    if (!envelope || !envelope.data || !envelope.data.enc) {
      // Transient failure (cold start / dropped connection) — reset and let the caller retry.
      aesKey = null; handshakePromise = null;
      throw new VaultError('NETWORK', 'Could not reach the secure channel. Try again.', 0);
    }
    var inner = JSON.parse(await open(envelope.data.enc));
    var body = inner.body ? JSON.parse(inner.body) : null;
    return { status: inner.status, json: body };
  }

  function VaultError(code, message, status) {
    this.code = code; this.message = message; this.status = status;
  }
  VaultError.prototype = Object.create(Error.prototype);

  /** Call the tunnel and throw a VaultError on any >=400, carrying the server's error code
   * (AUTH_STEP_UP_REQUIRED, AUTH_FORBIDDEN, VALIDATION_FAILED, …) so callers can react —
   * e.g. the fresh-auth prompt fires specifically on AUTH_STEP_UP_REQUIRED, never on a
   * generic catch-all. */
  async function api(path, opts) {
    var r = await tunnel(path, opts);
    if (r.status >= 400) {
      var err = (r.json && r.json.error) || {};
      throw new VaultError(err.code || 'UNKNOWN', err.message || ('Request failed (' + r.status + ')'), r.status);
    }
    return r.json ? r.json.data : null;
  }

  /* ---------------------------------------------------------------------------------------
   * 2. session (in-memory ONLY — never persisted; a reload always returns to the login
   *    screen, which is the correct behaviour for a short-idle-session secure console).
   * --------------------------------------------------------------------------------------- */
  var session = { token: null, iat: 0, email: null, userId: null, roles: [], permissions: [] };
  var FRESH_WINDOW_S = 300; // must match backend/backend-kernel FreshAuth default

  function hasPerm(p) { return session.permissions.indexOf(p) >= 0; }
  function isFresh() { return session.token && (Date.now() / 1000 - session.iat) < (FRESH_WINDOW_S - 15); }

  async function login(email, password) {
    var data = await api('/auth/login', { method: 'POST', body: { identifier: email, password: password } });
    session.token = data.accessToken;
    session.iat = Math.floor(Date.now() / 1000); // token was just minted — this IS its iat
    session.email = (data.user && data.user.email) || email;
    var me = await api('/me');
    session.userId = me.userId;
    session.roles = me.roles || [];
    session.permissions = me.permissions || [];
  }

  function logout() {
    session.token = null; session.iat = 0; session.email = null; session.userId = null; session.roles = []; session.permissions = [];
    location.hash = '';
    render();
  }

  /** Run `fn` (an async function making one or more `api()` calls). If it fails with
   * AUTH_STEP_UP_REQUIRED — or the client already knows the token is stale — prompt for the
   * password once, re-login (which mints a fresh token/iat), then retry `fn` exactly once.
   * This is §109.5's whole flow: "fresh authentication ... may reuse a freshly issued OTP/
   * password at launch" — re-running the SAME login the caller already has, not a new factor. */
  async function withFreshAuth(fn) {
    if (isFresh()) {
      try { return await fn(); }
      catch (e) {
        if (!(e instanceof VaultError) || e.code !== 'AUTH_STEP_UP_REQUIRED') throw e;
      }
    }
    var password = await promptReauth();
    if (password == null) throw new VaultError('CANCELLED', 'Re-authentication cancelled.', 0);
    await login(session.email, password);
    return fn();
  }

  /* ---------------------------------------------------------------------------------------
   * 3. tiny DOM helpers
   * --------------------------------------------------------------------------------------- */
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function icon(path, size) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', size || 14); svg.setAttribute('height', size || 14);
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('class', 'ic');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', path);
    svg.appendChild(p);
    return svg;
  }
  var ICONS = {
    lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
    layers: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    clipboard: 'M9 4h6v3H9zM8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2',
    activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    menu: 'M3 6h18M3 12h18M3 18h18',
    alert: 'M12 9v4M12 17h.01M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z',
    plus: 'M12 5v14M5 12h14',
  };

  function toast(msg, bad) {
    var t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, [h('span', { class: 'd' }), msg]);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3400);
  }

  var dialogRoot = null;
  function closeDialog() {
    if (dialogRoot) { dialogRoot.remove(); dialogRoot = null; }
  }
  /** A true modal (.xp-scrim/.xp-sheet), Escape closes it, per PORTING_GUIDE's ExpandSheet
   * recipe. `bodyFn(container, close)` builds the body and gets a close() callback. */
  function openDialog(title, bodyFn) {
    closeDialog();
    var scrim = h('div', { class: 'xp-scrim open', onclick: function () { closeDialog(); } });
    var body = h('div', { class: 'xp-sheet-bd' });
    var sheet = h('div', { class: 'xp-sheet open', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      [h('div', { class: 'xp-sheet-hd' }, [h('h2', {}, [title]), h('button', { class: 'xp', 'aria-label': 'Close', onclick: function () { closeDialog(); } }, ['×'])]), body]);
    sheet.addEventListener('click', function (e) { e.stopPropagation(); });
    dialogRoot = h('div', {}, [scrim, sheet]);
    document.body.appendChild(dialogRoot);
    bodyFn(body, closeDialog);
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { closeDialog(); document.removeEventListener('keydown', onKey); }
    });
  }

  function promptReauth() {
    return new Promise(function (resolve) {
      openDialog('Re-authenticate to continue', function (body, close) {
        var err = h('div', { class: 'err' });
        var pw = h('input', { class: 'fld', type: 'password', autocomplete: 'current-password', placeholder: 'Password' });
        body.appendChild(h('p', { style: 'margin-bottom:12px;color:var(--ink-2)' },
          ['This action requires a session issued within the last ' + Math.round(FRESH_WINDOW_S / 60) + ' minutes. Re-enter your password for ' + session.email + '.']));
        body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Password']), pw]));
        body.appendChild(err);
        var actions = h('div', { style: 'display:flex;gap:8px;margin-top:14px' }, [
          h('button', { class: 'btn p', onclick: function () { resolve(pw.value); close(); } }, ['Confirm']),
          h('button', { class: 'btn', onclick: function () { resolve(null); close(); } }, ['Cancel']),
        ]);
        body.appendChild(actions);
        pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') { resolve(pw.value); close(); } });
        setTimeout(function () { pw.focus(); }, 0);
      });
    });
  }

  function promptReason(label) {
    return new Promise(function (resolve) {
      openDialog(label || 'Access reason required', function (body, close) {
        var err = h('div', { class: 'err' });
        var reason = h('textarea', { placeholder: 'e.g. QA investigation — batch mismatch report #4471' });
        body.appendChild(h('p', { style: 'margin-bottom:12px;color:var(--ink-2)' },
          ['This decrypt is recorded on the access-audit trail with your name, this reason, and the time.']));
        body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Reason (min 3 characters)']), reason]));
        body.appendChild(err);
        var submit = h('button', { class: 'btn r' }, ['Reveal plaintext']);
        submit.addEventListener('click', function () {
          if (reason.value.trim().length < 3) { err.textContent = 'A reason is required.'; return; }
          resolve(reason.value.trim()); close();
        });
        body.appendChild(h('div', { style: 'display:flex;gap:8px;margin-top:14px' }, [
          submit,
          h('button', { class: 'btn', onclick: function () { resolve(null); close(); } }, ['Cancel']),
        ]));
        setTimeout(function () { reason.focus(); }, 0);
      });
    });
  }

  // §109.8 lifecycle: DRAFT → VERSIONED → REVIEW → APPROVED → LOCKED → SUPERSEDED, plus the
  // pre-existing terminal REJECTED/ARCHIVED.
  function statusChip(status) {
    var tone = { DRAFT: 'n', VERSIONED: 'n', REVIEW: 'a', APPROVED: 'g', LOCKED: 'g', SUPERSEDED: 'a', REJECTED: 'r', ARCHIVED: 'a' }[status] || 'n';
    return h('span', { class: 'chip ' + tone }, [status || 'UNKNOWN']);
  }
  function fmtDt(v) { if (!v) return '—'; var d = new Date(v); return isNaN(d) ? String(v) : d.toLocaleString(); }

  /* ---------------------------------------------------------------------------------------
   * 4. router — ids only in the hash, never formula content.
   * --------------------------------------------------------------------------------------- */
  window.addEventListener('hashchange', render);

  function currentRoute() {
    var raw = location.hash.replace(/^#\/?/, '');
    var parts = raw.split('/').filter(Boolean);
    return { view: parts[0] || 'formulas', id: parts[1] || null };
  }

  /* ---------------------------------------------------------------------------------------
   * 5. shell + screens
   * --------------------------------------------------------------------------------------- */
  var root = document.getElementById('root');

  function renderLogin() {
    root.innerHTML = '';
    var err = h('div', { class: 'err' });
    var email = h('input', { class: 'fld', type: 'email', autocomplete: 'username', placeholder: 'you@rawaroma.local', style: 'width:100%' });
    var pw = h('input', { class: 'fld', type: 'password', autocomplete: 'current-password', placeholder: 'Password', style: 'width:100%' });
    var btn = h('button', { class: 'btn p', style: 'width:100%;justify-content:center' }, ['Sign in']);
    async function submit() {
      btn.disabled = true; btn.textContent = 'Signing in…'; err.textContent = '';
      try {
        await login(email.value.trim(), pw.value);
        if (!hasPerm('formula:actual:read') && !session.permissions.some(function (p) { return p.indexOf('formula:') === 0; }) && !hasPerm('platform:flag:write')) {
          err.textContent = 'Signed in, but this account holds no Vault permission. Contact an admin for a formulator/vault_approver role.';
          btn.disabled = false; btn.textContent = 'Sign in';
          return;
        }
        location.hash = '#/formulas';
        render();
      } catch (e) {
        err.textContent = (e instanceof VaultError) ? e.message : 'Could not sign in.';
        btn.disabled = false; btn.textContent = 'Sign in';
      }
    }
    btn.addEventListener('click', submit);
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    var card = h('div', { class: 'login-card' }, [
      h('div', { class: 'mark' }, ['Formula Vault']),
      h('div', { class: 'sub' }, ['Raw Aroma Chem — secure formula access. Not part of the operator PWA; this session ends on reload.']),
      h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Email']), email]),
      h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Password']), pw]),
      btn, err,
    ]);
    root.appendChild(h('div', { class: 'login-wrap' }, [card]));
  }

  var NAV = [
    { id: 'formulas', label: 'Formulas', icon: 'lock', need: null },
    { id: 'audit-access', label: 'Access audit', icon: 'clipboard', need: 'formula:actual:read' },
    { id: 'audit-mfg', label: 'Manufacturing audit', icon: 'activity', need: 'formula:actual:read' },
  ];

  function renderShell(activeView, contentEl) {
    root.innerHTML = '';
    var navButtons = NAV.filter(function (n) { return !n.need || hasPerm(n.need); }).map(function (n) {
      return h('button', { class: 'ri' + (n.id === activeView ? ' on' : ''), onclick: function () { location.hash = '#/' + n.id; } },
        [icon(ICONS[n.icon]), h('span', { class: 'nm' }, [n.label])]);
    });
    var rail = h('nav', { class: 'rail', id: 'vault-rail' }, [
      h('button', { class: 'rb' }, [h('div', {}, [h('div', { class: 'mark' }, ['Formula Vault']), h('div', { class: 'sub' }, ['SECURE ZONE'])])]),
      h('div', { class: 'rail-deep' }, [h('div', { class: 'rs' }, ['VAULT']), h('div', {}, navButtons)]),
      h('div', { class: 'rme' }, [
        h('span', { class: 'av' }, [(session.email || '?').slice(0, 2).toUpperCase()]),
        h('span', { class: 'who' }, [session.email]),
        h('button', { class: 'btn sm', style: 'margin-left:auto', onclick: logout, 'aria-label': 'Sign out' }, [icon(ICONS.logout, 14)]),
      ]),
    ]);
    var banner = h('div', { class: 'secure-banner' }, [
      h('span', { class: 'dot' }),
      h('span', {}, ['FORMULA VAULT']),
      h('span', { class: 'vault-mark' }, ['SECURE ZONE']),
      h('span', {}, ['— formula plaintext is logged on every reveal. Screenshots/exports are the account holder’s responsibility — this banner is a deterrent, not a technical control.']),
      h('span', { class: 'who-when' }, [session.email + ' · ' + new Date().toLocaleString()]),
    ]);
    var toggle = h('button', { class: 'rail-toggle', 'aria-label': 'Toggle navigation', onclick: function () { rail.classList.toggle('open'); } }, [icon(ICONS.menu, 18)]);
    var main = h('div', { class: 'main' }, [banner, h('div', { class: 'bar' }, [toggle, h('h1', {}, [NAV.filter(function (n) { return n.id === activeView; })[0] ? NAV.filter(function (n) { return n.id === activeView; })[0].label : 'Formula Vault'])]), h('div', { class: 'content' }, [contentEl])]);
    root.appendChild(h('div', { class: 'app' }, [rail, main]));
  }

  function skeletonCard() {
    return h('div', { class: 'card' }, [h('div', { class: 'skl' }), h('div', { class: 'skl', style: 'margin-top:8px;width:80px' })]);
  }
  function notBuilt(title, why) {
    return h('div', { class: 'card notbuilt' }, [h('h2', {}, [title]), h('p', {}, [why])]);
  }

  /* ── formulas list ──────────────────────────────────────────────────────────────────── */
  async function screenFormulas() {
    var content = h('div', {}, [skeletonCard()]);
    renderShell('formulas', content);
    try {
      var page = await api('/v1/formulas?limit=100');
      var canCreate = hasPerm('formula:formula_master:write');
      var rows = (page.items || []).map(function (f) {
        var tr = h('tr', { onclick: function () { location.hash = '#/formula/' + f.formulaId; } }, [
          h('td', { class: 'mono', 'data-label': 'Code' }, [f.formulaCode]),
          h('td', { 'data-label': 'Name' }, [f.formulaName]),
          h('td', { 'data-label': 'Status' }, [statusChip(f.status)]),
        ]);
        return tr;
      });
      var table = rows.length
        ? h('table', {}, [h('thead', {}, [h('tr', {}, [h('th', {}, ['Code']), h('th', {}, ['Name']), h('th', {}, ['Status'])])]), h('tbody', {}, rows)])
        : h('div', { class: 'empty' }, [h('h3', {}, ['No formulas yet']), h('p', {}, [canCreate ? 'Create the first one below.' : 'Ask a formulator to create one.'])]);
      var card = h('div', { class: 'card' }, [
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Formulas']), h('span', { class: 'n' }, [(page.items || []).length + ' shown']), h('span', { class: 'spacer' }),
          canCreate ? h('button', { class: 'btn p', onclick: newFormulaDialog }, [icon(ICONS.plus, 14), 'New formula']) : null]),
        table,
      ]);
      content.innerHTML = ''; content.appendChild(card);
    } catch (e) {
      content.innerHTML = '';
      content.appendChild(notBuilt('Formulas could not be loaded', e.message));
    }
  }

  function newFormulaDialog() {
    openDialog('New formula', function (body, close) {
      var err = h('div', { class: 'err' });
      var code = h('input', { class: 'fld', style: 'width:100%' });
      var name = h('input', { class: 'fld', style: 'width:100%' });
      body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Formula code']), code]));
      body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Formula name']), name]));
      body.appendChild(err);
      var submit = h('button', { class: 'btn p' }, ['Create']);
      submit.addEventListener('click', async function () {
        if (!code.value.trim() || !name.value.trim()) { err.textContent = 'Both fields are required.'; return; }
        try {
          var f = await api('/v1/formulas', { method: 'POST', body: { formulaCode: code.value.trim(), formulaName: name.value.trim() } });
          close(); toast('Formula created.'); location.hash = '#/formula/' + f.formulaId; render();
        } catch (e) { err.textContent = e.message; }
      });
      body.appendChild(h('div', { style: 'display:flex;gap:8px;margin-top:14px' }, [submit, h('button', { class: 'btn', onclick: close }, ['Cancel'])]));
    });
  }

  /* ── formula detail: meta + version history + access grants ───────────────────────────── */
  async function screenFormula(formulaId) {
    var content = h('div', {}, [skeletonCard()]);
    renderShell('formulas', content);
    try {
      var formula = await api('/v1/formulas/' + encodeURIComponent(formulaId));
      var versionsPage = await api('/v1/formula-versions?limit=200');
      var versions = (versionsPage.items || []).filter(function (v) { return v.formulaId === formulaId; })
        .sort(function (a, b) { return (b.versionNumber || 0) - (a.versionNumber || 0); });
      var maxVersion = versions.reduce(function (m, v) { return Math.max(m, v.versionNumber || 0); }, 0);
      var canDraft = hasPerm('formula:formula_version:write');

      var rows = versions.map(function (v) {
        return h('tr', { onclick: function () { location.hash = '#/version/' + v.formulaVersionId; } }, [
          h('td', { class: 'mono', 'data-label': 'Version' }, ['v' + v.versionNumber]),
          h('td', { 'data-label': 'Status' }, [statusChip(v.status)]),
          h('td', { 'data-label': 'Approved' }, [fmtDt(v.approvedDt)]),
        ]);
      });
      var versionsCard = h('div', { class: 'card' }, [
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Version history']), h('span', { class: 'spacer' }),
          canDraft ? h('button', { class: 'btn p sm', onclick: function () { createVersion(formulaId, maxVersion + 1); } }, ['+ New draft version (v' + (maxVersion + 1) + ')']) : null]),
        rows.length ? h('table', {}, [h('thead', {}, [h('tr', {}, [h('th', {}, ['Version']), h('th', {}, ['Status']), h('th', {}, ['Approved'])])]), h('tbody', {}, rows)])
          : h('div', { class: 'empty' }, [h('h3', {}, ['No versions yet'])]),
      ]);

      var metaCard = h('div', { class: 'card' }, [
        h('div', { class: 'card-hd' }, [h('h2', {}, [formula.formulaName]), statusChip(formula.status)]),
        h('p', { class: 'mono', style: 'color:var(--ink-3)' }, [formula.formulaCode]),
      ]);

      var wrap = h('div', {}, [metaCard, versionsCard, await accessPolicyPanel(formulaId)]);
      content.innerHTML = ''; content.appendChild(wrap);
    } catch (e) {
      content.innerHTML = ''; content.appendChild(notBuilt('This formula could not be loaded', e.message));
    }
  }

  async function createVersion(formulaId, versionNumber) {
    try {
      var v = await api('/v1/formula-versions', { method: 'POST', body: { formulaId: formulaId, versionNumber: versionNumber } });
      toast('Draft version v' + versionNumber + ' created.');
      location.hash = '#/version/' + v.formulaVersionId; render();
    } catch (e) { toast(e.message, true); }
  }

  /** Access grants (FORMULA_ACCESS_POLICY) — who besides the formula owner may read this
   * formula's plaintext. Only rendered for a caller holding read access to the policy table;
   * the add-grant form only for a caller holding write (vault_approver, per ra-roles.ts). */
  async function accessPolicyPanel(formulaId) {
    if (!hasPerm('formula:formula_access_policy:read')) return h('div', {});
    var body = h('div', {});
    try {
      var page = await api('/v1/formula-access-policies?limit=100');
      var grants = (page.items || []).filter(function (g) { return g.formulaId === formulaId; });
      var rows = grants.map(function (g) {
        return h('tr', {}, [h('td', { class: 'mono', 'data-label': 'User' }, [g.userId || '—']), h('td', { 'data-label': 'Role' }, [g.roleId || '—']), h('td', { 'data-label': 'Level' }, [String(g.accessLevel != null ? g.accessLevel : '—')])]);
      });
      body.appendChild(rows.length
        ? h('table', {}, [h('thead', {}, [h('tr', {}, [h('th', {}, ['User']), h('th', {}, ['Role']), h('th', {}, ['Level'])])]), h('tbody', {}, rows)])
        : h('div', { class: 'empty' }, [h('h3', {}, ['No extra grants']), h('p', {}, ['Only the formula owner can currently read its plaintext.'])]));
      if (hasPerm('formula:formula_access_policy:write')) {
        var uid = h('input', { class: 'fld', placeholder: 'User UUID', style: 'flex:1' });
        var add = h('button', { class: 'btn sm', onclick: async function () {
          if (!uid.value.trim()) return;
          try { await api('/v1/formula-access-policies', { method: 'POST', body: { formulaId: formulaId, userId: uid.value.trim() } }); toast('Access granted.'); location.hash = location.hash; render(); }
          catch (e) { toast(e.message, true); }
        } }, ['Grant']);
        body.appendChild(h('div', { style: 'display:flex;gap:8px;margin-top:10px' }, [uid, add]));
      }
    } catch (e) {
      body.appendChild(h('p', { style: 'color:var(--ink-3)' }, ['Access grants unavailable: ' + e.message]));
    }
    return h('div', { class: 'card' }, [h('div', { class: 'card-hd' }, [h('h2', {}, ['Access grants'])]), body]);
  }

  /* ── version detail: review / seal / approve / reject / reveal / supersede ────────────── */
  async function screenVersion(versionId) {
    var content = h('div', {}, [skeletonCard()]);
    renderShell('formulas', content);
    try {
      var version = await api('/v1/formula-versions/' + encodeURIComponent(versionId));
      var ingredients = await api('/v1/formula-versions/' + encodeURIComponent(versionId) + '/ingredients');
      var isAuthor = version.createdBy && session.userId && version.createdBy === session.userId;

      var header = h('div', { class: 'card' }, [
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Version v' + version.versionNumber]), statusChip(version.status)]),
        h('p', { class: 'mono', style: 'color:var(--ink-3)' }, ['formula_version_id: ' + version.formulaVersionId]),
        h('p', { style: 'color:var(--ink-3)' }, ['Structure: ' + (ingredients || []).length + ' ingredient(s) sealed (real material/percentage never shown here — only the audited /actual read decrypts them).']),
      ]);

      var PRE_DECISION = ['DRAFT', 'VERSIONED', 'REVIEW'];
      var actions = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
      var reasons = []; // plain-language reasons no (or fewer) actions are offered here

      if (version.status === 'DRAFT' && hasPerm('formula:formula_ingredients:write')) {
        actions.appendChild(h('button', { class: 'btn', onclick: function () { sealIngredientDialog(versionId); } }, ['Seal ingredient']));
      } else if (hasPerm('formula:formula_ingredients:write') && version.status !== 'DRAFT') {
        reasons.push('Sealing ingredients is only possible while the version is DRAFT — this version is ' + version.status + '.');
      }

      if (PRE_DECISION.indexOf(version.status) >= 0 && hasPerm('formula:formula_version:write')) {
        if (version.status === 'DRAFT') {
          var finalizeBtn = h('button', { class: 'btn', onclick: function () { finalize(versionId); } }, ['Finalize (→ VERSIONED)']);
          if (!(ingredients || []).length) {
            finalizeBtn.disabled = true; finalizeBtn.title = 'Seal at least one ingredient before finalizing.';
          }
          actions.appendChild(finalizeBtn);
        }
        actions.appendChild(h('button', { class: 'btn', onclick: function () { submitForReview(versionId); } }, ['Submit for review']));
      }

      if (PRE_DECISION.indexOf(version.status) >= 0 && hasPerm('formula:formula_approval:write')) {
        var approveBtn = h('button', { class: 'btn g', onclick: function () { decide(versionId, 'approve'); } }, ['Approve']);
        if (isAuthor) {
          approveBtn.disabled = true; approveBtn.title = 'You authored this draft — segregation of duties requires a different reviewer to approve it (§108).';
        }
        actions.appendChild(approveBtn);
        actions.appendChild(h('button', { class: 'btn r', onclick: function () { decide(versionId, 'reject'); } }, ['Reject']));
      }

      if (version.status === 'APPROVED' || version.status === 'LOCKED') {
        if (hasPerm('formula:actual:read')) {
          actions.appendChild(h('button', { class: 'btn r', onclick: function () { revealPlaintext(versionId, content); } }, ['Reveal plaintext']));
        }
        if (hasPerm('formula:formula_version:write')) {
          actions.appendChild(h('button', { class: 'btn', onclick: function () { createVersion(version.formulaId, (version.versionNumber || 0) + 1); } }, ['Create successor version (supersede)']));
        }
      }
      if (version.status === 'APPROVED' && hasPerm('formula:formula_approval:write')) {
        actions.appendChild(h('button', { class: 'btn g', onclick: function () { lockVersion(versionId); } }, ['Lock']));
      } else if (version.status === 'LOCKED') {
        reasons.push('This version is LOCKED — the final freeze after approval. A recipe change requires a new successor version, which supersedes this one automatically once approved.');
      }
      if (version.status === 'SUPERSEDED') {
        reasons.push('This version was SUPERSEDED' + (version.supersededByVersionId ? (' by formula_version_id ' + version.supersededByVersionId) : '') + ' — no longer the current version. It stays here as a read-only record.');
      }
      if (version.status === 'REJECTED') {
        reasons.push('This version was REJECTED. It cannot be resurrected — create a new version to try again.');
      }

      var actionsCard = h('div', { class: 'card' }, [
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Actions'])]),
        actions.children.length ? actions : null,
        reasons.length ? h('div', { style: 'color:var(--ink-3);font-size:12.5px;margin-top:' + (actions.children.length ? '10px' : '0') }, reasons.map(function (r) { return h('p', {}, [r]); })) : null,
        (!actions.children.length && !reasons.length) ? h('p', { style: 'color:var(--ink-3)' }, ['No actions available for your role at this stage.']) : null,
      ]);

      async function finalize(id) {
        try {
          await api('/v1/formula-versions/' + encodeURIComponent(id) + '/finalize', { method: 'POST' });
          toast('Version finalized (VERSIONED).');
          location.hash = location.hash; render();
        } catch (e) { toast(e.message, true); }
      }

      async function submitForReview(id) {
        try {
          await api('/v1/formula-versions/' + encodeURIComponent(id) + '/submit-for-review', { method: 'POST', body: {} });
          toast('Submitted for review.');
          location.hash = location.hash; render();
        } catch (e) { toast(e.message, true); }
      }

      async function lockVersion(id) {
        if (!window.confirm('Lock this version? This is the final freeze after approval — a recipe change after this requires a new successor version.')) return;
        try {
          await withFreshAuth(function () {
            return api('/v1/formula-versions/' + encodeURIComponent(id) + '/lock', { method: 'POST', body: {} });
          });
          toast('Version locked.');
          location.hash = location.hash; render();
        } catch (e) { toast(e.message, true); }
      }

      async function decide(id, kind) {
        // Gather remarks BEFORE the fresh-auth check — withFreshAuth's callback can run
        // twice (once optimistically, once after re-auth on a race), and window.prompt()
        // must only ever ask the user once.
        var remarks = window.prompt(kind === 'approve' ? 'Approval remarks (optional):' : 'Rejection reason (required, min 3 chars):');
        if (remarks === null) return; // cancelled
        remarks = remarks.trim();
        if (kind === 'reject' && remarks.length < 3) { toast('A rejection reason is required.', true); return; }
        try {
          await withFreshAuth(function () {
            return api('/v1/formula-versions/' + encodeURIComponent(id) + '/' + kind, { method: 'POST', body: kind === 'approve' ? { remarks: remarks || undefined } : { remarks: remarks } });
          });
          toast(kind === 'approve' ? 'Version approved.' : 'Version rejected.');
          location.hash = location.hash; render();
        } catch (e) { toast(e.message, true); }
      }

      var wrap = h('div', {}, [header, actionsCard]);
      content.innerHTML = ''; content.appendChild(wrap);
    } catch (e) {
      content.innerHTML = ''; content.appendChild(notBuilt('This version could not be loaded', e.message));
    }
  }

  // Material picker — searches GET /v1/vault/materials?q=... (vault:material_search:read;
  // minimal fields, no raw-UUID typing). Debounced live search into a <select> of matches;
  // picking a row sets `selected` to its {materialId, label}. Replaces the old plain
  // "Material UUID" text field.
  function materialPicker(onChange) {
    var selected = null;
    var searchInput = h('input', { class: 'fld', style: 'width:100%', placeholder: 'Search material by code or name…', autocomplete: 'off' });
    var results = h('select', { class: 'fld', style: 'width:100%;margin-top:6px', size: '5' });
    var picked = h('div', { style: 'font-size:12px;color:var(--ink-2);margin-top:6px;min-height:16px' }, ['No material selected.']);
    var timer = null;
    function renderResults(mats) {
      results.innerHTML = '';
      (mats || []).forEach(function (m) {
        var label = (m.materialCode || '—') + ' — ' + (m.materialName || m.materialId);
        results.appendChild(h('option', { value: m.materialId }, [label]));
      });
      results.style.display = (mats && mats.length) ? '' : 'none';
    }
    searchInput.addEventListener('input', function () {
      var q = searchInput.value.trim();
      if (timer) clearTimeout(timer);
      if (q.length < 2) { renderResults([]); return; }
      timer = setTimeout(function () {
        api('/v1/vault/materials?q=' + encodeURIComponent(q) + '&limit=20').then(function (mats) {
          renderResults(mats);
        }).catch(function () { renderResults([]); });
      }, 220);
    });
    results.addEventListener('change', function () {
      var opt = results.options[results.selectedIndex];
      if (!opt) return;
      selected = { materialId: opt.value, label: opt.textContent };
      picked.textContent = 'Selected: ' + selected.label;
      onChange && onChange(selected);
    });
    renderResults([]);
    return {
      el: h('div', {}, [searchInput, results, picked]),
      get: function () { return selected; },
    };
  }

  function sealIngredientDialog(versionId) {
    openDialog('Seal ingredient into the vault', function (body, close) {
      var err = h('div', { class: 'err' });
      var picker = materialPicker();
      var pct = h('input', { class: 'fld', style: 'width:100%', type: 'number', step: '0.01', placeholder: 'Percentage' });
      var seq = h('input', { class: 'fld', style: 'width:100%', type: 'number', placeholder: 'Sequence (optional)' });
      body.appendChild(h('p', { style: 'color:var(--ink-2);margin-bottom:10px' }, ['The material id + percentage are encrypted before they ever leave this request — they are never stored or shown as plaintext again outside an audited reveal.']));
      body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Material']), picker.el]));
      body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Percentage']), pct]));
      body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Sequence']), seq]));
      body.appendChild(err);
      var submit = h('button', { class: 'btn p' }, ['Seal into vault']);
      submit.addEventListener('click', async function () {
        var mat = picker.get();
        if (!mat || !pct.value) { err.textContent = 'A material (search and select one) and a percentage are required.'; return; }
        try {
          var ing = { materialId: mat.materialId, percentage: Number(pct.value) };
          if (seq.value) ing.sequenceNo = Number(seq.value);
          await api('/v1/formula-versions/' + encodeURIComponent(versionId) + '/ingredients', { method: 'POST', body: { ingredients: [ing] } });
          close(); toast('Ingredient sealed.'); location.hash = location.hash; render();
        } catch (e) { err.textContent = e.message; }
      });
      body.appendChild(h('div', { style: 'display:flex;gap:8px;margin-top:14px' }, [submit, h('button', { class: 'btn', onclick: close }, ['Cancel'])]));
    });
  }

  async function revealPlaintext(versionId, contentEl) {
    var reason;
    try { reason = await promptReason('Reveal formula plaintext'); } catch (e) { return; }
    if (!reason) return;
    try {
      var result = await withFreshAuth(function () {
        // Reason travels in the POST body, never the query string (security review item 9) —
        // it must never land in an access log or browser history.
        return api('/v1/formula-versions/' + encodeURIComponent(versionId) + '/actual', { method: 'POST', body: { reason: reason } });
      });
      var rows = (result.ingredients || []).map(function (i) {
        return h('tr', {}, [h('td', { class: 'mono' }, [i.materialId]), h('td', { class: 'r' }, [String(i.percentage) + '%']), h('td', {}, [String(i.sequenceNo != null ? i.sequenceNo : '—')])]);
      });
      var panel = h('div', { class: 'reveal-panel' }, [
        h('div', { class: 'hd' }, [icon(ICONS.alert, 14), 'DECRYPTED — logged with your reason']),
        h('table', {}, [h('thead', {}, [h('tr', {}, [h('th', {}, ['Material UUID']), h('th', { class: 'r' }, ['%']), h('th', {}, ['Seq'])])]), h('tbody', {}, rows)]),
        h('button', { class: 'btn sm', style: 'margin-top:10px', onclick: function () { panel.remove(); } }, ['Hide']),
      ]);
      contentEl.appendChild(panel);
    } catch (e) { toast(e.message, true); }
  }

  /* ── access audit / manufacturing-resolution audit ─────────────────────────────────────
   * Both screens read the SAME GET /v1/formula-access-audit (the one existing route over
   * formula.audit_events) and split client-side by action prefix: `formula.actual.read` /
   * `formula.version.approve*` / `formula.version.reject*` / `formula.copy.*` are HUMAN
   * access decisions; `formula.floor.read` / `formula.picklist.read` are the server-resolved
   * manufacturing reads (FormulaLookupService, §109.7) that never leave the backend as
   * plaintext but ARE audited the same way. */
  var HUMAN_PREFIXES = ['formula.actual.read', 'formula.version.approve', 'formula.version.reject', 'formula.version.finalized', 'formula.version.submitted_for_review', 'formula.version.locked', 'formula.version.superseded', 'formula.copy.', 'formula.created', 'formula.version.created', 'formula.ingredients.sealed', 'formula.stage'];
  var MFG_PREFIXES = ['formula.floor.read', 'formula.picklist.read', 'formula.manufacturing_instruction.resolve'];

  function auditTable(rows) {
    if (!rows.length) return h('div', { class: 'empty' }, [h('h3', {}, ['No rows']), h('p', {}, ['Nothing recorded yet.'])]);
    var trs = rows.map(function (r) {
      var resultChip = h('span', { class: 'chip ' + (r.result === 'refuse' ? 'r' : 'g') }, [r.result || 'allow']);
      return h('tr', {}, [
        h('td', { 'data-label': 'When' }, [fmtDt(r.occurredAt)]),
        h('td', { 'data-label': 'Actor' }, [r.actor || r.actorId || 'system']),
        h('td', { class: 'mono', 'data-label': 'Action' }, [r.action]),
        h('td', { class: 'mono', 'data-label': 'Entity' }, [(r.entityId || '').slice(0, 8) + '…']),
        h('td', { 'data-label': 'Reason' }, [r.reason || '—']),
        h('td', { 'data-label': 'Result' }, [resultChip]),
        h('td', { 'data-label': 'IP' }, [r.ip || '—']),
      ]);
    });
    return h('table', {}, [
      h('thead', {}, [h('tr', {}, ['When', 'Actor', 'Action', 'Entity', 'Reason', 'Result', 'IP'].map(function (c) { return h('th', {}, [c]); }))]),
      h('tbody', {}, trs),
    ]);
  }

  async function screenAudit(kind) {
    var content = h('div', {}, [skeletonCard()]);
    renderShell(kind === 'mfg' ? 'audit-mfg' : 'audit-access', content);
    if (!hasPerm('formula:actual:read')) {
      content.innerHTML = '';
      content.appendChild(notBuilt('Access audit unavailable', 'Your role does not hold formula:actual:read — the same Vault-authority permission that gates plaintext reads also gates the audit trail over them.'));
      return;
    }
    try {
      var page = await api('/v1/formula-access-audit?limit=200');
      var prefixes = kind === 'mfg' ? MFG_PREFIXES : HUMAN_PREFIXES;
      var rows = (page.items || []).filter(function (r) { return prefixes.some(function (p) { return r.action && r.action.indexOf(p) === 0; }); });
      var verify = h('button', { class: 'btn sm', onclick: async function () {
        try { var v = await api('/v1/formula-audit-verify'); toast(v.ok ? ('Chain verified: ' + v.rows + ' rows, no tampering detected.') : ('CHAIN BROKEN at seq ' + v.firstBadSeq + ': ' + v.reason), !v.ok); }
        catch (e) { toast(e.message, true); }
      } }, ['Verify chain integrity']);
      var card = h('div', { class: 'card' }, [
        h('div', { class: 'card-hd' }, [h('h2', {}, [kind === 'mfg' ? 'Manufacturing-resolution audit' : 'Access audit']), h('span', { class: 'n' }, [rows.length + ' of ' + (page.items || []).length + ' rows']), h('span', { class: 'spacer' }), verify]),
        kind === 'mfg' ? h('p', { style: 'color:var(--ink-3);margin-bottom:12px' }, ['Server-resolved coded/masked instructions handed to Production (§109.7) — no plaintext ever left the backend for these rows.']) : null,
        auditTable(rows),
      ]);
      content.innerHTML = ''; content.appendChild(card);
    } catch (e) {
      content.innerHTML = ''; content.appendChild(notBuilt('Audit trail could not be loaded', e.message));
    }
  }

  /* ---------------------------------------------------------------------------------------
   * 6. bootstrap + route render
   * --------------------------------------------------------------------------------------- */
  async function render() {
    if (!session.token) { renderLogin(); return; }
    var r = currentRoute();
    if (r.view === 'formula' && r.id) return screenFormula(r.id);
    if (r.view === 'version' && r.id) return screenVersion(r.id);
    if (r.view === 'audit-access') return screenAudit('access');
    if (r.view === 'audit-mfg') return screenAudit('mfg');
    return screenFormulas();
  }

  render();
})();
