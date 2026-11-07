/* RAW AROMA — the one scan field (web/scan-input.js), SCAN-2. Owner: "we need both QR and barcode."
 *
 * Every scan field on the floor (picker, verifier, mixer, packing, logistics, putaway, lot hold and
 * recall) is a plain <input data-scan> in its view; this file makes it a scan field. It reads three
 * sources and treats them the same:
 *   1. a keyboard-wedge scanner of either symbology. Bursts of keys under BURST_MS apart are a
 *      scanner; its Enter, CR or Tab suffix submits the field (a Tab would otherwise move focus off
 *      the kiosk's field), and an AIM prefix (]C0 Code 128, ]Q1 QR) is stripped.
 *   2. the camera (kiosk tablets, phones) through the native BarcodeDetector API: QR, Code 128 and
 *      the common 1D/2D formats this device supports. No library: where the browser has no detector,
 *      or there is no camera, or the page is not HTTPS, the field says so and typing still works.
 *   3. typing.
 * The value the view reads is always the bare payload. Nothing here decides what a code means: the
 * view sends it to its own endpoint, which resolves it under the scanner's permissions (the server
 * normalises again, backend/api/src/floor/scan-code.ts, in case a scanner typed into another input).
 *
 * UMD: the page (window.RaScan) and the tests (vm) load this one file. The DOM half runs only in a
 * browser.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RaScan = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function (root) {
  'use strict';

  var FORMATS = ['qr_code', 'code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar', 'data_matrix', 'pdf417', 'aztec'];
  var AIM = { C: 'code_128', Q: 'qr_code', E: 'ean_upc', d: 'data_matrix', A: 'code_39', G: 'code_93', I: 'itf', F: 'codabar', L: 'pdf417', z: 'aztec' };
  var BURST_MS = 35, BURST_MIN = 4;

  /** raw -> { code, symbology }: control characters and the AIM prefix off, trimmed. */
  function normalize(raw) {
    var s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, '').trim(), sym = null;
    var m = /^\]([A-Za-z])[0-9A-Za-z]/.exec(s);
    if (m) { sym = AIM[m[1]] || 'aim_' + m[1]; s = s.slice(3).trim(); }
    return { code: s, symbology: sym };
  }
  function pickFormats(supported) { return FORMATS.filter(function (f) { return (supported || []).indexOf(f) >= 0; }); }

  /** Keystroke timing: a scanner types a whole code in a few ms per key; a person does not. */
  function burst() {
    var times = [];
    return {
      key: function (t) { if (times.length && t - times[times.length - 1] > 250) times = []; times.push(t); },
      isScanner: function () {
        if (times.length < BURST_MIN) return false;
        for (var i = 1; i < times.length; i++) if (times[i] - times[i - 1] > BURST_MS) return false;
        return true;
      },
      reset: function () { times = []; }
    };
  }

  var api = { FORMATS: FORMATS, normalize: normalize, pickFormats: pickFormats, burst: burst, BURST_MS: BURST_MS };
  if (typeof document === 'undefined') return api;

  /* ── the DOM half ─────────────────────────────────────────────────────────────────────── */
  function supported() { return typeof root.BarcodeDetector === 'function'; }
  /** Why the camera cannot scan here, in words a floor worker can act on; null if it can. */
  function cameraBlocker() {
    if (!root.isSecureContext) return 'Camera scanning needs the secure (https) address. Use the scanner or type the code.';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'This browser cannot use the camera. Use the scanner or type the code.';
    if (!supported()) return 'This browser cannot read barcodes from the camera (no BarcodeDetector; Chrome on Android does). Use the scanner or type the code.';
    return null;
  }

  function nextScanField(input) {
    if (!input.form) return null;
    var all = [].slice.call(input.form.querySelectorAll('input[data-scan]')), i = all.indexOf(input);
    for (var k = i + 1; k < all.length; k++) if (!String(all[k].value || '').trim() && !all[k].disabled && all[k].offsetParent !== null) return all[k];
    return null;
  }
  function submit(input, code, source) {
    input.value = code;
    input.setAttribute('data-scan-source', source);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    var cb = input.__raScanCb;
    if (cb) { cb(code, source); return; }
    var f = input.form;
    if (f) { if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); }
  }

  function enhance(input) {
    if (!input || input.__raScan) return;
    input.__raScan = true;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'characters');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('enterkeyhint', 'go');
    var b = burst();
    input.addEventListener('keydown', function (e) {
      var now = (root.performance && performance.now()) || Date.now();
      if (e.key === 'Enter' || e.key === 'Tab') {
        var wasScanner = b.isScanner(); b.reset();
        var n = normalize(input.value);
        if (e.key === 'Tab' && !wasScanner) return; // a person tabbing on
        if (!n.code) return;
        // Only a scanner's Tab is swallowed; Enter keeps its normal meaning, cleaned value first.
        if (e.key === 'Tab') e.preventDefault();
        input.value = n.code;
        input.setAttribute('data-scan-source', wasScanner ? 'wedge' : 'typed');
        if (n.symbology) input.setAttribute('data-scan-symbology', n.symbology);
        // SCAN-13: a form with several scan fields (bin, then lot) is filled in order: the suffix moves
        // to the next empty scan field, and only the last one submits. Submitting on the bin's suffix
        // sent the line with no lot, and the picker had to scan the bin again.
        var nextEmpty = nextScanField(input);
        if (nextEmpty) { e.preventDefault(); nextEmpty.focus(); return; }
        if (e.key === 'Tab' || input.__raScanCb) { e.preventDefault(); submit(input, n.code, wasScanner ? 'wedge' : 'typed'); }
        return;
      }
      if (e.key && e.key.length === 1) b.key(now);
    });
    // Pasted or IME text, and the value left behind when the form submits some other way.
    input.addEventListener('change', function () { var n = normalize(input.value); if (n.code !== input.value) input.value = n.code; });
    if (input.form && !input.form.__raScan) {
      input.form.__raScan = true;
      input.form.addEventListener('submit', function () {
        [].forEach.call(input.form.querySelectorAll('input[data-scan]'), function (i) { var n = normalize(i.value); if (n.code !== i.value) i.value = n.code; });
      }, true);
    }
    var cam = document.createElement('button');
    cam.type = 'button';
    cam.className = 'btn sm ra-scan-cam';
    cam.setAttribute('aria-label', 'Scan with the camera');
    cam.setAttribute('data-scan-camera', input.id || '');
    cam.textContent = 'Camera';
    cam.style.cssText = 'min-height:44px;flex:none';
    cam.onclick = function () { openCamera(input); };
    var wrap = document.createElement('span');
    wrap.className = 'ra-scan';
    wrap.style.cssText = 'display:flex;gap:6px;align-items:stretch;min-width:0;width:100%';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.style.flex = '1'; input.style.minWidth = '0';
    wrap.appendChild(cam);
  }

  var active = null;
  function closeCamera() {
    if (!active) return;
    active.stop = true;
    if (active.stream) active.stream.getTracks().forEach(function (t) { t.stop(); });
    if (active.el && active.el.parentNode) active.el.parentNode.removeChild(active.el);
    var back = active.input; active = null;
    if (back) try { back.focus(); } catch (e) { /* gone */ }
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function overlay(inner) {
    var el = document.createElement('div');
    el.className = 'ra-scan-overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Scan with the camera');
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.86);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:16px;font:16px/1.4 system-ui,sans-serif;text-align:center';
    el.innerHTML = inner + '<button type="button" class="btn" data-scan-close style="min-height:52px;min-width:160px">Close</button>';
    el.querySelector('[data-scan-close]').onclick = closeCamera;
    el.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeCamera(); });
    document.body.appendChild(el);
    el.querySelector('[data-scan-close]').focus();
    return el;
  }

  async function openCamera(input) {
    closeCamera();
    var why = cameraBlocker();
    if (why) { active = { input: input, el: overlay('<p data-scan-fallback style="max-width:420px;margin:0">' + esc(why) + '</p>') }; return; }
    active = { input: input };
    active.el = overlay('<p data-scan-prompt style="max-width:420px;margin:0">Your browser will ask to use the camera. Allow it, then hold the label\'s QR or barcode inside the frame.</p>' +
      '<video data-scan-video playsinline muted style="width:min(92vw,520px);max-height:60vh;border-radius:12px;background:#000;object-fit:cover"></video>' +
      '<p data-scan-status style="margin:0;min-height:1.4em" aria-live="polite"></p>');
    var me = active, status = me.el.querySelector('[data-scan-status]'), video = me.el.querySelector('[data-scan-video]');
    var formats;
    try { formats = pickFormats(await root.BarcodeDetector.getSupportedFormats()); } catch (e) { formats = []; }
    if (!formats.length) { status.textContent = 'This device reads no barcode formats from the camera. Use the scanner or type the code.'; return; }
    try {
      me.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (e) {
      if (me !== active) return;
      status.textContent = e && e.name === 'NotAllowedError'
        ? 'Camera permission was refused. Allow the camera for this site in the browser settings, or use the scanner or type the code.'
        : 'No camera could be opened (' + (e && e.name || 'error') + '). Use the scanner or type the code.';
      return;
    }
    if (me !== active) { me.stream.getTracks().forEach(function (t) { t.stop(); }); return; }
    video.srcObject = me.stream;
    try { await video.play(); } catch (e) { /* autoplay with muted is allowed; keep trying to detect */ }
    status.textContent = 'Looking for a QR or barcode…';
    var detector = new root.BarcodeDetector({ formats: formats });
    (async function loop() {
      while (!me.stop) {
        try {
          var found = await detector.detect(video);
          if (found && found.length) {
            var n = normalize(found[0].rawValue);
            if (n.code) {
              input.setAttribute('data-scan-symbology', found[0].format || '');
              closeCamera();
              submit(input, n.code, 'camera');
              return;
            }
          }
        } catch (e) { /* a frame not ready yet */ }
        await new Promise(function (r) { setTimeout(r, 120); });
      }
    })();
  }

  function enhanceAll(scope) { [].forEach.call((scope || document).querySelectorAll('input[data-scan]'), enhance); }
  /** For a field that is not in a form: fn(code, source) instead of a submit. */
  function onScan(input, fn) { enhance(input); input.__raScanCb = fn; }

  if (typeof MutationObserver === 'function') {
    var start = function () {
      enhanceAll(document);
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) for (var j = 0; j < muts[i].addedNodes.length; j++) {
          var nd = muts[i].addedNodes[j];
          if (nd.nodeType === 1) { if (nd.matches && nd.matches('input[data-scan]')) enhance(nd); else if (nd.querySelectorAll) enhanceAll(nd); }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  }

  api.enhance = enhance; api.enhanceAll = enhanceAll; api.onScan = onScan; api.openCamera = openCamera; api.closeCamera = closeCamera;
  api.cameraBlocker = cameraBlocker; api.supported = supported;
  return api;
});
