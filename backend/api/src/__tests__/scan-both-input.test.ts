/**
 * SCAN-2 / SCAN-3: one scan normaliser, used by the shared scan field (web/scan-input.js) and by the
 * server before every scan is resolved (backend/api/src/floor/scan-code.ts). Keyboard-wedge
 * scanners of either symbology add an AIM symbology prefix (]C0 Code 128, ]Q1 QR...) and an Enter,
 * CR or Tab suffix depending on how they were configured; both must arrive as the bare payload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { scanCode } from '../floor/scan-code.js';

const sb: Record<string, unknown> = {};
runInNewContext(readFileSync(new URL('../../../../web/scan-input.js', import.meta.url), 'utf8'), sb);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const S = sb.RaScan as any;

const VECTORS: Array<[string, string, string | null]> = [
  ['L-7Q3K9XA', 'L-7Q3K9XA', null],
  [']C0L-7Q3K9XA', 'L-7Q3K9XA', 'code_128'],
  [']Q1L-7Q3K9XA', 'L-7Q3K9XA', 'qr_code'],
  [']Q3L-7Q3K9XA\r', 'L-7Q3K9XA', 'qr_code'],
  [']C1A-01-03\n', 'A-01-03', 'code_128'],
  ['A-01-03\t', 'A-01-03', null],
  ['  T-12\r\n', 'T-12', null],
  [']E0890123456789', '890123456789', 'ean_upc'],
  [']d2CTN-41-1', 'CTN-41-1', 'data_matrix'],
  [']A0AWB12345', 'AWB12345', 'code_39'],
  ['\u001dL-7Q3K9XA\u0004', 'L-7Q3K9XA', null], // GS / EOT control characters some scanners add
  ['', '', null],
];

test('the page and the server normalise every wedge scan the same way', () => {
  for (const [raw, code, sym] of VECTORS) {
    const w = S.normalize(raw);
    assert.equal(w.code, code, JSON.stringify(raw));
    assert.equal(w.symbology, sym, JSON.stringify(raw));
    assert.equal(scanCode(raw), code, `server ${JSON.stringify(raw)}`);
  }
  assert.equal(scanCode(undefined), '');
  assert.equal(scanCode(null), '');
});

test('a bracket inside a payload is not taken for a symbology prefix', () => {
  assert.equal(S.normalize('A]C0').code, 'A]C0');
  assert.equal(scanCode('A]C0'), 'A]C0');
});

test('camera formats: QR and Code 128 first, then the common 1D/2D ones, intersected with the device', () => {
  assert.deepEqual([...S.FORMATS.slice(0, 2)], ['qr_code', 'code_128']);
  for (const f of ['code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'data_matrix', 'itf', 'codabar']) assert.ok(S.FORMATS.includes(f), f);
  assert.deepEqual([...S.pickFormats(['qr_code', 'maxicode', 'ean_13'])], ['qr_code', 'ean_13']);
  assert.deepEqual([...S.pickFormats([])], []);
});

test('wedge burst: keys under the threshold count as a scanner; a human typing does not', () => {
  const b = S.burst();
  [0, 8, 15, 22, 31, 40, 47, 55, 61].forEach((t) => b.key(t));
  assert.equal(b.isScanner(), true);
  const h = S.burst();
  [0, 180, 420, 610].forEach((t) => h.key(t));
  assert.equal(h.isScanner(), false);
});

test('every scan field in the floor views uses the shared component (data-scan), and the factory console loads it', () => {
  const read = (f: string) => readFileSync(new URL(`../../../../web/${f}`, import.meta.url), 'utf8');
  const html = read('index.html');
  assert.match(html, /<script src="\/scan-input\.js"><\/script>/);
  const want: Array<[string, string]> = [
    ['ws-floor.js', 'fl-tote'], ['ws-floor.js', 'fl-tote2'], ['ws-floor.js', 'fl-bin'], ['ws-floor.js', 'fl-lot'], ['ws-floor.js', 'fl-sci'],
    ['ws-floorb.js', 'fb-lot'], ['ws-floorb.js', 'fb-bin'], ['ws-floorb.js', 'fb-qlot'], ['ws-floorb.js', 'fb-rwlot'],
    ['ws-floor-ops.js', 'fo-scan-u'], ['ws-floor-ops.js', 'fo-lg-cc'], ['ws-floor-ops.js', 'fo-lg-awbv'],
  ];
  for (const [f, id] of want) {
    const src = read(f);
    const i = src.indexOf(`id="${id}"`) >= 0 ? src.indexOf(`id="${id}"`) : src.indexOf(`fld('${id}'`);
    assert.ok(i >= 0, `${f} ${id} exists`);
    assert.match(src.slice(Math.max(0, i - 40), i + 260), /data-scan/, `${f} ${id} uses the shared scan field`);
  }
});

test('the Factory console is never served with camera=() (kiosk camera scanning needs it)', () => {
  const conf = readFileSync(new URL('../../../../infra/aws/nginx/security-headers-factory.conf', import.meta.url), 'utf8')
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const pp = /add_header\s+Permissions-Policy\s+"([^"]*)"/.exec(conf)?.[1];
  if (pp !== undefined) assert.doesNotMatch(pp, /camera=\(\)/);
});
