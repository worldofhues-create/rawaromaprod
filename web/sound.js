/* sound.js: click, notification and alert sounds. Web Audio only, no asset files.
 *
 * A vanilla port of ALEMBIC's apps/web/lib/console/sound.js, same voices and same API,
 * published as window.RaSound. The voices are the reference kit's (rac-console.jsx in the
 * Admin/Agent prototypes) note for note, plus `notify`, a soft two-note chime for things that
 * arrive rather than things you did.
 *
 * Rules:
 *   - no AudioContext until the first user gesture, and none at all while muted;
 *   - one persisted switch (localStorage rac.console.sound.v1), default on in consoles;
 *   - a hidden tab is silent;
 *   - prefers-reduced-motion silences the decorative voices (click, tick, toggle, whoosh,
 *     close); the ones that carry news (notify, alert, success) still play;
 *   - notify/alert/success are throttled, so a burst is one sound.
 *
 * Identical copies live in web/, web-platform/ and web-vault/ because each console is served
 * from its own root. Edit one, copy it to the other two.
 */
(function (g) {
  'use strict';
  if (g.RaSound) return;
  // name: [notes [[hz, at, glideTo?]], seconds, wave, peak, attack?]
  var V = {
    click:   [[[1180, 0]], .05, 'sine', .035],
    tick:    [[[2100, 0]], .022, 'sine', .014],
    toggle:  [[[760, 0], [1140, .045]], .06, 'sine', .04],
    success: [[[720, 0], [960, .07], [1240, .14]], .1, 'sine', .045],
    alert:   [[[560, 0], [420, .11]], .13, 'triangle', .05],
    whoosh:  [[[300, 0], [520, .04], [680, .09]], .1, 'sine', .028],
    close:   [[[680, 0], [420, .06]], .09, 'sine', .03],
    notify:  [[[988, 0], [1319, .1]], .18, 'sine', .03],
    open:    [[[520, 0, 880]], .28, 'sine', .06, .04],
    shut:    [[[720, 0, 360]], .26, 'sine', .05, .03]
  };
  var NEWS = { notify: 1, alert: 1, success: 1 };
  var surface = 'console', ctx = null, armed = false, last = {}, installed = false;

  function soundKey(s) { return 'rac.' + (s || surface) + '.sound.v1'; }
  function soundOn() {
    try { var v = g.localStorage.getItem(soundKey()); if (v !== null) return v === '1'; } catch (e) { /* storage off */ }
    return surface !== 'store';
  }
  function setSoundOn(on) {
    on = !!on;
    try { g.localStorage.setItem(soundKey(), on ? '1' : '0'); } catch (e) { /* storage off */ }
    try { g.dispatchEvent(new CustomEvent('rac:sound', { detail: { on: on } })); } catch (e) { /* old browser */ }
    if (g.document) [].forEach.call(g.document.querySelectorAll('[data-ra-sound]'), paint);
    return on;
  }
  function arm() {
    armed = true;
    if (!soundOn()) return;
    var C = g.AudioContext || g.webkitAudioContext;
    try {
      if (!ctx && C) ctx = new C();
      if (ctx && ctx.state === 'suspended') ctx.resume();
    } catch (e) { /* no audio on this device */ }
  }
  function play(name) {
    var v = V[name], now = Date.now();
    if (!v || !armed || !soundOn() || (g.document && g.document.hidden)) return false;
    if (!NEWS[name] && g.matchMedia && g.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    if (now - (last[name] || 0) < (NEWS[name] ? 1200 : 30)) return false;
    arm();
    var c = ctx;
    if (!c) return false;
    last[name] = now;
    var dur = v[1], type = v[2], peak = v[3], atk = v[4] || .012, t0 = c.currentTime;
    v[0].forEach(function (nt) {
      var o = c.createOscillator(), n = c.createGain(), t = t0 + nt[1];
      o.type = type; o.connect(n); n.connect(c.destination);
      o.frequency.setValueAtTime(nt[0], t);
      if (nt[2]) o.frequency.exponentialRampToValueAtTime(nt[2], t + dur * .65);
      n.gain.setValueAtTime(.0001, t);
      n.gain.exponentialRampToValueAtTime(peak, t + atk);
      n.gain.exponentialRampToValueAtTime(.0001, t + dur);
      o.start(t); o.stop(t + dur + .02);
    });
    return true;
  }
  var SOUND = {};
  Object.keys(V).forEach(function (n) { SOUND[n] = function () { return play(n); }; });

  // A toast or note arrived: alert if it reports a failure, otherwise notify.
  var FAIL = /\b(not (saved|done|sent|created|started|selected|resolved)|did not|could not|couldn.t|refused|failed|error)\b/i;
  function cue(msg) {
    var t = typeof msg === 'string' ? msg : (msg && (msg.text || msg.message)) || '';
    if ((msg && msg.ok === false) || FAIL.test(t)) return play('alert');
    return !!t && play('notify');
  }

  // Once per document: arm on the first gesture, and tap/tick delegation like the reference.
  function installSound(where) {
    surface = where === 'store' ? 'store' : 'console';
    var d = g.document;
    if (!d || installed) return;
    installed = true;
    d.addEventListener('pointerdown', arm, true);
    d.addEventListener('keydown', arm, true);
    if (surface === 'store') return;
    d.addEventListener('pointerdown', function (e) {
      var t = e.target && e.target.closest && e.target.closest('button, .ri, .pt, .qb, .xp, [role="button"]');
      if (t && !t.disabled && t.getAttribute('aria-disabled') !== 'true') {
        play(t.classList.contains('gbtn') && t.classList.contains('acc') ? 'success' : 'click');
      }
    }, true);
    var over = null;
    d.addEventListener('pointerover', function (e) {
      var t = e.target && e.target.closest && e.target.closest('.ri, .pt, .qb');
      if (t && t !== over) { over = t; play('tick'); }
    }, true);
  }

  // The mute switch, as a button. `before` is the sibling it goes in front of; `cls`/`style`
  // let each console match the control next to it.
  var ICON = {
    on: 'M4 9.5h3l4.5-3.6v12.2L7 14.5H4zM15.6 9a4.2 4.2 0 0 1 0 6M18.2 6.6a7.6 7.6 0 0 1 0 10.8',
    off: 'M4 9.5h3l4.5-3.6v12.2L7 14.5H4zM16 9.6l4.4 4.8M20.4 9.6 16 14.4'
  };
  function paint(b) {
    var on = soundOn();
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.setAttribute('aria-label', on ? 'Mute sounds' : 'Unmute sounds');
    b.title = on ? 'Sound on' : 'Muted';
    b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="' + (on ? ICON.on : ICON.off) + '"/></svg>';
  }
  function mountToggle(parent, before, cls, style) {
    if (!parent) return null;
    var b = g.document.createElement('button');
    b.type = 'button';
    b.setAttribute('data-ra-sound', '');
    if (cls) b.className = cls;
    if (style) b.style.cssText = style;
    b.onclick = function () { setSoundOn(!soundOn()); };
    paint(b);
    parent.insertBefore(b, before || null);
    return b;
  }

  g.RaSound = {
    VOICES: Object.keys(V), SOUND: SOUND, soundKey: soundKey, soundOn: soundOn, setSoundOn: setSoundOn,
    arm: arm, play: play, cue: cue, installSound: installSound, mountToggle: mountToggle
  };
  installSound('console');
})(window);
