/* RAW AROMA — one label template definition, many printers (web/label-render.js), lane pf-c,
 * production-floor plan section 2 and 12.4.
 *
 * A label is defined ONCE, as a template in millimetres:
 *   { v: 1, size, w, h, reprint, elements: [
 *       { t: 'text',    x, y, w, h, s, b }      h = cap height in mm, b = bold
 *       { t: 'code128', x, y, w, h, d }         Code 128 (set B)
 *       { t: 'line',    x, y, w, h }            a filled rule
 *   ] }
 * and rendered to the printer's own language:
 *   zpl     Zebra (and ZPL emulation on TSC, Honeywell, Godex, TVS)
 *   tspl    TSC TSPL/TSPL2
 *   epl     Eltron/Zebra EPL2
 *   escpos  receipt printers (Epson TM-T82, TVS RP 3160), base64 bytes
 *   pdf     any office printer, base64 bytes
 *   html    the browser fallback, so the floor never stops when the agent is down
 *
 * The server builds the template (build) and stores it on the print job; the print agent
 * (tools/print-agent) and this page both render that same stored template. A reprint is marked
 * REPRINT in every language, even if the template's own banner was dropped.
 *
 * Pure: no DOM, no network. UMD so the page (window.RaLabel), the agent and the tests (require)
 * load this one file.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RaLabel = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  /** Plan 12.4 label sizes, mm. 62 mm is continuous: its length follows the content. */
  var SIZES = {
    '38x25': { w: 38, h: 25, name: '38 × 25 mm (vials, 10 ml)' },
    '50x25': { w: 50, h: 25, name: '50 × 25 mm (vials, sample tubes)' },
    '75x50': { w: 75, h: 50, name: '75 × 50 mm (100 ml - 1 kg, hand-off)' },
    '100x50': { w: 100, h: 50, name: '100 × 50 mm (raw lot, bin, rack)' },
    '100x100': { w: 100, h: 100, name: '100 × 100 mm (drums, carton contents)' },
    '100x150': { w: 100, h: 150, name: '100 × 150 mm / 4×6" (carton, courier)' },
    '62mm': { w: 62, h: null, continuous: true, name: '62 mm continuous (Brother)' },
    'a4': { w: 210, h: 297, name: 'A4 sheet (office printer)' }
  };
  var LANGUAGES = ['zpl', 'tspl', 'epl', 'escpos', 'pdf', 'html'];

  /* Code 128 bar/space widths, values 0..106 (106 = stop). */
  var CODE128 = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 ' +
    '123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 ' +
    '131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 ' +
    '213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
    '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 ' +
    '421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112').split(' ');

  /** Set-B values with start, check and stop. Characters outside ASCII 32..126 become '?'. */
  function code128Values(data) {
    var vals = [104];
    var s = String(data);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      vals.push((c >= 32 && c <= 126 ? c : 63) - 32);
    }
    var sum = 104;
    for (var j = 1; j < vals.length; j++) sum += j * vals[j];
    vals.push(sum % 103);
    vals.push(106);
    return vals;
  }
  /** Bars as [startModule, widthModules] runs, plus the total width in modules (no quiet zone). */
  function code128Bars(data) {
    var vals = code128Values(data), bars = [], pos = 0;
    vals.forEach(function (v) {
      var p = CODE128[v];
      for (var k = 0; k < p.length; k++) {
        var w = Number(p[k]);
        if (k % 2 === 0) bars.push([pos, w]);
        pos += w;
      }
    });
    return { bars: bars, modules: pos };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function r2(v) { return Math.round(v * 100) / 100; }
  function fit(s, widthMm, hMm) {
    var max = Math.max(3, Math.floor(widthMm / (hMm * 0.62)));
    s = String(s == null ? '' : s);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  /**
   * content: { brand?, title, lines: [[label, value]...], code?, footer?, reprint? }
   * Returns the template. Nothing in it is invented: it carries only what the caller passed.
   */
  function build(content, size) {
    var S = SIZES[size];
    if (!S) throw new Error('Unknown label size "' + size + '". Sizes: ' + Object.keys(SIZES).join(', '));
    var c = content || {};
    var lines = (c.lines || []).filter(function (l) { return l && l[1] !== undefined && l[1] !== null && String(l[1]) !== ''; });
    var W = S.w, m = W <= 50 ? 1.2 : W <= 75 ? 2 : 3;
    var units = (c.reprint ? 1.2 : 0) + (c.brand ? 0.9 : 0) + (c.title ? 1.4 : 0) + lines.length + (c.footer ? 0.8 : 0) + (c.code ? 2.6 : 0);
    var pitchK = 1.25;
    var fh = S.continuous ? 3.2 : clamp((S.h - 2 * m) / Math.max(units, 1) / pitchK, 1.4, 7);
    var tw = W - 2 * m, y = m, els = [];
    function text(s, h, bold) {
      els.push({ t: 'text', x: m, y: r2(y), w: r2(tw), h: r2(h), s: fit(s, tw, h), b: !!bold });
      y += h * pitchK;
    }
    if (c.reprint) text('REPRINT', fh * 1.2, true);
    if (c.brand) text(c.brand, fh * 0.9, true);
    if (c.title) text(c.title, fh * 1.4, true);
    lines.forEach(function (l) { text(l[0] + ': ' + l[1], fh, false); });
    if (c.footer) text(c.footer, fh * 0.8, false);
    if (c.code) {
      var bh = fh * 2.2;
      if (!S.continuous) bh = Math.max(1, Math.min(bh, S.h - m - y));
      els.push({ t: 'code128', x: m, y: r2(y), w: r2(tw), h: r2(bh), d: String(c.code) });
      y += bh;
    }
    var H = S.continuous ? r2(y + m) : S.h;
    return { v: 1, size: size, w: W, h: H, reprint: !!c.reprint, elements: els };
  }

  /** A reprint always says so, even if a stored template lost its banner. */
  function withReprint(t) {
    var els = (t.elements || []).slice();
    if (t.reprint && !els.some(function (e) { return e.t === 'text' && e.s === 'REPRINT'; })) {
      els.unshift({ t: 'text', x: 1, y: 0.5, w: t.w - 2, h: 2.5, s: 'REPRINT', b: true });
    }
    return els;
  }

  /* ── printer languages ──────────────────────────────────────────────────────────────── */
  function zplSafe(s) { return String(s).replace(/[\^~\\]/g, ' '); }
  function quoteSafe(s, esc) { return String(s).replace(/[\r\n]/g, ' ').replace(/"/g, esc); }

  function zpl(t, o) {
    var dpmm = Math.round((o.dpi || 203) / 25.4), d = function (v) { return Math.round(v * dpmm); };
    var out = ['^XA', '^CI28', '^PW' + d(t.w), '^LL' + d(t.h), '^LH0,0'];
    withReprint(t).forEach(function (e) {
      if (e.t === 'text') out.push('^FO' + d(e.x) + ',' + d(e.y) + '^A0N,' + d(e.h * 1.35) + ',' + d(e.h * (e.b ? 1.3 : 1.15)) + '^FD' + zplSafe(e.s) + '^FS');
      else if (e.t === 'code128') {
        var mw = clamp(Math.floor(d(e.w) / code128Bars(e.d).modules), 1, 10);
        out.push('^FO' + d(e.x) + ',' + d(e.y) + '^BY' + mw + '^BCN,' + d(e.h) + ',N,N,N^FD' + zplSafe(e.d) + '^FS');
      } else if (e.t === 'line') out.push('^FO' + d(e.x) + ',' + d(e.y) + '^GB' + d(e.w) + ',' + Math.max(1, d(e.h)) + ',' + Math.max(1, d(e.h)) + '^FS');
    });
    out.push('^PQ' + (o.copies || 1), '^XZ');
    return out.join('\n') + '\n';
  }

  function tspl(t, o) {
    var dpmm = Math.round((o.dpi || 203) / 25.4), d = function (v) { return Math.round(v * dpmm); };
    var out = ['SIZE ' + t.w + ' mm,' + t.h + ' mm', 'GAP 2 mm,0 mm', 'DIRECTION 1', 'CLS'];
    withReprint(t).forEach(function (e) {
      if (e.t === 'text') {
        var mul = clamp(Math.round((e.h * dpmm) / 20), 1, 10);
        out.push('TEXT ' + d(e.x) + ',' + d(e.y) + ',"3",0,' + mul + ',' + mul + ',"' + quoteSafe(e.s, '\\["]') + '"');
      } else if (e.t === 'code128') {
        var mw = clamp(Math.floor(d(e.w) / code128Bars(e.d).modules), 1, 10);
        out.push('BARCODE ' + d(e.x) + ',' + d(e.y) + ',"128",' + d(e.h) + ',0,0,' + mw + ',' + mw + ',"' + quoteSafe(e.d, '\\["]') + '"');
      } else if (e.t === 'line') out.push('BAR ' + d(e.x) + ',' + d(e.y) + ',' + d(e.w) + ',' + Math.max(1, d(e.h)));
    });
    out.push('PRINT ' + (o.copies || 1) + ',1');
    return out.join('\r\n') + '\r\n';
  }

  function epl(t, o) {
    var dpmm = Math.round((o.dpi || 203) / 25.4), d = function (v) { return Math.round(v * dpmm); };
    var out = ['', 'N', 'q' + d(t.w), 'Q' + d(t.h) + ',24'];
    withReprint(t).forEach(function (e) {
      if (e.t === 'text') {
        var font = e.h * dpmm >= 40 ? 5 : e.h * dpmm >= 24 ? 4 : e.h * dpmm >= 16 ? 3 : 2;
        out.push('A' + d(e.x) + ',' + d(e.y) + ',0,' + font + ',1,1,N,"' + quoteSafe(e.s, '\\"') + '"');
      } else if (e.t === 'code128') {
        var mw = clamp(Math.floor(d(e.w) / code128Bars(e.d).modules), 1, 10);
        out.push('B' + d(e.x) + ',' + d(e.y) + ',0,1,' + mw + ',' + mw + ',' + d(e.h) + ',N,"' + quoteSafe(e.d, '\\"') + '"');
      } else if (e.t === 'line') out.push('LO' + d(e.x) + ',' + d(e.y) + ',' + d(e.w) + ',' + Math.max(1, d(e.h)));
    });
    out.push('P' + (o.copies || 1), '');
    return out.join('\n');
  }

  function latin1Bytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); out.push(c < 256 ? c : 63); }
    return out;
  }
  function b64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  /** Receipt printers print top to bottom: elements in y order, one per line. */
  function escpos(t, o) {
    var b = [0x1b, 0x40];
    var els = withReprint(t).slice().sort(function (a, c) { return a.y - c.y; });
    for (var n = 0; n < (o.copies || 1); n++) {
      els.forEach(function (e) {
        if (e.t === 'text') {
          b.push(0x1b, 0x45, e.b ? 1 : 0);
          b.push(0x1d, 0x21, e.h >= 4 ? 0x11 : 0x00);
          b = b.concat(latin1Bytes(e.s.replace(/[\x00-\x1f]/g, ' ')), [0x0a]);
        } else if (e.t === 'code128') {
          var data = latin1Bytes('{B' + String(e.d).replace(/[^\x20-\x7e]/g, '?'));
          b.push(0x1d, 0x68, clamp(Math.round(e.h * 8), 24, 255), 0x1d, 0x77, 2, 0x1d, 0x48, 0x02, 0x1d, 0x6b, 0x49, data.length);
          b = b.concat(data, [0x0a]);
        } else if (e.t === 'line') b = b.concat(latin1Bytes('--------------------------------'), [0x0a]);
      });
      b.push(0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x42, 0x00);
    }
    return b;
  }

  function pdfText(s) { return String(s).replace(/[^\x20-\x7e]/g, '?').replace(/([()\\])/g, '\\$1'); }
  function pdf(t) {
    var k = 72 / 25.4, Wp = (t.w * k).toFixed(2), Hp = (t.h * k).toFixed(2), ops = [];
    var Y = function (mm) { return (t.h - mm) * k; };
    withReprint(t).forEach(function (e) {
      if (e.t === 'text') {
        ops.push('BT /' + (e.b ? 'F2' : 'F1') + ' ' + (e.h * 1.4 * k).toFixed(2) + ' Tf ' + (e.x * k).toFixed(2) + ' ' + Y(e.y + e.h).toFixed(2) + ' Td (' + pdfText(e.s) + ') Tj ET');
      } else if (e.t === 'code128') {
        var cb = code128Bars(e.d), mod = e.w / cb.modules;
        cb.bars.forEach(function (bar) {
          ops.push(((e.x + bar[0] * mod) * k).toFixed(2) + ' ' + Y(e.y + e.h).toFixed(2) + ' ' + (bar[1] * mod * k).toFixed(2) + ' ' + (e.h * k).toFixed(2) + ' re f');
        });
      } else if (e.t === 'line') ops.push((e.x * k).toFixed(2) + ' ' + Y(e.y + e.h).toFixed(2) + ' ' + (e.w * k).toFixed(2) + ' ' + (e.h * k).toFixed(2) + ' re f');
    });
    var stream = ops.join('\n');
    var objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + Wp + ' ' + Hp + '] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
      '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream'
    ];
    var s = '%PDF-1.4\n', offs = [];
    objs.forEach(function (o, i) { offs.push(s.length); s += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
    var xref = s.length;
    s += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
    offs.forEach(function (o) { s += ('0000000000' + o).slice(-10) + ' 00000 n \n'; });
    s += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    return latin1Bytes(s);
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  /** The browser fallback: absolutely placed in mm, so print preview matches the label. */
  function html(t) {
    var parts = ['<div class="ra-label" style="position:relative;box-sizing:border-box;width:' + t.w + 'mm;height:' + t.h + 'mm;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif;overflow:hidden;page-break-after:always">'];
    withReprint(t).forEach(function (e) {
      if (e.t === 'text') parts.push('<div style="position:absolute;left:' + e.x + 'mm;top:' + e.y + 'mm;width:' + e.w + 'mm;font-size:' + r2(e.h * 1.4) + 'mm;line-height:1;white-space:nowrap;font-weight:' + (e.b ? 700 : 400) + '">' + esc(e.s) + '</div>');
      else if (e.t === 'code128') {
        var cb = code128Bars(e.d), rects = cb.bars.map(function (b) { return '<rect x="' + b[0] + '" y="0" width="' + b[1] + '" height="10"/>'; }).join('');
        parts.push('<svg style="position:absolute;left:' + e.x + 'mm;top:' + e.y + 'mm;width:' + e.w + 'mm;height:' + e.h + 'mm" viewBox="0 0 ' + cb.modules + ' 10" preserveAspectRatio="none" aria-label="' + esc(e.d) + '">' + rects + '</svg>');
      } else if (e.t === 'line') parts.push('<div style="position:absolute;left:' + e.x + 'mm;top:' + e.y + 'mm;width:' + e.w + 'mm;height:' + e.h + 'mm;background:#000"></div>');
    });
    parts.push('</div>');
    return parts.join('');
  }

  /** template -> { language, encoding: 'utf8' | 'base64', body } */
  function render(t, language, opts) {
    var o = opts || {};
    if (LANGUAGES.indexOf(language) < 0) throw new Error('Unknown printer language "' + language + '". Languages: ' + LANGUAGES.join(', '));
    if (!t || !Array.isArray(t.elements)) throw new Error('Not a label template.');
    if (language === 'zpl') return { language: language, encoding: 'utf8', body: zpl(t, o) };
    if (language === 'tspl') return { language: language, encoding: 'utf8', body: tspl(t, o) };
    if (language === 'epl') return { language: language, encoding: 'utf8', body: epl(t, o) };
    if (language === 'escpos') return { language: language, encoding: 'base64', body: b64(escpos(t, o)) };
    if (language === 'pdf') return { language: language, encoding: 'base64', body: b64(pdf(t)) };
    return { language: language, encoding: 'utf8', body: html(t) };
  }

  return { SIZES: SIZES, LANGUAGES: LANGUAGES, CODE128: CODE128, code128Values: code128Values, code128Bars: code128Bars, build: build, render: render };
});
