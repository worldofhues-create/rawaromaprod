/**
 * SCAN-3 — the server's half of the scan normaliser (the page's half is web/scan-input.js; one test
 * holds both to the same vectors). A keyboard-wedge scanner may be configured to send an AIM
 * symbology prefix (]C0 = Code 128, ]Q1 = QR, ...) and an Enter / CR / Tab suffix. Whatever reaches
 * the API, from the shared scan field or from a scanner typing straight into any input, is reduced
 * to the bare payload before it is resolved, so a QR scan and a Code 128 scan of the same label
 * resolve to the same thing.
 */
const AIM_PREFIX = /^\][A-Za-z][0-9A-Za-z]/;
// Control characters (CR, LF, Tab, GS, EOT...) scanners add as prefix/suffix; never part of a payload.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

export function scanCode(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).replace(CONTROL, '').trim();
  if (AIM_PREFIX.test(s)) s = s.slice(3);
  return s.trim();
}
