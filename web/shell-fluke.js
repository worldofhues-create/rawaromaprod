/* SHELL-FLUKE-1: "2b Shell Fluke", the packed-goods label (owner, 2026-11-10).
 *
 * One continuous 240 x 100 mm wrap, read left to right as it goes round the bottle:
 *   BACK 90 mm  | FRONT 100 mm | SIDE 50 mm, seam at the right edge.
 * Two spot inks, Abyss Ink and Horizon Blue, on uncoated sand stock; the dunes behind the ink mass
 * are a blind-emboss plate, so they are drawn on the preview and left off the print plates.
 *
 * Pure: no DOM, no network, no clock. UMD, like label-render.js: the RawProd page (window.ShellFluke),
 * the server and the tests (require) load this one file, and ALEMBIC carries a byte-identical copy
 * (apps/web/lib/packaging/shell-fluke.js, pinned by hash in its test).
 *
 *   compose(facts)                -> { model, problems[], production }
 *   template(model, opts)         -> mm elements, the same list the SVG and the PDF draw
 *                                    opts.mode 'production' THROWS while any problem stands
 *   svg(template, deps)           -> the screen preview / browser print
 *   smallContent(model)           -> RaLabel.build content for label stock smaller than the wrap
 *
 * FAIL CLOSED. Every regulatory or customer-kept fact is printed only when the caller hands it over
 * from a record, and a production print is refused while one is missing:
 *   hazard   GHS pictograms, signal word, allergens only from per-material SDS data; none held ->
 *            "Hazard data not on file — see SDS", no diamond, no blank "HAZARDOUS –" (reads as none)
 *   IFRA     a conformity line only with a certificate on file; never the word "certified"
 *   batch    lot, manufacture and use-by dates from the real batch; never a sample value
 *   MRP      from the server quote, in rupees, inclusive of all taxes; this file does no arithmetic on it
 *   seller   manufacturer name, address and PIN, consumer-care phone AND email, from the seller profile
 *   grade    RESEMBLE 90% / ALIKE 95% / CLOSE 99% only (rac-code.js); the old intent words are refused
 * NOT DRAWN, on purpose:
 *   - the reference / "INSPIRED BY <house>" row: the benchmark is digital only and is never printed on
 *     a pack or label (packages/contracts/src/rac/line.ts, surface "label"; rac_reference_clearance has
 *     one scope, 'digital'). OQ-LABEL-1. compose() drops a reference it is handed.
 *   - the EAN-13: there is no GS1 GTIN. The lot's Code 128 (batch_no = ALEMBIC lot.code) stays, so the
 *     bridge contract is unchanged.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShellFluke = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function (root) {
  'use strict';

  /* SHELL-FLUKE-9: the owner's colour book, "RAC - Color System - Usage Guidelines.pdf" p.3 (V1,
     November 2026; its own note: PMS values are nearest matches, confirm on a physical swatch). The
     sand stock and paper are not inks and stay as they were. */
  var INK = {
    abyss: '#0B0B0D',   // spot 1: Abyss Ink, RAC P-01 primary ground, PMS Black 6 C
    horizon: '#2F5DFF', // spot 2: Horizon Blue, RAC P-02 signal, PMS 2728 C
    dusk: '#9C9BD6',    // emboss plate, preview only: Dusk Violet, RAC AT-03 atmosphere, PMS 2716 C
    surface: '#829EFF', // emboss plate, preview only: Surface Light, RAC AT-01 atmosphere, PMS 2718 C
    sand: '#EFE6D8',    // the stock itself (no ink): Sand, the brand handoff's colour system (BRAND-7)
    paper: '#FFFFFF'    // knock-out (no ink) behind the barcode
  };
  var PRINT_INKS = [INK.abyss, INK.horizon];
  var WRAP = { w: 240, h: 100, back: [0, 90], front: [90, 190], side: [190, 240], ink: 66, horizon: 42 };
  /* label-render.js FONT-RP-4: font size = 1.15 x element height and lines pitched at 1.25 h, so one
     line's descender never strikes the next line's caps. Kept here, and asserted against RaLabel. */
  var TEXT_EM = 1.15, PITCH = 1.25;
  var HAZARD_NOT_ON_FILE = 'Hazard data not on file — see SDS';
  var GRADES = { RESEMBLE: 90, ALIKE: 95, CLOSE: 99 };
  var OLD_GRADE_WORDS = /\b(INTERPRETATION|REFERENCE|FIDELITY|INSPIRED|IDENTICAL|KLONE)\b/i;
  var SAMPLE_RE = /\b(sample|placeholder|printed at fill|at fill|to be supplied|tbd|tba|lorem|example|xxxx+|dummy|test lot)\b/i;
  var PRODUCT_RE = /^RAC (\d{2}) \/ (\d{4})$/;
  var VARIANT_RE = /^RAC (\d{2}) \/ (\d{4}) \/ ([A-Z0-9]+) \/ (RESEMBLE|ALIKE|CLOSE)$/;
  var LOT_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/; // label-render OPAQUE_RE: the lot code is an opaque id
  var ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var RUPEES_RE = /^(\d{1,3}(,\d{2})*(,\d{3})|\d+)(\.\d{2})?$/;
  var PIN_RE = /\b(\d{6})\b/g;
  var VERIFY_RE = /^https:\/\/[a-z0-9.-]+(:\d+)?\/store\/lot\/$/;
  var GHS = { GHS01: 'Explosive', GHS02: 'Flammable', GHS03: 'Oxidising', GHS04: 'Gas under pressure', GHS05: 'Corrosive',
    GHS06: 'Toxic', GHS07: 'Harmful / irritant', GHS08: 'Health hazard', GHS09: 'Environmental hazard' };

  function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
  function present(v) { return str(v) !== ''; }
  function monthYear(iso) { var m = ISO_DATE.exec(str(iso)); return m ? m[2] + '-' + m[1] : ''; }

  /**
   * facts (all from records; nothing here is a default):
   *   productName, accords[], productCode 'RAC 27 / 1150', variantCode 'RAC 27 / 1150 / 1K / ALIKE'
   *   genericName, packSize '1 kg', netQuantity { value, unit }
   *   batch   { lotCode, manufacturingDate 'YYYY-MM-DD', useByDate 'YYYY-MM-DD' }        (null before fill)
   *   mrp     { rupees '1,150.00', inclusiveOfAllTaxes: true, source: 'server-quote' }   (null: none quoted)
   *   sds     { pictograms ['GHS02'...], signalWord 'Warning'|'Danger', precautionary, allergens [],
   *             hazardStatements, flammable true|false|null, source }                    (null: none held)
   *   ifra    { certificateNo, amendment, onFile: true }                                 (null: none on file)
   *   seller  { name, address, pin, consumerCarePhone, consumerCareEmail, country }      (null: profile empty)
   *   verifyUrl  ALEMBIC's lot-verify base, https://<storefront>/store/lot/ (SHELL-FLUKE-8)
   */
  function compose(facts) {
    var f = facts || {}, problems = [];
    function need(code, msg) { problems.push({ code: code, message: msg }); }

    // ── identity, code and grade ──
    var productCode = str(f.productCode), variant = VARIANT_RE.exec(str(f.variantCode));
    if (!PRODUCT_RE.test(productCode)) need('code', 'No RAC product code (RAC 00 / 0000) on the record.');
    var grade = null;
    if (variant) {
      if ('RAC ' + variant[1] + ' / ' + variant[2] !== productCode) need('code', 'The variant ' + f.variantCode + ' is not a variant of ' + productCode + '.');
      grade = variant[4];
    } else if (present(f.grade) && GRADES[str(f.grade).toUpperCase()]) grade = str(f.grade).toUpperCase();
    if (!grade) need('grade', present(f.grade) && OLD_GRADE_WORDS.test(f.grade)
      ? '"' + f.grade + '" is a retired grade word. The grade is RESEMBLE 90%, ALIKE 95% or CLOSE 99%.'
      : 'No grade on the record (RESEMBLE 90%, ALIKE 95% or CLOSE 99%).');
    if (!present(f.productName)) need('name', 'No product name on the record.');
    if (!present(f.genericName)) need('generic', 'No common or generic name (Legal Metrology).');
    var nq = f.netQuantity || {};
    if (!present(nq.value) || !present(nq.unit)) need('netqty', 'No net quantity (Legal Metrology).');

    // ── the batch: lot and dates are printed at fill, from the real batch ──
    var b = f.batch || null;
    var lot = b && LOT_RE.test(str(b.lotCode)) ? str(b.lotCode) : null;
    if (!lot) need('lot', b && present(b.lotCode) ? 'The lot code "' + b.lotCode + '" is not a lot id.' : 'No batch yet: the lot is assigned at fill.');
    var mfd = b ? monthYear(b.manufacturingDate) : '', useBy = b ? monthYear(b.useByDate) : '';
    if (!mfd) need('mfd', 'No month and year of manufacture from the batch (Legal Metrology).');
    if (!useBy) need('useby', 'No use-by date from the batch.');

    // ── MRP: the server's quote, already in rupees, inclusive of all taxes ──
    var m = f.mrp || null, mrp = null;
    if (!m) need('mrp', 'No MRP: it comes from the server quote (Legal Metrology).');
    else if (m.source !== 'server-quote' || m.inclusiveOfAllTaxes !== true || !RUPEES_RE.test(str(m.rupees))) {
      need('mrp', 'The MRP must be the server quote in rupees, inclusive of all taxes.');
    } else mrp = '₹' + str(m.rupees) + ' incl. of all taxes';

    // ── seller profile: manufacturer address + PIN, consumer care phone AND email ──
    var s = f.seller || null, seller = null;
    if (!s || !present(s.name) || !present(s.address) || !present(s.pin)) need('seller', 'The seller profile has no manufacturer name, address and PIN (Legal Metrology).');
    else {
      var pins = (str(s.address).match(PIN_RE) || []).filter(function (p) { return p !== str(s.pin); });
      if (!/^\d{6}$/.test(str(s.pin))) need('seller', 'The seller PIN "' + s.pin + '" is not a six-digit PIN.');
      else if (pins.length) need('seller', 'The seller address says ' + pins.join(', ') + ' but the PIN on file is ' + s.pin + '. Settle one before printing.');
    }
    if (!s || !present(s.consumerCarePhone) || !present(s.consumerCareEmail) || SAMPLE_RE.test(str(s.consumerCarePhone) + ' ' + str(s.consumerCareEmail))) {
      need('care', 'Consumer care needs a phone number and an email on file (Legal Metrology).');
    }
    if (s && !problems.some(function (p) { return p.code === 'seller' || p.code === 'care'; })) {
      seller = {
        address: 'Mfd. & packed by ' + str(s.name) + ', ' + str(s.address).replace(new RegExp(',?\\s*' + str(s.pin) + '\\b'), '') + ' ' + str(s.pin) + '. Country of origin: ' + (str(s.country) || 'India') + '.',
        care: 'Consumer care: ' + str(s.consumerCarePhone) + ' · ' + str(s.consumerCareEmail)
      };
    }

    // ── hazard: only from per-material SDS data held in the system ──
    var sd = f.sds || null, hazard = null;
    var pict = sd && Array.isArray(sd.pictograms) ? sd.pictograms.map(function (p) { return str(p).toUpperCase(); }) : [];
    var held = sd && present(sd.source) && present(sd.signalWord) && pict.length > 0 && pict.every(function (p) { return GHS[p]; });
    if (!held) need('hazard', HAZARD_NOT_ON_FILE + '.');
    else {
      hazard = {
        pictograms: pict.slice(0, 3),
        signalWord: str(sd.signalWord).toUpperCase(),
        precautionary: str(sd.precautionary),
        allergens: Array.isArray(sd.allergens) && sd.allergens.length ? sd.allergens.map(str).filter(Boolean).join(', ') : null,
        hazardous: present(sd.hazardStatements) ? str(sd.hazardStatements) : null,
        flammable: sd.flammable === true ? 'Yes' : null
      };
    }

    // ── IFRA: a declaration of conformity, only with the certificate on file ──
    var fi = f.ifra || null;
    var ifra = fi && fi.onFile === true && present(fi.certificateNo)
      ? 'Conforms to IFRA' + (present(fi.amendment) ? ' ' + str(fi.amendment) : '') + ' · cert. ' + str(fi.certificateNo)
      : null;

    // ── nothing printed may be a sample ──
    [f.productName, f.genericName, f.packSize, lot, b && b.lotCode].forEach(function (v) {
      if (present(v) && SAMPLE_RE.test(str(v))) need('sample', '"' + v + '" is a sample value, not a record.');
    });

    var accords = (Array.isArray(f.accords) ? f.accords : []).map(function (a) { return str(a).toUpperCase(); }).filter(Boolean).slice(0, 3);
    var pc = PRODUCT_RE.exec(productCode);
    var model = {
      name: str(f.productName), accords: accords, codeHead: pc ? 'RAC ' + pc[1] : '', codeTail: pc ? pc[2] : '',
      productCode: productCode, grade: grade ? grade + ' ' + GRADES[grade] + '%' : null,
      pack: str(f.packSize) || (present(nq.value) ? str(nq.value) + ' ' + str(nq.unit) : ''),
      genericName: str(f.genericName), netQty: present(nq.value) ? str(nq.value) + ' ' + str(nq.unit) : null,
      lot: lot, mfd: mfd || null, useBy: useBy || null, mrp: mrp, ifra: ifra, hazard: hazard, seller: seller,
      /* SHELL-FLUKE-8: ALEMBIC's public lot-verify page, /store/lot/<code> on the storefront origin. Only
         that shape is accepted, so a mistyped config cannot point a pack's QR somewhere else. */
      verifyUrl: VERIFY_RE.test(str(f.verifyUrl)) && lot ? str(f.verifyUrl) + encodeURIComponent(lot) : null
      // f.reference / f.referenceFragrance are deliberately not read: OQ-LABEL-1 (see the header).
    };
    return { model: model, problems: problems, production: problems.length === 0 };
  }

  /* ── layout helpers ─────────────────────────────────────────────────────────────── */
  function r2(v) { return Math.round(v * 100) / 100; }
  /* A conservative advance (Manrope averages 0.53 em, JetBrains Mono is 0.6 em) so a wrapped line never
     runs past its column; the PDF measures exactly, the SVG lets the browser set it. */
  function approxWidth(s, h, mono, ls) { var fs = h * TEXT_EM; return String(s).length * fs * ((mono ? 0.6 : 0.56) + (ls || 0)); }
  function wrap(s, w, h, mono, ls) {
    var words = String(s).split(/\s+/), lines = [], cur = '';
    words.forEach(function (wd) {
      var next = cur ? cur + ' ' + wd : wd;
      if (cur && approxWidth(next, h, mono, ls) > w) { lines.push(cur); cur = wd; } else cur = next;
    });
    if (cur) lines.push(cur);
    return lines;
  }

  /* BRAND-6: the RAC marks are the owner's brand handoff artwork (handoff/brand/logo): the Shell Fluke
     icon replaces SHELL-FLUKE-7's contour trace, and the wordmark replaces "RAC" set in type ("Never
     retype 'RAC'; always use the wordmark image"). An element { t: 'mark', m: 'icon' | 'wordmark' } is
     drawn from web/brand-marks.js: the SVG masks its colour with the handoff PNG, the PDF prints its
     1-bit stencil as an /ImageMask in that one spot ink. Effective resolution on the 240 mm wrap: the
     392 px icon at 8.5 mm is 1171 dpi (7.2 mm: 1383, 6 mm: 1659), the 258 px wordmark at 12.6 mm is
     520 dpi -- above 300 at every use. OQ-LABEL-3 (a vector master) stays open for scaling past that. */
  var ICON_K = 284 / 392, WORDMARK_K = 258 / 82;
  function mark(x, y, size, c) { return { t: 'mark', m: 'icon', x: r2(x), y: r2(y), w: r2(size), h: r2(size * ICON_K), c: c }; }
  function wordmark(x, y, h, c) { return { t: 'mark', m: 'wordmark', x: r2(x), y: r2(y), w: r2(h * WORDMARK_K), h: r2(h), c: c }; }

  function ridge(x) { return WRAP.ink - 6 * Math.exp(-Math.pow((x - 105) / 60, 2)) + 1.2 * Math.sin(x / 19); }

  /**
   * opts: { mode: 'preview' | 'production', plates: 'preview' | 'print', problems: [] }
   *   production  refused (throws) while any problem stands; the wrap then carries no NOT FOR SALE band
   *   plates      'print' drops the emboss plate (Dusk Violet and Surface Light dots) and the stock tint,
   *               leaving exactly the two spot inks
   */
  function template(composed, opts) {
    var o = opts || {}, model = composed.model, problems = composed.problems || [];
    var mode = o.mode || 'preview', print = o.plates === 'print';
    if (mode === 'production' && problems.length) {
      throw new Error('Production print refused: ' + problems.map(function (p) { return p.message; }).join(' '));
    }
    var els = [];
    function T(x, y, h, s, extra) { var e = { t: 'text', x: r2(x), y: r2(y), w: r2((extra && extra.w) || 60), h: r2(h), s: String(s), b: false, c: INK.abyss }; for (var k in extra) if (k !== 'w') e[k] = extra[k]; els.push(e); return e; }
    function lines(x, y, w, h, s, extra) { wrap(s, w, h, extra && extra.mono, extra && extra.ls).forEach(function (ln, i) { T(x, y + i * h * PITCH, h, ln, Object.assign({ w: w }, extra || {})); }); return y + wrap(s, w, h, extra && extra.mono, extra && extra.ls).length * h * PITCH; }

    // ── stock, horizon, sun, dunes (emboss), ink mass ──
    if (!print) els.push({ t: 'rect', x: 0, y: 0, w: WRAP.w, h: WRAP.h, c: INK.sand, layer: 'stock' });
    var P = 1.1;
    for (var gy = 30; gy < WRAP.horizon; gy += P) for (var gx = 128; gx <= 152; gx += P) { // halftone sun, Horizon Blue
      var d = Math.hypot(gx - 140, gy - WRAP.horizon); if (d > 10.5) continue;
      var sz = r2(P * (0.62 - 0.4 * d / 10.5)); if (sz > 0.12) els.push({ t: 'rect', x: r2(gx - sz / 2), y: r2(gy - sz / 2), w: sz, h: sz, c: INK.horizon, layer: 'sun' });
    }
    els.push({ t: 'rect', x: 0, y: WRAP.horizon, w: WRAP.w, h: 0.3, c: INK.horizon, layer: 'horizon' });
    var dunes = [{ c: INK.surface, crest: function (x) { return 45 + 1.5 * Math.sin(x / 23); }, base: 53, plate: 'emboss' },
      { c: INK.dusk, crest: function (x) { return 50 + 1.8 * Math.sin(x / 31 + 1); }, base: 59, plate: 'emboss' },
      { c: INK.horizon, crest: function (x) { return 55 + 2 * Math.sin(x / 27 + 2); }, base: WRAP.ink + 2, plate: 'ink' }];
    dunes.forEach(function (dn) {
      if (print && dn.plate === 'emboss') return;
      for (var x = 0.6; x < WRAP.w; x += P) {
        var top = dn.crest(x), bot = Math.min(dn.base, ridge(x));
        for (var y = top; y < bot; y += P) {
          var t = (y - top) / Math.max(dn.base - top, 1), s2 = r2(P * (0.22 + 0.5 * t)); // dots grow away from the crest
          els.push({ t: 'rect', x: r2(x - s2 / 2), y: r2(y - s2 / 2), w: s2, h: s2, c: dn.c, layer: dn.plate === 'emboss' ? 'emboss' : 'dune' });
        }
      }
    });
    var pts = [[0, WRAP.h]]; for (var x2 = 0; x2 <= WRAP.w; x2 += 2) pts.push([x2, r2(ridge(x2))]); pts.push([WRAP.w, WRAP.h]);
    els.push({ t: 'poly', pts: pts, c: INK.abyss, layer: 'ink' });
    var hl = []; for (var x3 = 0; x3 <= WRAP.w; x3 += 2) hl.push([x3, r2(ridge(x3) - 0.9)]); for (var x4 = WRAP.w; x4 >= 0; x4 -= 2) hl.push([x4, r2(ridge(x4) - 0.65)]);
    els.push({ t: 'poly', pts: hl, c: INK.horizon, layer: 'highlight' });

    // ── BACK (0..90): the Legal Metrology table, the lot QR, the line, the maker ──
    var rows = [['PRODUCT', model.productCode ? model.productCode + (model.grade ? ' · ' + model.grade : '') : 'Not on file'],
      ['GENERIC NAME', model.genericName || 'Not on file'],
      ['NET QTY', model.netQty || 'Not on file'],
      ['MRP', model.mrp || 'Not on file'],
      ['MFD · USE BY', model.mfd && model.useBy ? model.mfd + ' · ' + model.useBy : 'From the batch at fill'],
      ['LOT', model.lot || 'Assigned at fill']];
    if (model.ifra) rows.push(['IFRA', model.ifra]); // a conformity line only with the certificate on file
    // OQ-LABEL-1: no reference / "INSPIRED BY" row. The benchmark reference is digital only and is never
    // printed on a pack or label (packages/contracts/src/rac/line.ts: surface 'label' never carries it).
    var ry = 7.5;
    rows.forEach(function (r) {
      T(6, ry + 0.25, 1.35, r[0], { mono: true, ls: 0.12, w: 19 });
      var ny = lines(26, ry, 31, 1.75, r[1], { mono: r[0] === 'LOT' || r[0] === 'PRODUCT' });
      ry = Math.max(ny, ry + 1.75 * PITCH) + 1.0;
    });
    var qrData = model.verifyUrl || model.lot;
    if (qrData) {
      els.push({ t: 'qr', x: 61, y: 7, w: 22, h: 22, d: qrData, c: INK.abyss });
      if (model.verifyUrl) { T(61, 31, 1.3, 'SCAN TO VERIFY LOT ·', { mono: true, ls: 0.12, w: 24 }); T(61, 33.4, 1.3, 'PDP · SDS · COA', { mono: true, ls: 0.12, w: 24 }); }
      else { T(61, 31, 1.3, 'LOT CODE', { mono: true, ls: 0.12, w: 24 }); } // no verify base configured: no "verify" promise
    }
    T(6, 71, 2.3, 'Because every great fragrance starts RAW.', { c: INK.paper, w: 80 });
    if (model.seller) {
      var ay = lines(6, 83, 80, 1.3, model.seller.address, { c: INK.paper });
      T(6, Math.max(ay + 0.6, 92), 1.3, model.seller.care, { c: INK.paper, w: 80 });
    } else {
      T(6, 86, 1.6, 'Manufacturer address and consumer care not on file', { c: INK.paper, w: 80, b: true });
    }

    // ── FRONT (90..190): name, accords, seal, sun; the ink band with mark, code, grade, pack ──
    T(96, 6.5, 3.2, model.name || 'Product name not on file', { w: 60 });
    if (model.accords.length) T(96, 12.6, 1.6, model.accords.join(' · '), { mono: true, ls: 0.2, c: INK.horizon, w: 60 });
    els.push({ t: 'circle', x: 171, y: 18, r: 10.4, sw: 0.25, c: INK.abyss });
    els.push({ t: 'arctext', x: 171, y: 18, r: 8.0, h: 1.05, s: 'SEALED AT FILL · LOT TRACEABLE · BUILT FROM RAW ·', start: -96, mono: true, ls: 0.08, c: INK.abyss });
    els.push({ t: 'circle', x: 171, y: 18, r: 5.6, c: INK.abyss });
    els.push(mark(167.4, 15.2, 7.2, INK.paper));
    els.push(mark(96, 70, 8.5, INK.paper));
    // BRAND-6: the wordmark, 0.5 x the icon height after it and centred on it (handoff README).
    els.push(wordmark(96 + 8.5 + 0.5 * 8.5 * ICON_K, 70 + (8.5 * ICON_K - 4) / 2, 4, INK.paper));
    T(126, 70.6, 1.1, 'DISTINCT BY DESIGN.', { mono: true, ls: 0.3, c: INK.paper, w: 40 });
    T(126, 73.0, 1.1, 'CONSISTENT BY SYSTEM.', { mono: true, ls: 0.3, c: INK.paper, w: 40 });
    if (model.codeHead) {
      /* SHELL-FLUKE-7: "RAC 27" and "/ 1150" are ONE element: the tail starts where the head's own glyphs
         end (the browser measures it in the SVG, the font's widths in the PDF) and shares its baseline, so
         the gap is the design's and no width estimate can make them collide or drift apart. */
      T(96, 83.5, 6.2, model.codeHead, { c: INK.paper, w: 60, tail: { s: '/ ' + model.codeTail, h: 2.5, mono: true, gap: 2.2 } });
    } else T(96, 85, 2.2, 'RAC code not on file', { c: INK.paper, w: 40, b: true });
    T(150, 82.5, 2.0, model.grade || 'GRADE NOT ON FILE', { mono: true, b: true, ls: 0.1, a: 'r', c: INK.paper, w: 36 });
    if (model.pack) T(150, 87.2, 3.6, model.pack, { a: 'r', c: INK.paper, w: 36 });

    // ── SIDE (190..240): GHS block above the horizon, barcode in the ink ──
    var hz = model.hazard;
    if (hz) {
      hz.pictograms.forEach(function (code, i) {
        var cx = 199 + i * 11.5, cy = 11, R = 5.2;
        els.push({ t: 'poly', c: INK.abyss, pts: [[cx, cy - R], [cx + R, cy], [cx, cy + R], [cx - R, cy]] });
        els.push({ t: 'poly', c: INK.sand, pts: [[cx, cy - R + 0.7], [cx + R - 0.7, cy], [cx, cy + R - 0.7], [cx - R + 0.7, cy]] });
        T(cx - 3.2, cy - 0.7, 1.2, code, { mono: true, b: true, w: 6.4 }); // the SDS's pictogram code; artwork: OQ-LABEL-5
      });
      T(194, 19.5, 1.5, 'SIGNAL WORD · ' + hz.signalWord, { mono: true, b: true, ls: 0.08, w: 44 });
      var py = hz.precautionary ? lines(194, 22.6, 43, 1.45, hz.precautionary) : 22.6;
      py += 0.6;
      if (hz.hazardous) py = lines(194, py, 43, 1.1, 'HAZARDOUS · ' + hz.hazardous, { mono: true }) + 0.2;
      py = lines(194, py, 43, 1.1, 'ALLERGENS · ' + (hz.allergens || 'SEE SDS'), { mono: true }) + 0.2;
      if (hz.flammable) lines(194, py, 43, 1.1, 'FLAMMABLE · YES', { mono: true });
    } else {
      // Fail closed: no diamond, no blank "HAZARDOUS –". Saying nothing would read as "nothing applies".
      lines(194, 7, 42, 2.1, HAZARD_NOT_ON_FILE, { b: true });
    }
    if (model.lot) {
      els.push({ t: 'rect', x: 193, y: 76.5, w: 44, h: 16.5, c: INK.paper, layer: 'knockout' });
      els.push({ t: 'code128', x: 195, y: 78, w: 40, h: 10, d: model.lot, c: INK.abyss });
      T(195, 89.4, 1.3, 'LOT ' + model.lot, { mono: true, ls: 0.1, w: 40 });
    }

    // ── preview stamp ──
    var notForSale = mode !== 'production';
    if (notForSale) {
      els.push({ t: 'rect', x: 0, y: 0, w: WRAP.w, h: 3.6, c: INK.horizon, layer: 'stamp' });
      T(3, 0.8, 1.6, 'PREVIEW · NOT FOR SALE' + (problems.length ? ' · ' + problems.length + ' fact' + (problems.length > 1 ? 's' : '') + ' not on file' : ''), { b: true, mono: true, ls: 0.1, c: INK.paper, w: 200 });
    }
    return { v: 1, size: 'wrap240', w: WRAP.w, h: WRAP.h, reprint: false, notForSale: notForSale, mode: mode, plates: print ? 'print' : 'preview', elements: els };
  }

  /* The cap's tamper strip, 40 x 8 mm. */
  function capStrip() {
    return { v: 1, size: 'cap40x8', w: 40, h: 8, reprint: false, elements: [
      { t: 'rect', x: 0, y: 0, w: 40, h: 8, c: INK.horizon },
      mark(1.5, 1.6, 6, INK.paper),
      { t: 'text', x: 9, y: 2.9, w: 30, h: 1.6, s: 'SEALED AT FILL', mono: true, b: true, ls: 0.25, c: INK.paper }
    ] };
  }

  /* Smaller stock: the front panel only (code, grade, pack, lot, hazard), laid out by label-render's
     own build() so every printer language, the 1.15 rule and the scan-code floors apply unchanged. */
  function smallContent(composed, opts) {
    var o = opts || {}, m = composed.model, problems = composed.problems || [];
    if (o.mode === 'production' && problems.length) throw new Error('Production print refused: ' + problems.map(function (p) { return p.message; }).join(' '));
    var lines = [['Code', m.productCode ? m.productCode + (m.grade ? ' · ' + m.grade : '') : 'not on file'], ['Pack', m.pack || null],
      ['Lot', m.lot || 'assigned at fill'], ['Hazard', m.hazard ? m.hazard.signalWord + ' · ' + m.hazard.pictograms.join(' ') : HAZARD_NOT_ON_FILE]];
    if (m.mrp) lines.push(['MRP', m.mrp]);
    if (m.mfd) lines.push(['Mfd', m.mfd]);
    return { brand: o.mode === 'production' ? 'RAC' : 'PREVIEW · NOT FOR SALE', title: m.name || m.productCode, lines: lines, code: m.lot || undefined };
  }

  /* ── SVG: the screen preview and the browser print ───────────────────────────────── */
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  /* Whole literal attributes, so both repos' face scanners read the two faces (fonts-only-two, check-brand). */
  var MONO = ' font-family="JetBrains Mono, ui-monospace, monospace"', SANS = ' font-family="Manrope, system-ui, sans-serif"';
  /** deps: { code128Bars, qrMatrix } (RaLabel's, or ALEMBIC's equivalents). Without them a code is drawn as its text. */
  function svg(t, deps) {
    var D = deps || {}, out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + t.w + 'mm" height="' + t.h + 'mm" viewBox="0 0 ' + t.w + ' ' + t.h + '" data-shell-fluke="' + esc(t.size) + '"' + (t.notForSale ? ' data-not-for-sale="1"' : '') + '>');
    t.elements.forEach(function (e) {
      var fill = ' fill="' + (e.c || '#000') + '"';
      if (e.t === 'rect' || e.t === 'line') out.push('<rect x="' + e.x + '" y="' + e.y + '" width="' + e.w + '" height="' + e.h + '"' + fill + '/>');
      else if (e.t === 'path') out.push('<path fill-rule="evenodd" d="' + e.rings.map(function (r) { return 'M' + r.map(function (p) { return p[0] + ',' + p[1]; }).join('L') + 'Z'; }).join('') + '"' + fill + '/>');
      else if (e.t === 'mark') { // BRAND-6: the handoff PNG as a mask over the element's colour
        var BM = D.marks || root.RaBrandMarks, mk = BM && BM[e.m];
        if (!mk) { out.push('<rect x="' + e.x + '" y="' + e.y + '" width="' + e.w + '" height="' + e.h + '" fill="none" stroke="' + (e.c || '#000') + '" stroke-width="0.2" data-mark-missing="' + e.m + '"/>'); return; }
        var mid = 'mk-' + e.m + '-' + Math.round(e.x * 10) + '-' + Math.round(e.y * 10);
        out.push('<mask id="' + mid + '"><image href="data:image/png;base64,' + mk.png + '" x="' + e.x + '" y="' + e.y + '" width="' + e.w + '" height="' + e.h + '" preserveAspectRatio="none"/></mask>' +
          '<rect x="' + e.x + '" y="' + e.y + '" width="' + e.w + '" height="' + e.h + '"' + fill + ' mask="url(#' + mid + ')" data-mark="' + e.m + '"/>');
      }
      else if (e.t === 'poly') out.push('<polygon points="' + e.pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ') + '"' + fill + '/>');
      else if (e.t === 'circle') out.push('<circle cx="' + e.x + '" cy="' + e.y + '" r="' + e.r + '"' + (e.sw ? ' fill="none" stroke="' + e.c + '" stroke-width="' + e.sw + '"' : fill) + '/>');
      else if (e.t === 'text') {
        var fs = r2(e.h * TEXT_EM);
        out.push('<text x="' + (e.a === 'r' ? r2(e.x + e.w) : e.x) + '" y="' + r2(e.y + e.h) + '" font-size="' + fs + '"' + (e.mono ? MONO : SANS) + ' font-weight="' + (e.b ? 700 : 400) + '"' +
          (e.ls ? ' letter-spacing="' + r2(e.ls * fs) + '"' : '') + (e.a === 'r' ? ' text-anchor="end"' : '') + fill + '>' + esc(e.s) +
          (e.tail ? '<tspan dx="' + e.tail.gap + '" font-size="' + r2(e.tail.h * TEXT_EM) + '"' + (e.tail.mono ? MONO : SANS) + ' font-weight="400">' + esc(e.tail.s) + '</tspan>' : '') + '</text>');
      } else if (e.t === 'arctext') {
        var id = 'arc' + Math.round(e.x * 10) + '-' + Math.round(e.y * 10), a0 = (e.start || 0) * Math.PI / 180;
        var sx = r2(e.x + e.r * Math.sin(a0)), sy = r2(e.y - e.r * Math.cos(a0)), mx = r2(e.x - e.r * Math.sin(a0)), my = r2(e.y + e.r * Math.cos(a0));
        // two half circles: one arc whose ends coincide is dropped by renderers
        out.push('<path id="' + id + '" d="M' + sx + ',' + sy + ' A' + e.r + ',' + e.r + ' 0 0 1 ' + mx + ',' + my + ' A' + e.r + ',' + e.r + ' 0 0 1 ' + sx + ',' + sy + '" fill="none"/>');
        var fs2 = r2(e.h * TEXT_EM);
        out.push('<text font-size="' + fs2 + '"' + (e.mono ? MONO : SANS) + (e.ls ? ' letter-spacing="' + r2(e.ls * fs2) + '"' : '') + fill + '><textPath href="#' + id + '">' + esc(e.s) + '</textPath></text>');
      } else if (e.t === 'code128') {
        if (!D.code128Bars) { out.push('<text x="' + e.x + '" y="' + (e.y + 4) + '" font-size="3"' + MONO + fill + '>' + esc(e.d) + '</text>'); return; }
        var cb = D.code128Bars(e.d), k = e.w / cb.modules;
        out.push('<g data-code128="' + esc(e.d) + '"' + fill + ' shape-rendering="crispEdges">' + cb.bars.map(function (b) { return '<rect x="' + r2(e.x + b[0] * k) + '" y="' + e.y + '" width="' + r2(b[1] * k) + '" height="' + e.h + '"/>'; }).join('') + '</g>');
      } else if (e.t === 'qr') {
        if (!D.qrMatrix) { out.push('<text x="' + e.x + '" y="' + (e.y + 4) + '" font-size="2"' + MONO + fill + '>' + esc(e.d) + '</text>'); return; }
        var M = D.qrMatrix(e.d), q = e.w / M.length, cells = [];
        M.forEach(function (row, r) { row.forEach(function (dk, c) { if (dk) cells.push('<rect x="' + r2(e.x + c * q) + '" y="' + r2(e.y + r * q) + '" width="' + r2(q + 0.01) + '" height="' + r2(q + 0.01) + '"/>'); }); });
        out.push('<g data-qr="' + esc(e.d) + '"' + fill + ' shape-rendering="crispEdges">' + cells.join('') + '</g>');
      }
    });
    out.push('</svg>');
    return out.join('');
  }

  /** Every string the template would print, in order (tests and the print gate read this). */
  function texts(t) { return t.elements.filter(function (e) { return e.t === 'text' || e.t === 'arctext'; }).map(function (e) { return e.tail ? e.s + ' ' + e.tail.s : e.s; }); }

  return { INK: INK, PRINT_INKS: PRINT_INKS, WRAP: WRAP, TEXT_EM: TEXT_EM, PITCH: PITCH, GRADES: GRADES, GHS: GHS, HAZARD_NOT_ON_FILE: HAZARD_NOT_ON_FILE,
    compose: compose, template: template, capStrip: capStrip, smallContent: smallContent, svg: svg, texts: texts, wrap: wrap };
});
