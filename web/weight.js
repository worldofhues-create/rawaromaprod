/* RAW AROMA — weight display (web/weight.js), PROD-A-2 (production-floor plan §12.5).
 * The one place a stored weight becomes text. Pure: no DOM, no network, so it runs in a `vm` in
 * backend/api/src/__tests__/floor-weight.test.ts exactly as the page loads it.
 *
 * Every weight is STORED as integer milligrams. Rounding happens here, for display only; the
 * tolerance check on the server uses the exact stored value.
 *
 *   formatWeight(mg, uom = 'g', scaleResolutionMg?)
 *     'g'  (default, smart):  < 1 g → "0.45 g";  1 g … 999.99 g → "125.5 g";  ≥ 1000 g → "1.25 kg"
 *     'kg' / 'mg'          :  always that unit
 *     at most 2 decimals, trailing zeros trimmed, and never finer than the scale: a 0.1 g scale
 *     (resolution 100 mg) never shows "125.47 g".
 *   lineUnit(targetMg, uom)        the unit a whole line is shown in, chosen from the TARGET, so the
 *                                  target and the actual are never "1.25 kg" against "1250 g".
 *   formatIn(mg, unit, resMg, fixed?)  one value in a given unit (fixed = keep 2 decimals).
 *   formatTolerance(targetMg, tolMg, uom, resMg)  "target 125.00 g ± 1.25 g"
 *   parseToMg(text, unit)          what a person typed → integer mg, or null. "125.5" in g → 125500.
 */
(function (g) {
  'use strict';
  var FACTOR = { mg: 1, g: 1000, kg: 1000000 };

  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

  /** The rounding step in mg: 2 decimals of the unit, or the scale's resolution if coarser. */
  function stepFor(unit, resMg) {
    var two = Math.max(1, FACTOR[unit] / 100);
    var r = isInt(resMg) && resMg > 0 ? resMg : 1;
    return Math.max(two, r);
  }
  /** Round half away from zero to a multiple of step (integers only). */
  function roundTo(mg, step) {
    var sign = mg < 0 ? -1 : 1, a = Math.abs(mg);
    var q = Math.floor(a / step), rem = a - q * step;
    if (rem * 2 >= step) q += 1;
    return sign * q * step;
  }
  /** Exact decimal text of mg/factor, with `dec` decimals (integer arithmetic, no float drift). */
  function decimalText(mg, factor, dec) {
    var sign = mg < 0 ? '-' : '', a = Math.abs(mg);
    var whole = Math.floor(a / factor), frac = a - whole * factor;
    if (dec === 0) return sign + whole;
    var scale = Math.pow(10, dec); // frac/factor to `dec` digits; already rounded so this is exact
    var digits = String(Math.round(frac * scale / factor));
    while (digits.length < dec) digits = '0' + digits;
    return sign + whole + '.' + digits;
  }
  function decimalsFor(unit, step) {
    var f = FACTOR[unit], d = 0;
    while (d < 2 && step * Math.pow(10, d) < f) d++;
    return d;
  }
  function trim(text) { return text.indexOf('.') < 0 ? text : text.replace(/0+$/, '').replace(/\.$/, ''); }

  function lineUnit(targetMg, uom) {
    var u = String(uom || 'g').toLowerCase();
    if (u === 'kg' || u === 'mg') return u;
    return Math.abs(Number(targetMg) || 0) >= 1000000 ? 'kg' : 'g';
  }

  function formatIn(mg, unit, resMg, fixed) {
    if (mg === null || mg === undefined || mg === '') return '—';
    var n = Number(mg);
    if (!isFinite(n)) return '—';
    n = Math.round(n);
    var u = FACTOR[unit] ? unit : 'g';
    var step = stepFor(u, resMg);
    var dec = decimalsFor(u, step);
    var text = decimalText(roundTo(n, step), FACTOR[u], dec);
    return (fixed ? text : trim(text)) + ' ' + u;
  }

  function formatWeight(mg, uom, scaleResolutionMg) {
    return formatIn(mg, lineUnit(mg, uom), scaleResolutionMg, false);
  }

  function formatTolerance(targetMg, tolMg, uom, resMg) {
    var u = lineUnit(targetMg, uom);
    return 'target ' + formatIn(targetMg, u, resMg, true) + ' ± ' + formatIn(tolMg, u, resMg, true);
  }

  function parseToMg(text, unit) {
    var s = String(text == null ? '' : text).trim().replace(/,/g, '');
    var m = /^(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) return null;
    var u = FACTOR[unit] ? unit : 'g', f = FACTOR[u];
    var places = String(f).length - 1;
    var frac = m[2] || '';
    if (frac.length > places) return null; // finer than a milligram: refuse rather than round
    while (frac.length < places) frac += '0';
    var mg = Number(m[1]) * f + (places ? Number(frac) : 0);
    return isFinite(mg) && mg <= Number.MAX_SAFE_INTEGER ? mg : null;
  }

  g.RaWeight = { FACTOR: FACTOR, formatWeight: formatWeight, formatIn: formatIn, lineUnit: lineUnit, formatTolerance: formatTolerance, parseToMg: parseToMg };
  if (typeof module !== 'undefined' && module.exports) module.exports = g.RaWeight;
})(typeof window !== 'undefined' ? window : this);
