/* RAC-CODES-RP-2: the RAC code and grade, for RawProd's browser screens.
 *
 * The browser cannot load packages/contracts/src/rac (TypeScript). This is the
 * DISPLAY half of it, and contract-guard-rac-codes.test.ts runs both over the
 * same codes and asserts they agree, so a floor screen cannot read a code the
 * label or the server search reads differently.
 *
 *   RacCode.line('RAC 27 / 1150', 'RAC 27 / 1150 / 1K / ALIKE')  -> 'RAC 27 / 1150 · 1K · ALIKE 95%'
 *   RacCode.version('RAC 27 / 1150 / ALIKE', 3)                  -> 'RAC 27 / 1150 / ALIKE / F3'
 *
 * A code that is not a RAC code (DEMO-MAT-0001, an old SKU) is returned as it
 * was: nothing is renamed on a screen by guesswork.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RacCode = api;
})(typeof self !== 'undefined' ? self : this, function () {
  var PCT = { RESEMBLE: 90, ALIKE: 95, CLOSE: 99, MATERIAL: null };
  var PRODUCT = /^RAC (\d{2}) \/ (\d{4})$/;
  var VARIANT = /^RAC (\d{2}) \/ (\d{4}) \/ ([A-Z0-9]+) \/ (RESEMBLE|ALIKE|CLOSE|MATERIAL)$/;
  var FORMULA = /^RAC (\d{2}) \/ (\d{4}) \/ (RESEMBLE|ALIKE|CLOSE)$/;
  function gradeLabel(g) { if (!(g in PCT)) return ''; return PCT[g] === null ? g : g + ' ' + PCT[g] + '%'; }
  function parse(s) {
    var t = String(s == null ? '' : s).trim(), m;
    if ((m = PRODUCT.exec(t))) return { product: t };
    if ((m = VARIANT.exec(t))) return { product: 'RAC ' + m[1] + ' / ' + m[2], pack: m[3], grade: m[4] };
    return null;
  }
  /* productCode and/or skuCode -> one display line; non-RAC values pass through. */
  function line(productCode, skuCode) {
    var v = parse(skuCode), p = parse(productCode);
    if (v && v.grade) return v.product + ' · ' + v.pack + ' · ' + gradeLabel(v.grade);
    if (p) return p.product + (skuCode ? ' · ' + skuCode : '');
    return [productCode, skuCode].filter(Boolean).join(' · ');
  }
  /* A formula's version: F{n} under a RAC formula code, the old 'v{n}' otherwise. */
  function version(formulaCode, n) {
    if (n == null || n === '') return '';
    return FORMULA.test(String(formulaCode || '').trim()) ? String(formulaCode).trim() + ' / F' + n : 'v' + n;
  }
  function normalise(s) { return String(s == null ? '' : s).replace(/[\s/.\-·_]+/g, '').toUpperCase(); }
  return { gradeLabel: gradeLabel, parse: parse, line: line, version: version, normalise: normalise };
});
