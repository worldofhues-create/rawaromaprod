/* focus.js: focus mode and the "open as an app" offer for the RawProd consoles.
 *
 * Owner requirement 2026-09-29: consoles open full screen, without the address bar, "like a
 * focus mode", on every browser. A page cannot hide browser chrome by itself, so this file uses
 * the two legitimate ways there are:
 *
 *   1. App window. Each console has a web app manifest (display standalone, with
 *      window-controls-overlay first where the browser supports it). Until the console is
 *      installed, a small card offers it, with the one step that works in this browser:
 *      Chrome/Edge install, Safari on a Mac "File > Add to Dock", iPhone/iPad "Share > Add to
 *      Home Screen", Firefox (which cannot install sites) is pointed at focus mode instead.
 *      "Not now" hides the card for a week.
 *   2. Focus mode in a normal tab. On the first click after the page loads, the document root
 *      goes full screen (Fullscreen API, webkit-prefixed for older Safari). On by default; one
 *      switch in the console menu turns it off and remembers that. Never a trap:
 *        - an "Exit focus mode" control appears whenever it is full screen;
 *        - Esc leaves full screen (the browser's own rule), and a second Esc within 3 seconds
 *          turns focus mode off for the rest of this browser session;
 *        - nothing happens in an installed app window (already chromeless) or on iPhone
 *          (Safari there only lets video go full screen).
 *
 * What it must never touch: the ALEMBIC sign-in hand-off. A click on a link never triggers full
 * screen (so "Sign in via ALEMBIC" and the ?open= return link navigate exactly as before), and
 * nothing is requested while an `#assertion=` fragment is still waiting to be consumed. This
 * file never reads or writes location, history, cookies, fetch or caches. Its only storage is
 * three UI switches (on/off, week-long "not now", installed) in localStorage and the session-off
 * flag in sessionStorage; no session, token or business data.
 *
 * Identical copies live in web/, web-platform/ and web-vault/ because each console is served
 * from its own root. Edit one, copy it to the other two (a test checks they match).
 */
(function (g) {
  'use strict';
  if (g.RaFocus) return;

  var DAY_MS = 24 * 60 * 60 * 1000;
  var REOFFER_MS = 7 * DAY_MS;      // "Not now" hides the install card for a week
  var ESC_WINDOW_MS = 3000;         // a second Esc within this long turns focus mode off
  var ESC_DEBOUNCE_MS = 100;        // ignore an Esc that is the same press that left full screen
  var KEY_PREF = 'rac.console.focus.v1';                // '1' on, '0' off; unset = on
  var KEY_SESSION_OFF = 'rac.console.focus.session-off'; // sessionStorage, '1' = off this session
  var KEY_DISMISSED = 'rac.console.install.dismissed.v1'; // ms timestamp of "Not now"
  var KEY_INSTALLED = 'rac.console.install.installed.v1'; // '1' once seen installed

  /* ---------------------------------------------------------------------------------------
   * Pure decisions. No DOM, no storage: every input is passed in, so they are unit-tested
   * (backend/api/src/__tests__/console-focus-mode.test.ts).
   * --------------------------------------------------------------------------------------- */

  function isIPhone(ua) { return /\b(iPhone|iPod)\b/.test(ua || ''); }

  /** iPadOS 13+ Safari reports a Mac user agent; the touch points give it away. */
  function isIOS(ua, platform, maxTouchPoints) {
    return /\b(iPhone|iPad|iPod)\b/.test(ua || '') || (platform === 'MacIntel' && (maxTouchPoints || 0) > 1);
  }

  /** Which install instructions apply. */
  function browserKind(env) {
    var ua = (env && env.ua) || '';
    if (isIOS(ua, env && env.platform, env && env.maxTouchPoints)) return 'ios';
    var android = /Android/.test(ua);
    if (/Firefox\//.test(ua)) return android ? 'firefox-android' : 'firefox';
    if (/SamsungBrowser\//.test(ua)) return 'android';
    if (/Edg(e|A|iOS)?\//.test(ua)) return android ? 'android' : 'edge';
    if (/(Chrome|Chromium|CriOS)\//.test(ua)) return android ? 'android' : 'chrome';
    if (/Safari\//.test(ua) && /Macintosh/.test(ua)) return 'safari-mac';
    return 'other';
  }

  /** The one plain instruction for opening this console in its own window, per browser. */
  function installHelp(kind, app) {
    var name = app || 'this console';
    switch (kind) {
      case 'chrome': return 'In Chrome, click the install icon at the right of the address bar, or open the ⋮ menu > Cast, save and share > Install page as app. ' + name + ' then opens in its own window.';
      case 'edge': return 'In Edge, open the … menu > Apps > Install this site as an app. ' + name + ' then opens in its own window.';
      case 'safari-mac': return 'In Safari, choose File > Add to Dock. ' + name + ' then opens from the Dock in its own window.';
      case 'ios': return 'Tap Share, then Add to Home Screen. Open ' + name + ' from your Home Screen for a full-screen app.';
      case 'firefox': return 'Firefox cannot install sites as apps. Focus mode keeps ' + name + ' full screen instead: it is on, and starts at your first click. F11 (Ctrl+Cmd+F on a Mac) also works.';
      case 'firefox-android': return 'Open the ⋮ menu > Add to Home screen, then open ' + name + ' from your Home screen.';
      case 'android': return 'Open the browser menu > Install app (or Add to Home screen), then open ' + name + ' from your Home screen.';
      default: return 'Use your browser\'s Install or Add to Home Screen option to open ' + name + ' in its own window. Until then, focus mode keeps it full screen.';
    }
  }

  /** An ALEMBIC hand-off is still waiting in the URL (the console consumes and scrubs it). */
  function handoffPending(hash) { return /(?:^|[#&])assertion=/.test(hash || ''); }

  /**
   * Should this click turn full screen on? Returns { go, why } so a test (and a curious reader)
   * sees the reason. s = { pref, sessionOff, appWindow, iphone, fsEnabled, inFullscreen,
   * hash, hidden, skipTarget }.
   */
  function focusDecision(s) {
    if (!s.pref) return { go: false, why: 'pref-off' };
    if (s.sessionOff) return { go: false, why: 'session-off' };
    if (s.appWindow) return { go: false, why: 'app-window' };
    if (s.iphone) return { go: false, why: 'iphone' };
    if (!s.fsEnabled) return { go: false, why: 'unsupported' };
    if (s.inFullscreen) return { go: false, why: 'already' };
    if (handoffPending(s.hash)) return { go: false, why: 'handoff' };
    if (s.hidden) return { go: false, why: 'hidden' };
    if (s.skipTarget) return { go: false, why: 'skip-target' };
    return { go: true, why: 'go' };
  }

  /**
   * An Esc arrived while NOT full screen: does it turn focus mode off for the session? Only when
   * the user left full screen themselves within the last 3 seconds, and the Esc is not closing
   * something in the page (a dialog, the Aria panel, the phone rail).
   * s = { lastUserExitAt, now, overlayOpen }.
   */
  function escTurnsOff(s) {
    if (s.lastUserExitAt == null || s.overlayOpen) return false;
    var d = s.now - s.lastUserExitAt;
    return d >= ESC_DEBOUNCE_MS && d <= ESC_WINDOW_MS;
  }

  /** Show the "open as an app" card? s = { appWindow, installed, dismissedAt, now }. */
  function installOffer(s) {
    if (s.appWindow || s.installed) return false;
    if (s.dismissedAt == null || !isFinite(s.dismissedAt)) return true;
    return s.now - s.dismissedAt >= REOFFER_MS;
  }

  var PURE = {
    REOFFER_MS: REOFFER_MS, ESC_WINDOW_MS: ESC_WINDOW_MS,
    KEYS: { pref: KEY_PREF, sessionOff: KEY_SESSION_OFF, dismissed: KEY_DISMISSED, installed: KEY_INSTALLED },
    isIPhone: isIPhone, isIOS: isIOS, browserKind: browserKind, installHelp: installHelp,
    handoffPending: handoffPending, focusDecision: focusDecision, escTurnsOff: escTurnsOff,
    installOffer: installOffer
  };

  var d = g.document;
  if (!d || !d.documentElement) { g.RaFocus = PURE; return; }

  /* ---------------------------------------------------------------------------------------
   * Browser side.
   * --------------------------------------------------------------------------------------- */
  var script = d.currentScript;
  var APP = (script && script.getAttribute('data-app')) || d.title || 'this console';
  var nav = g.navigator || {};
  var selfExit = false, lastUserExitAt = null, deferredPrompt = null, card = null, exitBtn = null, hideTimer = 0;

  function get(store, k) { try { return g[store].getItem(k); } catch (e) { return null; } }
  function set(store, k, v) { try { if (v == null) g[store].removeItem(k); else g[store].setItem(k, v); } catch (e) { /* storage off */ } }
  function pref() { return get('localStorage', KEY_PREF) !== '0'; }
  function sessionOff() { return get('sessionStorage', KEY_SESSION_OFF) === '1'; }
  function isOn() { return pref() && !sessionOff(); }

  function mm(q) { try { return !!(g.matchMedia && g.matchMedia(q).matches); } catch (e) { return false; } }
  /** An installed app window. Not `display-mode: fullscreen`: that also matches a browser tab
   *  in F11 or in our own focus mode, and would wrongly mark the console installed. */
  function appWindow() {
    return nav.standalone === true || mm('(display-mode: standalone)') || mm('(display-mode: window-controls-overlay)') || mm('(display-mode: minimal-ui)');
  }
  function fsElement() { return d.fullscreenElement || d.webkitFullscreenElement || null; }
  function fsEnabled() { return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled); }
  function overlayOpen() {
    return !!d.querySelector('[aria-modal="true"], dialog[open], .aria-dock.open') ||
      !!(d.body && d.body.classList.contains('rail-open'));
  }
  function skipTarget(t) {
    // Links (the ALEMBIC sign-in and ?open= return link), the whole sign-in screen, native
    // pickers, and anything marked data-focus-skip (the Vault's "Open ALEMBIC" step-up) never
    // trigger full screen: those clicks navigate or open something the browser owns.
    return !!(t && t.closest && t.closest('a[href], select, input[type="file"], .login-wrap, [data-focus-skip], [data-ra-focus]'));
  }
  function state(target) {
    return {
      pref: pref(), sessionOff: sessionOff(), appWindow: appWindow(), iphone: isIPhone(nav.userAgent),
      fsEnabled: fsEnabled(), inFullscreen: !!fsElement(), hash: (g.location && g.location.hash) || '',
      hidden: !!d.hidden, skipTarget: skipTarget(target)
    };
  }

  function enter() {
    var el = d.documentElement, p = null;
    try {
      if (el.requestFullscreen) p = el.requestFullscreen({ navigationUI: 'hide' });
      else if (el.webkitRequestFullscreen) p = el.webkitRequestFullscreen();
    } catch (e) { /* refused: stay in the tab */ }
    if (p && p.catch) p.catch(function () {});
  }
  function exit() {
    if (!fsElement()) return;
    selfExit = true;
    var p = null;
    try {
      if (d.exitFullscreen) p = d.exitFullscreen();
      else if (d.webkitExitFullscreen) p = d.webkitExitFullscreen();
    } catch (e) { selfExit = false; }
    if (p && p.catch) p.catch(function () { selfExit = false; });
  }

  /* Small styles, injected once. The consoles' CSP allows inline styles ('unsafe-inline'). */
  function css() {
    if (d.getElementById('ra-focus-css')) return;
    var s = d.createElement('style');
    s.id = 'ra-focus-css';
    s.textContent = [
      '.ra-focus-exit{position:fixed;top:10px;left:50%;transform:translate(-50%,-160%);z-index:9000;display:inline-flex;align-items:center;gap:6px;',
      'padding:7px 12px;border-radius:999px;border:.5px solid rgba(255,255,255,.18);background:rgba(18,19,17,.9);color:#F2F4EA;',
      'font:500 12px/1 var(--font-ui,var(--ui,system-ui,sans-serif));cursor:pointer;transition:transform .2s ease;min-height:32px}',
      '.ra-focus-exit.show,.ra-focus-exit:focus-visible{transform:translate(-50%,0)}',
      '.ra-focus-exit[hidden],.ra-focus-note[hidden]{display:none}',
      '.ra-focus-note{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:9001;max-width:min(440px,calc(100vw - 32px));',
      'padding:10px 14px;border-radius:12px;background:rgba(18,19,17,.94);color:#F2F4EA;font:400 12.5px/1.45 var(--font-ui,var(--ui,system-ui,sans-serif));',
      'box-shadow:0 18px 40px -20px rgba(0,0,0,.7);pointer-events:none}',
      '.ra-install{position:fixed;left:16px;bottom:16px;z-index:580;width:min(360px,calc(100vw - 32px));display:flex;gap:12px;align-items:flex-start;',
      'padding:14px;border-radius:16px;background:rgba(18,19,17,.96);color:#F2F4EA;border:.5px solid rgba(255,255,255,.14);',
      'box-shadow:0 22px 44px -22px rgba(0,0,0,.8);font:400 12.5px/1.45 var(--font-ui,var(--ui,system-ui,sans-serif))}',
      '.ra-install img{width:40px;height:40px;border-radius:10px;flex:0 0 auto}',
      '.ra-install b{display:block;font-weight:500;font-size:13.5px;margin-bottom:3px}',
      '.ra-install p{margin:0 0 10px;opacity:.8}',
      '.ra-install .ra-i-row{display:flex;gap:8px;flex-wrap:wrap}',
      '.ra-install button{min-height:32px;padding:0 12px;border-radius:9px;border:.5px solid rgba(255,255,255,.22);background:transparent;color:inherit;font:inherit;cursor:pointer}',
      '.ra-install button.p{background:#E9F260;color:#141413;border-color:#E9F260;font-weight:500}',
      '.ra-titlebar{display:none}',
      '@media (display-mode: window-controls-overlay){',
      '.ra-titlebar{display:flex;align-items:center;position:fixed;left:env(titlebar-area-x,0);top:env(titlebar-area-y,0);',
      'width:env(titlebar-area-width,100%);height:env(titlebar-area-height,0px);padding:0 12px;z-index:8999;box-sizing:border-box;',
      '-webkit-app-region:drag;app-region:drag;font:500 12px/1 var(--font-ui,var(--ui,system-ui,sans-serif));color:var(--ink-2,#5C5C56);background:var(--bg,#EDEDEB)}',
      '.stage{margin-top:env(titlebar-area-height,0px) !important;height:calc(100dvh - env(titlebar-area-height,0px)) !important}',
      '}',
      '@media (prefers-reduced-motion: reduce){.ra-focus-exit{transition:none}}'
    ].join('');
    (d.head || d.documentElement).appendChild(s);
  }

  var noteTimer = 0, noteEl = null;
  function note(text) {
    if (!d.body) return;
    if (!noteEl) { noteEl = d.createElement('div'); noteEl.className = 'ra-focus-note'; noteEl.setAttribute('role', 'status'); d.body.appendChild(noteEl); }
    noteEl.textContent = text;
    noteEl.style.display = 'block';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { if (noteEl) noteEl.style.display = 'none'; }, 4200);
  }

  function turnOffForSession() {
    set('sessionStorage', KEY_SESSION_OFF, '1');
    lastUserExitAt = null;
    exit();
    paintAll();
    note('Focus mode is off until you reopen this console. Turn it back on from the menu.');
  }

  /* "Exit focus mode": shown on entering full screen, then whenever the pointer nears the top. */
  function ensureExitBtn() {
    if (exitBtn || !d.body) return exitBtn;
    exitBtn = d.createElement('button');
    exitBtn.type = 'button';
    exitBtn.className = 'ra-focus-exit';
    exitBtn.setAttribute('data-focus-skip', '');
    exitBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="' + ICON.off + '"/></svg><span>Exit focus mode</span>';
    exitBtn.onclick = function () { turnOffForSession(); };
    exitBtn.hidden = true;
    d.body.appendChild(exitBtn);
    return exitBtn;
  }
  function peekExit(ms) {
    var b = ensureExitBtn();
    if (!b || b.hidden) return;
    b.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { b.classList.remove('show'); }, ms || 3500);
  }

  function onFullscreenChange() {
    var b = ensureExitBtn();
    if (fsElement()) {
      if (b) b.hidden = false;
      peekExit(4000);
    } else {
      if (b) { b.hidden = true; b.classList.remove('show'); }
      if (!selfExit) lastUserExitAt = Date.now();
      selfExit = false;
    }
    paintAll();
  }

  function onClick(e) {
    if (!e.isTrusted) return;
    var s = focusDecision(state(e.target));
    if (s.go) enter();
  }

  function onKeydown(e) {
    if (e.key !== 'Escape' || fsElement()) return;
    if (escTurnsOff({ lastUserExitAt: lastUserExitAt, now: Date.now(), overlayOpen: overlayOpen() })) turnOffForSession();
  }

  /* The menu switch, mounted by each console beside the sound switch (same shape as
   * RaSound.mountToggle): `before` is the sibling it goes in front of. */
  var ICON = {
    on: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    off: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5'
  };
  function paint(b) {
    var on = isOn();
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.setAttribute('aria-label', on ? 'Turn focus mode off' : 'Turn focus mode on');
    b.title = on ? 'Focus mode on (full screen)' : 'Focus mode off';
    b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="' + (on ? ICON.on : ICON.off) + '"/></svg>';
  }
  function paintAll() { [].forEach.call(d.querySelectorAll('[data-ra-focus]'), paint); }
  function setOn(on) {
    set('localStorage', KEY_PREF, on ? '1' : '0');
    if (on) set('sessionStorage', KEY_SESSION_OFF, null);
    paintAll();
  }
  function toggle() {
    if (isOn()) {
      setOn(false);
      exit();
      note('Focus mode is off. Turn it on again from this menu.');
      return;
    }
    setOn(true);
    var s = focusDecision(state(null));
    if (s.go) enter();
    else if (s.why === 'app-window') note('Focus mode is on. This app window is already full screen.');
    else if (s.why === 'iphone') note('Focus mode is on. On iPhone, ' + installHelp('ios', APP).charAt(0).toLowerCase() + installHelp('ios', APP).slice(1));
    else if (s.why === 'unsupported') note('Focus mode is on, but this page cannot go full screen here. ' + installHelp(browserKind(env()), APP));
  }
  function mountToggle(parent, before, cls, style) {
    if (!parent) return null;
    var b = d.createElement('button');
    b.type = 'button';
    b.setAttribute('data-ra-focus', '');
    if (cls) b.className = cls;
    if (style) b.style.cssText = style;
    b.onclick = toggle;
    paint(b);
    parent.insertBefore(b, before || null);
    return b;
  }

  /* The "open as an app" card. */
  function env() { return { ua: nav.userAgent || '', platform: nav.platform || '', maxTouchPoints: nav.maxTouchPoints || 0 }; }
  function installed() { return get('localStorage', KEY_INSTALLED) === '1'; }
  function dismissedAt() { var v = get('localStorage', KEY_DISMISSED); return v == null ? null : Number(v); }
  function closeCard() { if (card && card.parentNode) card.parentNode.removeChild(card); card = null; }
  function dismiss() { set('localStorage', KEY_DISMISSED, String(Date.now())); closeCard(); }
  function showCard() {
    if (card || !d.body || d.hidden) return;
    if (!installOffer({ appWindow: appWindow(), installed: installed(), dismissedAt: dismissedAt(), now: Date.now() })) return;
    var kind = browserKind(env());
    card = d.createElement('div');
    card.className = 'ra-install';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Open ' + APP + ' as an app');
    card.setAttribute('data-focus-skip', '');
    var img = d.createElement('img'); img.src = '/icon-192.png'; img.alt = '';
    var body = d.createElement('div');
    var t = d.createElement('b');
    t.textContent = kind === 'firefox' ? 'Full screen in Firefox' : 'Open ' + APP + ' in its own window';
    var p = d.createElement('p');
    p.textContent = deferredPrompt ? 'No address bar, no tabs: ' + APP + ' opens like an app.' : installHelp(kind, APP);
    var row = d.createElement('div'); row.className = 'ra-i-row';
    if (deferredPrompt) {
      var go = d.createElement('button'); go.type = 'button'; go.className = 'p'; go.textContent = 'Install';
      go.onclick = function () {
        var ev = deferredPrompt; deferredPrompt = null;
        if (!ev) return closeCard();
        try {
          ev.prompt();
          Promise.resolve(ev.userChoice).then(function (c) {
            if (c && c.outcome === 'accepted') { set('localStorage', KEY_INSTALLED, '1'); closeCard(); } else dismiss();
          }, dismiss);
        } catch (e) { dismiss(); }
      };
      row.appendChild(go);
    }
    var later = d.createElement('button'); later.type = 'button';
    later.textContent = deferredPrompt ? 'Not now' : 'Got it';
    later.onclick = dismiss;
    row.appendChild(later);
    body.appendChild(t); body.appendChild(p); body.appendChild(row);
    card.appendChild(img); card.appendChild(body);
    d.body.appendChild(card);
  }

  function install() {
    css();
    if (d.body && !d.querySelector('.ra-titlebar')) {
      var tb = d.createElement('div'); tb.className = 'ra-titlebar'; tb.setAttribute('aria-hidden', 'true'); tb.textContent = APP;
      d.body.insertBefore(tb, d.body.firstChild);
    }
    ensureExitBtn();
    if (appWindow()) set('localStorage', KEY_INSTALLED, '1');
    d.addEventListener('click', onClick, true);
    d.addEventListener('keydown', onKeydown, true);
    d.addEventListener('fullscreenchange', onFullscreenChange);
    d.addEventListener('webkitfullscreenchange', onFullscreenChange);
    d.addEventListener('mousemove', function (e) { if (fsElement() && e.clientY < 56) peekExit(2500); }, { passive: true });
    g.addEventListener('beforeinstallprompt', function (e) {
      // Chromium only fires this while the console is NOT installed.
      e.preventDefault();
      deferredPrompt = e;
      set('localStorage', KEY_INSTALLED, null);
      if (card) { closeCard(); showCard(); }
    });
    g.addEventListener('appinstalled', function () { set('localStorage', KEY_INSTALLED, '1'); deferredPrompt = null; closeCard(); });
    // After the welcome screen has lifted and the console has settled.
    setTimeout(showCard, 6000);
  }

  var API = { mountToggle: mountToggle, isOn: isOn, setOn: setOn, toggle: toggle, enter: enter, exit: exit, showInstall: showCard };
  for (var k in PURE) if (Object.prototype.hasOwnProperty.call(PURE, k)) API[k] = PURE[k];
  g.RaFocus = API;

  if (d.body) install();
  else d.addEventListener('DOMContentLoaded', install);
})(typeof window !== 'undefined' ? window : this);
