/* rac-preload.js — the RAW welcome, shared by every surface (UX-D).
 *
 * A 1:1 port of the reference `rac-preload.js` (RAW Welcome Preloader):
 *   First visit  the logo alone → "Hello" in twelve languages → a held
 *                "Welcome" → the word collapses, the logo returns small at
 *                centre, and a circle opens out of it onto the page.
 *   Returning    "Welcome" → logo → circle. sessionStorage 'rac.preload.seen'.
 * The hellos keep cycling until the page is ready, so the circle never opens
 * onto a blank page. Plain JS so it paints before React exists.
 *
 * What differs from the reference, and why:
 *   - Fonts are same-origin (`data-fonts`), never Google/Fontshare.
 *   - The page is never hidden behind the overlay (no `opacity:0` on the
 *     mount): Chrome's LCP ignores invisible elements (LCP-1). It is covered.
 *   - Nothing React renders is touched before React hydrates: the overlay
 *     lives in its own <rac-welcome> element (React skips an unknown tag in
 *     <body>), and <html> gets no class until the circle opens. So there is
 *     no `rac-booting` class: `#rac-pl` being in the DOM IS the boot state.
 *   - prefers-reduced-motion: no choreography at all; a still "Welcome" that
 *     lifts the moment the page is ready.
 *   - `data-wait`: readiness also needs `racPreload.ready()` from the app.
 *
 * Usage, first element in <body>:
 *   <script src="/rac-preload.js" data-mount=".stage" data-wait="1"
 *           data-logo="/logo/raw-logo@3x.png" data-fonts="/fonts/"
 *           data-surfaces="/store /admin"></script>
 * `data-surfaces` limits it to those path prefixes; absent = every page.
 * API: racPreload.ready() · racPreload.replay({full}).
 */
(function () {
  var W = window, D = document;
  var script = D.currentScript || {};
  var d = script.dataset || {};
  var DEF = { mount: d.mount || '.stage', logo: d.logo || '/logo/raw-logo@3x.png' };
  var FONTS = d.fonts == null ? '/fonts/' : d.fonts;
  var SEEN = 'rac.preload.seen';
  var appReady = d.wait !== '1';

  var HELLOS = ['Hello', 'नमस्ते', 'Bonjour', 'Hola', 'Ciao', 'こんにちは', 'مرحبا', 'Olá', 'Hallo', '你好', '안녕하세요', 'Привет'];

  var DISPLAY = '"Cabinet Grotesk","Helvetica Neue",Arial,sans-serif';
  var SANS = 'Outfit,"Helvetica Neue",-apple-system,Arial,sans-serif';
  var MONO = '"JetBrains Mono",ui-monospace,Menlo,monospace';
  var EASE = 'cubic-bezier(.2,.8,.2,1)';

  var CSS =
    'rac-welcome{display:contents}' +
    '#rac-pl{--pl-bg:#EFEFED;--pl-fg:#0A0A0A;--pl-dim:#6E6E6E;--pl-navy:rgb(0,42,85);position:fixed;inset:0;z-index:9999;background:var(--pl-bg);color:var(--pl-fg);overflow:hidden}' +
    '#rac-pl .pl-c{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}' +
    '#rac-pl .pl-intro{width:clamp(180px,24vw,300px);height:auto;opacity:0;transform:scale(.96);filter:blur(6px);transition:opacity .8s ease,transform 1.1s ' + EASE + ',filter .8s ease}' +
    '#rac-pl .pl-intro.on{opacity:1;transform:none;filter:none}' +
    '#rac-pl .pl-intro.off{opacity:0;transform:scale(1.02);filter:blur(4px);transition-duration:.45s,.6s,.45s}' +
    '#rac-pl .pl-w{font:700 clamp(52px,9vw,108px)/1 ' + DISPLAY + ';letter-spacing:-.035em;white-space:nowrap;opacity:0;transform:translateY(6px);filter:blur(6px);' +
      'transition:opacity .26s ease,transform .38s ' + EASE + ',filter .3s ease}' +
    '#rac-pl .pl-w.on{opacity:1;transform:none;filter:none}' +
    '#rac-pl .pl-w.first{transition-duration:.7s,.9s,.7s}' +
    '#rac-pl .pl-wel{display:flex;flex-direction:column;align-items:center;gap:22px;opacity:0;transform:translateY(10px);filter:blur(8px);' +
      'transition:opacity .7s ease,transform .9s ' + EASE + ',filter .7s ease}' +
    '#rac-pl .pl-wel.on{opacity:1;transform:none;filter:none}' +
    '#rac-pl .pl-wel.collapse{opacity:0;transform:scale(.55);filter:blur(10px);transition:opacity .38s ease,transform .5s cubic-bezier(.6,0,.4,1),filter .4s ease}' +
    '#rac-pl .pl-wel b{font:300 clamp(46px,7.4vw,88px)/1 ' + SANS + ';letter-spacing:-.035em}' +
    '#rac-pl .pl-wel span{font:500 10.5px/1 ' + MONO + ';letter-spacing:.3em;text-transform:uppercase;color:var(--pl-dim)}' +
    '#rac-pl .pl-ring{position:absolute;left:50%;top:50%;width:0;height:0;border-radius:50%;border:1px solid var(--pl-navy);transform:translate(-50%,-50%);opacity:0;pointer-events:none}' +
    /* the logo the circle opens from sits ABOVE the masked overlay, so the hole doesn't cut it */
    '#rac-pl-mark{position:fixed;left:50%;top:50%;z-index:10000;width:clamp(96px,11vw,132px);height:auto;pointer-events:none;transform:translate(-50%,-50%) scale(.6);opacity:0;' +
      'transition:transform .5s cubic-bezier(.3,1.35,.5,1),opacity .35s ease}' +
    '#rac-pl-mark.on{transform:translate(-50%,-50%) scale(1);opacity:1}' +
    '@keyframes racPlReveal{from{transform:scale(1.045)}to{transform:none}}' +
    '@media (prefers-reduced-motion:reduce){#rac-pl *,#rac-pl-mark{transition:none!important}}';

  /* The three faces the welcome draws, spelled out (not templated) so every
     family name is a literal a font audit can read, quoted as ALEMBIC's own
     app/fonts/*.css quote them. Same files the pages use. */
  function fontCss(dir) {
    if (!dir) return '';
    var tail = ') format("woff2");font-style:normal;font-display:swap}';
    return '@font-face{font-family:\'Cabinet Grotesk\';font-weight:100 900;src:url(' + dir + 'cabinet-grotesk-variable.woff2' + tail +
      '@font-face{font-family:Outfit;font-weight:300;src:url(' + dir + 'outfit-300-latin.woff2' + tail +
      '@font-face{font-family:\'JetBrains Mono\';font-weight:500;src:url(' + dir + 'jetbrains-mono-500-latin.woff2' + tail;
  }

  function mountCss(sel) {
    return 'html.rac-revealing ' + sel + '{animation:racPlReveal 1.05s cubic-bezier(.65,0,.25,1) both;transform-origin:50% 50vh}' +
      '@media (prefers-reduced-motion:reduce){html.rac-revealing ' + sel + '{animation-duration:.01s}}';
  }

  function css(sel, logo) {
    var s = D.getElementById('rac-pl-css');
    if (!s) {
      s = D.createElement('style'); s.id = 'rac-pl-css'; D.head.appendChild(s);
      var p = D.createElement('link');
      p.rel = 'preload'; p.as = 'image'; p.href = logo;
      D.head.appendChild(p);
    }
    s.textContent = fontCss(FONTS) + CSS + mountCss(sel);
  }

  function mounted(sel) {
    var m = D.querySelector(sel);
    if (!m) return D.readyState === 'complete';
    return m.textContent.trim().length > 0 || m.querySelector('img,svg,canvas,video') !== null;
  }

  function seen() { try { return W.sessionStorage.getItem(SEEN) === '1'; } catch (e) { return false; } }
  function markSeen() { try { W.sessionStorage.setItem(SEEN, '1'); } catch (e) { /* not stored: the next load is a first visit again */ } }
  function reducedMotion() { try { return !!(W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }

  var active = null;

  function start(opts) {
    opts = opts || {};
    var sel = opts.mount || DEF.mount, logo = opts.logo || DEF.logo;
    var reduced = reducedMotion();
    var full = opts.full != null ? opts.full : !seen();
    if (active) active.kill();
    css(sel, logo);

    var root = D.documentElement;
    root.classList.remove('rac-revealing');

    var pl = D.createElement('div');
    pl.id = 'rac-pl';
    pl.setAttribute('role', 'status');
    pl.setAttribute('aria-label', 'Welcome to RAW Aromachem. Loading.');
    pl.innerHTML =
      '<div class="pl-c"><img class="pl-intro" alt="" src="' + logo + '"></div>' +
      '<div class="pl-c"><div class="pl-w" aria-hidden="true"></div></div>' +
      '<div class="pl-c"><div class="pl-wel" aria-hidden="true"><b>Welcome</b><span>RAW Aromachem</span></div></div>' +
      '<div class="pl-ring"></div>';
    var mark = D.createElement('img');
    mark.id = 'rac-pl-mark'; mark.alt = ''; mark.src = logo;
    var host = D.createElement('rac-welcome');
    host.appendChild(pl); host.appendChild(mark);
    (D.body || root).appendChild(host);

    var intro = pl.querySelector('.pl-intro'), word = pl.querySelector('.pl-w'),
        wel = pl.querySelector('.pl-wel'), ring = pl.querySelector('.pl-ring');
    var timers = [], raf = 0, ready = false, killed = false;
    var T = function (fn, ms) { timers.push(setTimeout(fn, ms)); };
    var check = function () { if (appReady && mounted(sel)) { ready = true; clearInterval(poll); } };

    var poll = setInterval(check, 90);
    T(function () { ready = true; }, 10000); // failsafe: never trap the page

    // ── 0 · the logo alone ──
    function logoIntro(done) {
      intro.classList.add('on');
      T(function () { intro.classList.add('off'); }, 1700);
      T(done, 2150);
    }

    // ── 1 · hellos, cycling until the page is ready ──
    function hellos(done) {
      var i = 0;
      function next() {
        if (killed) return;
        if (i >= HELLOS.length && ready) { word.classList.remove('on'); T(done, 280); return; }
        var w = HELLOS[i % HELLOS.length];
        word.classList.remove('on');
        T(function () {
          word.textContent = w;
          word.classList.toggle('first', i === 0);
          void word.offsetWidth;
          word.classList.add('on');
          var hold = i === 0 ? 1050 : 330;
          i++;
          T(next, hold);
        }, i === 0 ? 60 : 200);
      }
      next();
    }

    // ── 2 · welcome, held until ready ──
    function welcome() {
      if (killed) return;
      wel.classList.add('on');
      var minHold = full ? 1150 : 1350, t = performance.now();
      (function wait() {
        if (killed) return;
        if (ready && performance.now() - t >= minHold) return morph();
        T(wait, 80);
      })();
    }

    // ── 3 · collapse; the logo returns small at centre ──
    function morph() {
      markSeen();
      wel.classList.add('collapse');
      T(function () { mark.classList.add('on'); }, 260);
      T(open, 1100);
    }

    // ── 4 · a circle opens out of the logo onto the page ──
    function open() {
      if (killed) return;
      root.classList.add('rac-revealing');
      mark.style.transition = 'none';

      var r0 = 4, r1 = Math.hypot(W.innerWidth, W.innerHeight) / 2 + 40, dur = 1150, t0 = performance.now();
      var ease = function (x) { return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
      function frame(now) {
        if (killed) return;
        var p = Math.min(1, (now - t0) / dur), r = r0 + (r1 - r0) * ease(p);
        var m = 'radial-gradient(circle at 50% 50%,transparent ' + r.toFixed(1) + 'px,#000 ' + (r + .6).toFixed(1) + 'px)';
        pl.style.webkitMaskImage = m; pl.style.maskImage = m;
        var dia = (r * 2 + 1).toFixed(1) + 'px';
        ring.style.width = dia; ring.style.height = dia;
        ring.style.opacity = (p < .06 ? p / .06 : Math.max(0, 1 - (p - .06) / .7)) * .5;
        // the logo lifts and dissolves as the circle opens out of it
        var q = Math.min(1, p / .45);
        mark.style.opacity = (1 - q).toFixed(3);
        mark.style.transform = 'translate(-50%,-50%) scale(' + (1 + .35 * q).toFixed(3) + ')';
        mark.style.filter = 'blur(' + (q * 4).toFixed(2) + 'px)';
        if (p < 1) raf = requestAnimationFrame(frame);
        else finish();
      }
      raf = requestAnimationFrame(frame);
    }

    // ── reduced motion: a still welcome, lifted the moment the page is ready ──
    function still() {
      wel.classList.add('on');
      (function wait() {
        if (killed) return;
        if (!ready) { T(wait, 50); return; }
        markSeen();
        finish();
      })();
    }

    function finish() {
      timers.forEach(clearTimeout); timers = []; clearInterval(poll);
      host.remove();
      setTimeout(function () { if (!active) root.classList.remove('rac-revealing'); }, 150);
      active = null;
    }

    function kill() {
      killed = true;
      cancelAnimationFrame(raf); clearInterval(poll); timers.forEach(clearTimeout);
      host.remove(); root.classList.remove('rac-revealing'); active = null;
    }

    T(kill, 18000); // absolute failsafe
    active = { kill: kill, check: check };

    if (reduced) { still(); return; }
    var begin = function () {
      if (killed) return;
      if (full) logoIntro(function () { hellos(welcome); }); else T(welcome, 120);
    };
    // let the display face arrive before the first word, but never wait long for it.
    // Ask for the three faces now: a face is otherwise only fetched when a word first
    // uses it, which is after the logo intro -- and the first hellos drew in the fallback.
    var go = false, once = function () { if (!go) { go = true; begin(); } };
    try { ['700 1em "Cabinet Grotesk"', '300 1em Outfit', '500 1em "JetBrains Mono"'].forEach(function (f) { D.fonts.load(f); }); } catch (e) { /* no FontFace API: the swap covers it */ }
    if (D.fonts && D.fonts.ready) D.fonts.ready.then(once);
    T(once, 450);
  }

  function onSurface() {
    var s = (d.surfaces || '').split(/\s+/).filter(Boolean);
    if (!s.length) return true;
    var p = W.location.pathname;
    return s.some(function (x) { return p === x || p.indexOf(x + '/') === 0; });
  }

  W.racPreload = {
    replay: start,
    /* The app says it is there. Idempotent, and safe before or after start. */
    ready: function () { appReady = true; if (active) active.check(); },
  };

  if (W.__racPreloadRan || !onSurface()) return;
  W.__racPreloadRan = true;
  if (D.body) start(); else D.addEventListener('DOMContentLoaded', function () { start(); });
})();
