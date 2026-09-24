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
 * shows a readable path, token, or payload for any Vault call either. PB-03 remainder (V4
 * §109.1): this console talks to TWO backends over TWO independent instances of that tunnel —
 * `VAULT_API` (the standalone Vault EC2, every formula/vault route) and `MAIN_API` (the main
 * app box, `/auth/alembic-assertion` + `/me` only — see section 1's header below for why).
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
   * 1. backend base(s) + encrypted tunnel (own implementation — this console shares no code
   *    with web/app.js, per the lane boundary; the WIRE PROTOCOL is the same because it's
   *    the backend's existing contract, not a copy of that file).
   *
   *    PB-03 remainder (V4 §109.1): TWO separate backends, TWO separate encrypted channels.
   *    `VAULT_API` is the standalone Vault EC2 (`vault-main.ts`/`VaultAppModule`) — every
   *    formula/vault route (`/v1/formulas`, `/v1/vault/materials`, …). It does NOT run
   *    `cluster-org`'s `AuthController` (no main-DB credential on that box at all — see
   *    `vault-app.module.ts`'s header), so `/auth/alembic-assertion` and `/me` are NOT
   *    reachable there. `MAIN_API` is the main app box (the SAME one every other RawProd
   *    console signs in against) — used ONLY for those two auth calls. Each backend runs its
   *    OWN `SessionKeysService` (in-memory per process — `backend/api/src/crypto`), so each
   *    needs its OWN independent ECDH handshake/AES session; `makeChannel` below is that
   *    per-backend state, instantiated twice.
   *
   *    Defaulting `MAIN_API` to `API` (this console's own `VAULT_API`/dev-fallback value) when
   *    unset keeps this a no-op today wherever the interim topology still runs the Vault box
   *    on the full AppModule (both consoles the same origin) — a deploy only needs to set
   *    `window.MAIN_API` once vault-api is actually cut over to `vault-main.ts`.
   * --------------------------------------------------------------------------------------- */
  // Backend base: same-origin '' always, unless overridden with window.VAULT_API — see
  // web/shell.js's own header comment for why a localhost-only :3000 guess here is wrong for
  // this codebase's actual (nginx reverse-proxy, same origin) local and deployed topology.
  var API = (typeof window.VAULT_API === 'string') ? window.VAULT_API : '';
  var MAIN_API = (typeof window.MAIN_API === 'string') ? window.MAIN_API : API;

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

  function VaultError(code, message, status) {
    this.code = code; this.message = message; this.status = status;
  }
  VaultError.prototype = Object.create(Error.prototype);

  /** One independent encrypted channel (handshake + /rpc) bound to `base`. Returns a `call(path,
   * opts)` that mirrors the old module-level `tunnel()`. Each backend (Vault box, main app box)
   * gets its own instance — the AES session key from one is meaningless to the other's
   * `SessionKeysService`. */
  function makeChannel(base) {
    var aesKey = null, keyId = null, handshakePromise = null;

    function handshake() {
      if (aesKey) return Promise.resolve();
      if (handshakePromise) return handshakePromise;
      handshakePromise = (async function () {
        var kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
        var pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
        var res = await fetch(base + '/crypto/handshake', {
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

    /** POST any REST call through this channel's single opaque /rpc envelope. Never call
     * fetch() directly for a formula/vault/auth route elsewhere in this file — these two
     * channels are the only chokepoints, so "no formula payload in the network tab" is true
     * by construction, not by convention. */
    return async function tunnel(path, opts) {
      opts = opts || {};
      await handshake();
      var payload = { method: (opts.method || 'GET').toUpperCase(), path: path };
      if (opts.body !== undefined) payload.body = opts.body;
      if (session.token) payload.token = session.token;
      var res = await fetch(base + '/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ra-key': keyId },
        body: JSON.stringify({ enc: await seal(JSON.stringify(payload)) }),
      });
      var envelope = await res.json();
      if (!envelope || !envelope.data || !envelope.data.enc) {
        // Transient failure (cold start / dropped connection) — reset and let the caller retry.
        aesKey = null; handshakePromise = null;
        throw new VaultError('NETWORK', 'Can\'t connect. Try again.', 0);
      }
      var inner = JSON.parse(await open(envelope.data.enc));
      var body = inner.body ? JSON.parse(inner.body) : null;
      return { status: inner.status, json: body };
    };
  }

  var vaultTunnel = makeChannel(API);
  var mainTunnel = makeChannel(MAIN_API);

  /** Call the tunnel and throw a VaultError on any >=400, carrying the server's error code
   * (AUTH_STEP_UP_REQUIRED, AUTH_FORBIDDEN, VALIDATION_FAILED, …) so callers can react —
   * e.g. the fresh-auth prompt fires specifically on AUTH_STEP_UP_REQUIRED, never on a
   * generic catch-all. */
  async function callTunnel(tunnel, path, opts) {
    var r = await tunnel(path, opts);
    if (r.status >= 400) {
      var err = (r.json && r.json.error) || {};
      throw new VaultError(err.code || 'UNKNOWN', err.message || ('Request failed (' + r.status + ')'), r.status);
    }
    return r.json ? r.json.data : null;
  }
  /** Every formula/vault route — the Vault EC2 (`VAULT_API`). */
  function api(path, opts) { return callTunnel(vaultTunnel, path, opts); }
  /** ONLY `/auth/alembic-assertion` and `/me` — the main app box (`MAIN_API`), the one process
   * that holds `iam.user_master` (see this section's header comment). */
  function mainApi(path, opts) { return callTunnel(mainTunnel, path, opts); }

  /* ---------------------------------------------------------------------------------------
   * 2. session (in-memory ONLY — never persisted; a reload always returns to the login
   *    screen, which is the correct behaviour for a short-idle-session secure console).
   * --------------------------------------------------------------------------------------- */
  var session = { token: null, iat: 0, email: null, userId: null, roles: [], permissions: [] };
  var FRESH_WINDOW_S = 300; // must match backend/backend-kernel FreshAuth default

  function hasPerm(p) { return session.permissions.indexOf(p) >= 0; }
  function isFresh() { return session.token && (Date.now() / 1000 - session.iat) < (FRESH_WINDOW_S - 15); }

  /* PB-04 / SB-02: password sign-in is retired for launch (FINAL_OS §2.4/§9). ALEMBIC's
   * email-OTP session is the only online staff identity rail; this exchanges a short-lived
   * signed assertion (minted there, on "Open Vault") for a session here, the same shape
   * `POST /auth/login` used to mint. `backend/cluster-org/src/auth/auth.service.ts` refuses
   * `/auth/login` unconditionally once APP_ENV=prod. */
  async function loginWithAssertion(assertion) {
    var data = await mainApi('/auth/alembic-assertion', { method: 'POST', body: { assertion: assertion } });
    session.token = data.accessToken;
    session.iat = Math.floor(Date.now() / 1000); // token was just minted — this IS its iat
    session.email = (data.user && data.user.email) || null;
    var me = await mainApi('/me');
    session.userId = me.userId;
    session.roles = me.roles || [];
    session.permissions = me.permissions || [];
  }

  function logout() {
    session.token = null; session.iat = 0; session.email = null; session.userId = null; session.roles = []; session.permissions = [];
    location.hash = '';
    render();
  }

  /* Where "Open ALEMBIC" sends the browser to confirm a fresh code — same deploy-time
   * convention as `VAULT_API`/`PLATFORM_API`. Unset is an honest "not configured", never a
   * guessed URL. */
  var ALEMBIC_CONSOLE_URL = (typeof window.ALEMBIC_CONSOLE_URL === 'string') ? window.ALEMBIC_CONSOLE_URL : '';

  /* Consumes `#assertion=...` left in the URL by an ALEMBIC redirect. `history.replaceState`
   * does not fire `hashchange`, so this cannot loop back into itself — see the identical
   * mechanism (and the fragment-not-query-string reasoning) in web-platform/platform.js. */
  var consumingAssertion = false;
  async function tryConsumeAssertion() {
    var m = /(?:^|[#&])assertion=([^&]+)/.exec(location.hash);
    if (!m || consumingAssertion) return false;
    consumingAssertion = true;
    var token = decodeURIComponent(m[1]);
    // Scrub the fragment BEFORE the exchange, not after — a single-use token must not sit in
    // the address bar even for the duration of one network round trip, and this also means a
    // later `location.hash = '#/formulas'` below cannot be clobbered by a stale scrub.
    history.replaceState(null, '', location.pathname + location.search);
    try {
      await loginWithAssertion(token);
      if (!hasPerm('formula:actual:read') && !session.permissions.some(function (p) { return p.indexOf('formula:') === 0; }) && !hasPerm('platform:flag:write')) {
        toast('This account has no Vault access. Ask an admin for a formulator or approver role.', true);
        logout();
      } else {
        location.hash = '#/formulas';
      }
    } catch (e) {
      toast('Sign-in didn\'t complete. ' + ((e instanceof VaultError) ? e.message : 'Try again.'), true);
    }
    consumingAssertion = false;
    return true;
  }

  /** Offer to re-authenticate on ALEMBIC. Password re-entry is retired, so there is no way
   *  to mint a fresh token IN PLACE any more — ALEMBIC is a separate, sole identity provider
   *  (FINAL_OS §2.4/§9) and this console holds no credential of its own to re-present.
   *
   *  THE TRADE-OFF, WRITTEN DOWN rather than pretended away: the old inline password prompt
   *  could retry the caller's pending action after re-auth, in place. A trip to ALEMBIC
   *  cannot — this console keeps nothing in storage by design (§109.4, "short idle
   *  session"), so returning from ALEMBIC is a NEW tab with a NEW session, not a resumed one.
   *  `withFreshAuth` below ends this tab's session rather than leave it holding a stale
   *  token, and the operator is told to repeat the action once signed in again — an honest
   *  extra step, not a silent "resume" this app cannot actually do. */
  function offerReauthViaAlembic() {
    return new Promise(function (resolve) {
      openDialog('Confirm it\'s you', function (body, close) {
        body.appendChild(h('p', { style: 'margin-bottom:12px;color:var(--ink-2)' }, [
          'Confirm a new code on ALEMBIC, then open Vault again.',
        ]));
        var actions = h('div', { style: 'display:flex;gap:8px;margin-top:14px' }, [
          h('button', { class: 'btn p', onclick: function () {
            if (ALEMBIC_CONSOLE_URL) window.open(ALEMBIC_CONSOLE_URL, '_blank', 'noopener');
            close(); resolve();
          } }, ['Open ALEMBIC →']),
          h('button', { class: 'btn', onclick: function () { close(); resolve(); } }, ['Cancel']),
        ]);
        body.appendChild(actions);
        if (!ALEMBIC_CONSOLE_URL) {
          body.appendChild(h('div', { class: 'err' }, ['Sign-in isn\'t set up for this build.']));
        }
      });
    });
  }

  /** Run `fn` (an async function making one or more `api()` calls). If it fails with
   * AUTH_STEP_UP_REQUIRED — or the client already knows the token is stale — this console can
   * no longer re-prove freshness itself (see `offerReauthViaAlembic`): it ends the session and
   * refuses, naming the one door that remains. */
  async function withFreshAuth(fn) {
    if (isFresh()) {
      try { return await fn(); }
      catch (e) {
        if (!(e instanceof VaultError) || e.code !== 'AUTH_STEP_UP_REQUIRED') throw e;
      }
    }
    await offerReauthViaAlembic();
    logout();
    throw new VaultError('REAUTH_REQUIRED', 'Confirm a new code on ALEMBIC, then open Vault again.', 0);
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
    panel: 'M4 4h16v16H4zM10 4v16',
    alert: 'M12 9v4M12 17h.01M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z',
    plus: 'M12 5v14M5 12h14',
    help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5M12 17h.01',
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

  function promptReason(label) {
    return new Promise(function (resolve) {
      openDialog(label || 'Reason required', function (body, close) {
        var err = h('div', { class: 'err' });
        var reason = h('textarea', { placeholder: 'e.g. QA investigation, batch mismatch' });
        body.appendChild(h('p', { style: 'margin-bottom:12px;color:var(--ink-2)' },
          ['Your name, reason and the time are logged.']));
        body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Reason']), reason]));
        body.appendChild(err);
        var submit = h('button', { class: 'btn r' }, ['Reveal']);
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
   * 3b. "How to use the Vault" — ticket G4's how-to for this console. Deliberately the ONLY
   * tutorial-related thing this console gets: a STATIC, read-only help panel. No lesson
   * runner, no ACTION dispatch, no VERIFY polling (which would mean an automated script
   * touching real formula data), no progress persistence, no fetch, no localStorage/
   * sessionStorage/IndexedDB — every word below is a hardcoded string built with the same
   * `h()` DOM builder every other screen in this file uses (never innerHTML), reusing the
   * existing `openDialog` true-modal primitive. This keeps every constraint in this file's own
   * header (§109.4: no manifest/SW/caching, formula data never leaves this page, no analytics)
   * intact — a how-to panel has nothing to do with any of those, so it changes none of them.
   * --------------------------------------------------------------------------------------- */
  function howToSection(title, lines) {
    return h('div', { style: 'margin-bottom:16px' }, [
      h('h3', { style: 'margin:0 0 6px;font:var(--w-med) var(--t-h3)/1.3 var(--font-ui)' }, [title]),
      h('div', { style: 'display:flex;flex-direction:column;gap:6px' },
        lines.map(function (line) { return h('p', { style: 'margin:0;color:var(--ink-2);font:var(--w-reg) var(--t-body)/var(--lh-body) var(--font-ui)' }, [line]); })),
    ]);
  }
  function openVaultHowTo() {
    openDialog('Help', function (body) {
      body.appendChild(howToSection('Sessions', [
        'Vault is separate from Factory. Reloading ends your session; open Vault from ALEMBIC to sign in again.',
        'You see only the formulas your role and grants allow.',
      ]));
      body.appendChild(howToSection('Versions', [
        'Draft → Versioned → Review → Approved → Locked. Rejected, archived and superseded versions stay read-only.',
      ]));
      body.appendChild(howToSection('Reveals', [
        'Revealing a formula asks for a reason. Who, why and when are logged and can\'t be edited.',
        'You are responsible for any screenshot or copy of revealed content.',
      ]));
      body.appendChild(howToSection('Approvals', [
        'Approvers can approve, reject or lock a submitted version. Authors can\'t approve their own work.',
      ]));
      body.appendChild(howToSection('Audit', [
        'Access audit lists every reveal and decision. Production audit lists coded instructions resolved for the floor.',
      ]));
    });
  }

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

  /* PB-04 / SB-02: no password form. The only door is ALEMBIC — a formulator/vault_approver
   * (or an admin, per the eligibility gate) signs in there and clicks "Open Vault", which is
   * itself gated behind a FRESH ALEMBIC step-up (see `rawprod-eligibility.ts` /
   * `rawprod-assertion.ts` in that repository) — this console's own FreshAuth window then
   * starts from that same moment. This screen renders only when there is no session AND no
   * assertion in the URL to consume (`tryConsumeAssertion`, above). */
  // UX-C: the one sign-in card all three RawProd consoles share (web/shell.js showLogin,
  // web-platform/platform.js renderLogin) — console name, one line, one button.
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
      h('h1', { class: 'mark' }, ['Vault']),
      h('p', { class: 'sub' }, ['Raw Aroma Chem formula access.']),
      goBtn, err,
    ]);
    root.appendChild(h('div', { class: 'login-wrap' }, [card]));
  }

  var NAV = [
    { id: 'formulas', label: 'Formulas', icon: 'lock', need: null },
    { id: 'audit-access', label: 'Access audit', icon: 'clipboard', need: 'formula:actual:read' },
    { id: 'audit-mfg', label: 'Production audit', icon: 'activity', need: 'formula:actual:read' },
  ];

  // Topbar + floating dock, rail off-canvas by default (ALEMBIC parity correction — see
  // web/ui-contract/shell.css's header comment + ALEMBIC_GUIDE_CORRECTIONS.md). The dock carries
  // the same NAV set as the rail so every route stays reachable with the rail collapsed; HOT picks
  // which ones keep a labelled segment in the phone tab-bar variant (vault.css max-width:1024).
  function renderShell(activeView, contentEl) {
    root.innerHTML = '';
    var visible = NAV.filter(function (n) { return !n.need || hasPerm(n.need); });
    var HOT = {}; visible.slice(0, 4).forEach(function (n) { HOT[n.id] = 1; });
    var navButtons = visible.map(function (n) {
      return h('button', { class: 'ri' + (n.id === activeView ? ' on' : ''), onclick: function () { location.hash = '#/' + n.id; } },
        [icon(ICONS[n.icon]), h('span', { class: 'nm' }, [n.label])]);
    });
    var rail = h('nav', { class: 'rail', id: 'vault-rail' }, [
      h('button', { class: 'rail-toggle', 'aria-label': 'Hide navigation', onclick: function () { rail.classList.remove('open'); } }, [icon(ICONS.panel, 16)]),
      h('button', { class: 'rb', 'aria-label': 'Vault, Raw Aroma Chem', onclick: function () { location.hash = '#/formulas'; } }, [/* UX-D: the logo, not the RAC tile -- logo/brand.css */ h('img', { class: 'brand-logo brand-logo--rail', src: '/logo/raw-logo-ondark.png', srcset: '/logo/raw-logo-ondark.png 1x, /logo/raw-logo-ondark@2x.png 2x, /logo/raw-logo-ondark@3x.png 3x', width: '66', height: '30', alt: '' }), h('span', { class: 't' }, ['Vault', h('small', {}, ['Raw Aroma Chem'])])]),
      h('div', { class: 'rail-deep' }, [h('div', { class: 'rs' }, ['Formulas']), h('div', {}, navButtons)]),
      h('div', { class: 'rme' }, [
        h('span', { class: 'av' }, [(session.email || '?').slice(0, 2).toUpperCase()]),
        h('span', { class: 'who' }, [session.email]),
        h('button', { class: 'btn sm', style: 'margin-left:auto', onclick: openVaultHowTo, 'aria-label': 'Help', title: 'Help' }, [icon(ICONS.help, 14)]),
        h('button', { class: 'btn sm', onclick: logout, 'aria-label': 'Sign out', title: 'Sign out' }, [icon(ICONS.logout, 14)]),
      ]),
    ]);
    // §109.4 secure-zone banner: kept (the one allowed security-context departure), shortened to
    // what the viewer needs — reveals are logged, and whose session this is.
    var banner = h('div', { class: 'secure-banner' }, [
      h('span', { class: 'dot' }),
      h('span', {}, ['Secure zone · every reveal is logged']),
      h('span', { class: 'who-when' }, [session.email + ' · ' + new Date().toLocaleString()]),
    ]);
    var label = visible.filter(function (n) { return n.id === activeView; })[0] ? visible.filter(function (n) { return n.id === activeView; })[0].label : 'Vault';
    var main = h('div', { class: 'main' }, [banner, h('div', { class: 'bar' }, [h('h1', {}, [label])]), h('div', { class: 'content' }, [contentEl])]);
    var dock = h('div', { class: 'qdock', role: 'navigation', 'aria-label': 'Sections' },
      [h('button', { class: 'qb dock-toggle hot', 'aria-label': 'Show navigation', title: 'Sections', onclick: function () { rail.classList.toggle('open'); } }, [icon(ICONS.panel, 17), h('span', { class: 'nm' }, ['Sections'])]), h('span', { class: 'sep' })]
      .concat(visible.map(function (n) {
        return h('button', { class: 'qb' + (n.id === activeView ? ' on' : '') + (HOT[n.id] ? ' hot' : ''), title: n.label, 'aria-label': n.label, onclick: function () { location.hash = '#/' + n.id; } }, [icon(ICONS[n.icon], 17), h('span', { class: 'nm' }, [n.label])]);
      })));
    root.appendChild(h('div', { class: 'app' }, [rail, main, dock]));
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
        : h('div', { class: 'empty' }, [h('h3', {}, ['No formulas yet']), h('p', {}, [canCreate ? 'Create one to get started.' : 'A formulator can create one.'])]);
      var card = h('div', { class: 'card' }, [
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Formulas']), h('span', { class: 'n' }, [(page.items || []).length + ' shown']), h('span', { class: 'spacer' }),
          canCreate ? h('button', { class: 'btn p', onclick: newFormulaDialog }, [icon(ICONS.plus, 14), 'New formula']) : null]),
        table,
      ]);
      content.innerHTML = ''; content.appendChild(card);
    } catch (e) {
      content.innerHTML = '';
      content.appendChild(notBuilt('Formulas didn\'t load', e.message));
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
        if (!code.value.trim() || !name.value.trim()) { err.textContent = 'Enter a code and a name.'; return; }
        try {
          var f = await api('/v1/formulas', { method: 'POST', body: { formulaCode: code.value.trim(), formulaName: name.value.trim() } });
          close(); toast('Formula created'); location.hash = '#/formula/' + f.formulaId; render();
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
          canDraft ? h('button', { class: 'btn p sm', onclick: function () { createVersion(formulaId, maxVersion + 1); } }, ['New version']) : null]),
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
      content.innerHTML = ''; content.appendChild(notBuilt('Formula didn\'t load', e.message));
    }
  }

  async function createVersion(formulaId, versionNumber) {
    try {
      var v = await api('/v1/formula-versions', { method: 'POST', body: { formulaId: formulaId, versionNumber: versionNumber } });
      toast('Version v' + versionNumber + ' created');
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
        : h('div', { class: 'empty' }, [h('h3', {}, ['No grants']), h('p', {}, ['Only the owner can read this formula.'])]));
      if (hasPerm('formula:formula_access_policy:write')) {
        var uid = h('input', { class: 'fld', placeholder: 'User UUID', style: 'flex:1' });
        var add = h('button', { class: 'btn sm', onclick: async function () {
          if (!uid.value.trim()) return;
          try { await api('/v1/formula-access-policies', { method: 'POST', body: { formulaId: formulaId, userId: uid.value.trim() } }); toast('Access granted'); location.hash = location.hash; render(); }
          catch (e) { toast(e.message, true); }
        } }, ['Grant']);
        body.appendChild(h('div', { style: 'display:flex;gap:8px;margin-top:10px' }, [uid, add]));
      }
    } catch (e) {
      body.appendChild(h('p', { class: 'card-note' }, ['Grants unavailable. ' + e.message]));
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
        h('p', { class: 'mono', style: 'color:var(--ink-3)' }, [version.formulaVersionId]),
        h('p', { style: 'color:var(--ink-3)' }, [(ingredients || []).length + ' sealed ingredient' + ((ingredients || []).length === 1 ? '' : 's')]),
      ]);

      var PRE_DECISION = ['DRAFT', 'VERSIONED', 'REVIEW'];
      var actions = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
      var reasons = []; // plain-language reasons no (or fewer) actions are offered here

      if (version.status === 'DRAFT' && hasPerm('formula:formula_ingredients:write')) {
        actions.appendChild(h('button', { class: 'btn', onclick: function () { sealIngredientDialog(versionId); } }, ['Seal ingredient']));
      } else if (hasPerm('formula:formula_ingredients:write') && version.status !== 'DRAFT') {
        reasons.push('Ingredients can only be sealed while the version is a draft.');
      }

      if (PRE_DECISION.indexOf(version.status) >= 0 && hasPerm('formula:formula_version:write')) {
        if (version.status === 'DRAFT') {
          var finalizeBtn = h('button', { class: 'btn', onclick: function () { finalize(versionId); } }, ['Finalize']);
          if (!(ingredients || []).length) {
            finalizeBtn.disabled = true; finalizeBtn.title = 'Seal an ingredient first.';
          }
          actions.appendChild(finalizeBtn);
        }
        actions.appendChild(h('button', { class: 'btn', onclick: function () { submitForReview(versionId); } }, ['Submit for review']));
      }

      if (PRE_DECISION.indexOf(version.status) >= 0 && hasPerm('formula:formula_approval:write')) {
        var approveBtn = h('button', { class: 'btn g', onclick: function () { decide(versionId, 'approve'); } }, ['Approve']);
        if (isAuthor) {
          approveBtn.disabled = true; approveBtn.title = 'You wrote this version, so someone else must approve it.';
        }
        actions.appendChild(approveBtn);
        actions.appendChild(h('button', { class: 'btn r', onclick: function () { decide(versionId, 'reject'); } }, ['Reject']));
      }

      if (version.status === 'APPROVED' || version.status === 'LOCKED') {
        if (hasPerm('formula:actual:read')) {
          actions.appendChild(h('button', { class: 'btn r', onclick: function () { revealPlaintext(versionId, content); } }, ['Reveal formula']));
        }
        if (hasPerm('formula:formula_version:write')) {
          actions.appendChild(h('button', { class: 'btn', onclick: function () { createVersion(version.formulaId, (version.versionNumber || 0) + 1); } }, ['New version']));
        }
      }
      if (version.status === 'APPROVED' && hasPerm('formula:formula_approval:write')) {
        actions.appendChild(h('button', { class: 'btn g', onclick: function () { lockVersion(versionId); } }, ['Lock']));
      } else if (version.status === 'LOCKED') {
        reasons.push('Locked. To change the recipe, create a new version.');
      }
      if (version.status === 'SUPERSEDED') {
        reasons.push('Superseded by a newer version. Read-only.');
      }
      if (version.status === 'REJECTED') {
        reasons.push('Rejected. Create a new version to try again.');
      }

      var actionsCard = h('div', { class: 'card' }, [
        h('div', { class: 'card-hd' }, [h('h2', {}, ['Actions'])]),
        actions.children.length ? actions : null,
        reasons.length ? h('div', { style: 'color:var(--ink-3);font:var(--w-reg) var(--t-cap)/var(--lh-cap) var(--font-ui);margin-top:' + (actions.children.length ? '10px' : '0') }, reasons.map(function (r) { return h('p', {}, [r]); })) : null,
        (!actions.children.length && !reasons.length) ? h('p', { style: 'color:var(--ink-3)' }, ['Nothing to do here for your role.']) : null,
      ]);

      async function finalize(id) {
        try {
          await api('/v1/formula-versions/' + encodeURIComponent(id) + '/finalize', { method: 'POST' });
          toast('Version finalized');
          location.hash = location.hash; render();
        } catch (e) { toast(e.message, true); }
      }

      async function submitForReview(id) {
        try {
          await api('/v1/formula-versions/' + encodeURIComponent(id) + '/submit-for-review', { method: 'POST', body: {} });
          toast('Submitted for review');
          location.hash = location.hash; render();
        } catch (e) { toast(e.message, true); }
      }

      async function lockVersion(id) {
        if (!window.confirm('Lock this version? Changes after this need a new version.')) return;
        try {
          await withFreshAuth(function () {
            return api('/v1/formula-versions/' + encodeURIComponent(id) + '/lock', { method: 'POST', body: {} });
          });
          toast('Version locked');
          location.hash = location.hash; render();
        } catch (e) { toast(e.message, true); }
      }

      async function decide(id, kind) {
        // Gather remarks BEFORE the fresh-auth check — withFreshAuth's callback can run
        // twice (once optimistically, once after re-auth on a race), and window.prompt()
        // must only ever ask the user once.
        var remarks = window.prompt(kind === 'approve' ? 'Remarks (optional):' : 'Reason for rejecting (required):');
        if (remarks === null) return; // cancelled
        remarks = remarks.trim();
        if (kind === 'reject' && remarks.length < 3) { toast('A rejection reason is required.', true); return; }
        try {
          await withFreshAuth(function () {
            return api('/v1/formula-versions/' + encodeURIComponent(id) + '/' + kind, { method: 'POST', body: kind === 'approve' ? { remarks: remarks || undefined } : { remarks: remarks } });
          });
          toast(kind === 'approve' ? 'Version approved' : 'Version rejected');
          location.hash = location.hash; render();
        } catch (e) { toast(e.message, true); }
      }

      var wrap = h('div', {}, [header, actionsCard]);
      content.innerHTML = ''; content.appendChild(wrap);
    } catch (e) {
      content.innerHTML = ''; content.appendChild(notBuilt('Version didn\'t load', e.message));
    }
  }

  // Material picker — searches GET /v1/vault/materials?q=... (vault:material_search:read;
  // minimal fields, no raw-UUID typing). Debounced live search into a <select> of matches;
  // picking a row sets `selected` to its {materialId, label}. Replaces the old plain
  // "Material UUID" text field.
  function materialPicker(onChange) {
    var selected = null;
    var searchInput = h('input', { class: 'fld', style: 'width:100%', placeholder: 'Search materials', autocomplete: 'off' });
    var results = h('select', { class: 'fld', style: 'width:100%;margin-top:6px', size: '5' });
    var picked = h('div', { style: 'font:var(--w-reg) var(--t-cap)/1.3 var(--font-ui);color:var(--ink-2);margin-top:6px;min-height:16px' }, ['None selected']);
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
    openDialog('Seal ingredient', function (body, close) {
      var err = h('div', { class: 'err' });
      var picker = materialPicker();
      var pct = h('input', { class: 'fld', style: 'width:100%', type: 'number', step: '0.01', placeholder: 'Percentage' });
      var seq = h('input', { class: 'fld', style: 'width:100%', type: 'number', placeholder: 'Sequence (optional)' });
      body.appendChild(h('p', { style: 'color:var(--ink-2);margin-bottom:10px' }, ['Stored encrypted. Shown again only in a logged reveal.']));
      body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Material']), picker.el]));
      body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Percentage']), pct]));
      body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'lbl' }, ['Sequence']), seq]));
      body.appendChild(err);
      var submit = h('button', { class: 'btn p' }, ['Seal']);
      submit.addEventListener('click', async function () {
        var mat = picker.get();
        if (!mat || !pct.value) { err.textContent = 'Pick a material and enter a percentage.'; return; }
        try {
          var ing = { materialId: mat.materialId, percentage: Number(pct.value) };
          if (seq.value) ing.sequenceNo = Number(seq.value);
          await api('/v1/formula-versions/' + encodeURIComponent(versionId) + '/ingredients', { method: 'POST', body: { ingredients: [ing] } });
          close(); toast('Ingredient sealed'); location.hash = location.hash; render();
        } catch (e) { err.textContent = e.message; }
      });
      body.appendChild(h('div', { style: 'display:flex;gap:8px;margin-top:14px' }, [submit, h('button', { class: 'btn', onclick: close }, ['Cancel'])]));
    });
  }

  async function revealPlaintext(versionId, contentEl) {
    var reason;
    try { reason = await promptReason('Reveal formula'); } catch (e) { return; }
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
        h('div', { class: 'hd' }, [icon(ICONS.alert, 14), 'Revealed · logged with your reason']),
        h('table', {}, [h('thead', {}, [h('tr', {}, [h('th', {}, ['Material']), h('th', { class: 'r' }, ['%']), h('th', {}, ['Seq'])])]), h('tbody', {}, rows)]),
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
    if (!rows.length) return h('div', { class: 'empty' }, [h('h3', {}, ['Nothing recorded yet'])]);
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
      content.appendChild(notBuilt('Audit unavailable', 'Your role doesn\'t include this.'));
      return;
    }
    try {
      var page = await api('/v1/formula-access-audit?limit=200');
      var prefixes = kind === 'mfg' ? MFG_PREFIXES : HUMAN_PREFIXES;
      var rows = (page.items || []).filter(function (r) { return prefixes.some(function (p) { return r.action && r.action.indexOf(p) === 0; }); });
      var verify = h('button', { class: 'btn sm', onclick: async function () {
        try { var v = await api('/v1/formula-audit-verify'); toast(v.ok ? ('Verified · ' + v.rows + ' rows intact') : ('Broken at row ' + v.firstBadSeq + ': ' + v.reason), !v.ok); }
        catch (e) { toast(e.message, true); }
      } }, ['Verify']);
      var card = h('div', { class: 'card' }, [
        h('div', { class: 'card-hd' }, [h('h2', {}, [kind === 'mfg' ? 'Production audit' : 'Access audit']), h('span', { class: 'n' }, [rows.length + ' rows']), h('span', { class: 'spacer' }), verify]),
        kind === 'mfg' ? h('p', { class: 'card-note' }, ['Coded instructions resolved for production. No formula left the server.']) : null,
        auditTable(rows),
      ]);
      content.innerHTML = ''; content.appendChild(card);
    } catch (e) {
      content.innerHTML = ''; content.appendChild(notBuilt('Audit didn\'t load', e.message));
    }
  }

  /* ---------------------------------------------------------------------------------------
   * 6. bootstrap + route render
   * --------------------------------------------------------------------------------------- */
  async function render() {
    if (!session.token) {
      if (await tryConsumeAssertion()) { render(); return; }
      renderLogin();
      return;
    }
    var r = currentRoute();
    if (r.view === 'formula' && r.id) return screenFormula(r.id);
    if (r.view === 'version' && r.id) return screenVersion(r.id);
    if (r.view === 'audit-access') return screenAudit('access');
    if (r.view === 'audit-mfg') return screenAudit('mfg');
    return screenFormulas();
  }

  render();
})();
