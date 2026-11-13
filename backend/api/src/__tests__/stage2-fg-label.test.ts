/**
 * STAGE-2-RP (b): the finished-goods label and the Code 128 encoder.
 *
 * 1. The label (web/ws-produce.js labelHtml) printed "Net qty 100 g x 100 g": one pack's net content,
 *    then the pack size again as if it were a count, and never the lot's quantity, though the server
 *    has sent `lotQuantity` and `lotUnit` since STK-20. A packer reading "100 g x 100 g" on a lot of
 *    49 packs has no figure to count against. The row now reads the pack's net content once and the
 *    lot's quantity beside it, each from its own field. Nothing else on the label moves.
 * 2. code128Values (web/label-render.js) encoded a character Code 128 set B cannot carry as "?", so a
 *    scanner read a code that is not the lot's. It now refuses with a sentence, and prints nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = (p: string) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');

/** labelHtml and its SIZES table, lifted out of the console's closure and run with the two helpers it reads. */
function labelHtmlOf(): (c: Record<string, unknown>, size: string) => string {
  const src = read('web/ws-produce.js');
  const sizes = /\n  var SIZES = \{[\s\S]*?\n  \};\n/.exec(src);
  const fn = /\n  function labelHtml\(c, size\) \{[\s\S]*?\n  \}\n/.exec(src);
  assert.ok(sizes && fn, 'labelHtml and SIZES are still in web/ws-produce.js');
  const sandbox: Record<string, unknown> = {
    self: {},
    scanCodes: () => '', // both codes are drawn by label-render.js (covered by scan-both-labels.test.ts)
    escHtml: (s: unknown) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!)),
  };
  runInNewContext(sizes![0] + fn![0] + '\nthis.labelHtml = labelHtml;', sandbox);
  return sandbox.labelHtml as (c: Record<string, unknown>, size: string) => string;
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const lot = {
  skuCode: 'SKU-1', productCode: 'P-1', productName: 'Test Oil', batchNumber: 'FG-2611-000123', packSize: '100 g',
  netQuantity: '100', unit: 'g', lotQuantity: '49', lotUnit: 'PCS',
  manufacturingDate: '2026-11-01', expiryDate: '2028-11-01', qcStatus: 'RELEASED', qcReleasedAt: null, dg: null, rack: 'R-A1-S1', zone: null,
};

test('the label prints one pack\'s net content once, not "100 g x 100 g"', () => {
  const labelHtml = labelHtmlOf();
  for (const size of ['100x50', '100x150', '62mm', 'a4']) {
    const t = text(labelHtml(lot, size));
    assert.doesNotMatch(t, /100 g\s*×\s*100 g/, size);
    assert.match(t, /Net qty 100 g(?! ×)/, size);
  }
});

test('the label prints the lot quantity, from the lot fields, beside the net content', () => {
  const labelHtml = labelHtmlOf();
  for (const size of ['100x50', '100x150', '62mm', 'a4']) assert.match(text(labelHtml(lot, size)), /Net qty 100 g Lot qty 49 PCS/, size);
  assert.match(text(labelHtml({ ...lot, lotQuantity: '12.5', lotUnit: 'KG', netQuantity: '', unit: null, packSize: null }, '100x50')), /Lot qty 12\.5 KG/);
});

test('a figure the server did not send is not printed: no lot quantity, no invented one; no net content, the words say so', () => {
  const labelHtml = labelHtmlOf();
  const none = text(labelHtml({ ...lot, lotQuantity: '', lotUnit: null }, '100x50'));
  assert.doesNotMatch(none, /Lot qty/);
  assert.match(none, /Net qty 100 g/);
  const old = text(labelHtml({ ...lot, lotQuantity: undefined, lotUnit: undefined }, '100x50')); // a label record kept from before STK-20
  assert.doesNotMatch(old, /Lot qty|undefined/);
  const noNet = text(labelHtml({ ...lot, netQuantity: '', unit: null }, '100x50'));
  assert.match(noNet, /Net qty not on file/);
  assert.doesNotMatch(noNet, /×/);
});

const sandbox: Record<string, unknown> = { Buffer };
runInNewContext(read('web/qrcode.js'), sandbox);
runInNewContext(read('web/label-pdf-font.js'), sandbox);
runInNewContext(read('web/label-render.js'), sandbox);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const L = sandbox.RaLabel as any;

test('Code 128: a character the barcode cannot carry is refused with a sentence, never printed as "?"', () => {
  for (const bad of ['LOT-é1', 'L-7Q3K XA', 'ल-1', 'A\tB', 'A\nB']) {
    assert.throws(() => L.code128Values(bad), 
      // (the Error is the sandbox's own, so its message is read rather than its class)
      (e: unknown) => /cannot be printed as a barcode/.test((e as Error).message) && /[.]$/.test((e as Error).message) && !/\?/.test((e as Error).message.replace(JSON.stringify(bad), '')), JSON.stringify(bad));
    assert.throws(() => L.code128Bars(bad), /cannot be printed as a barcode/, JSON.stringify(bad));
  }
});

test('Code 128: what it can carry is encoded as before (start B, the characters, the check, stop)', () => {
  assert.deepEqual([...L.code128Values('L-7Q3K9XA')], [104, 44, 13, 23, 49, 19, 43, 25, 56, 33, 64, 106]);
  assert.deepEqual([...L.code128Values('A?B')], [104, 33, 31, 34, (104 + 33 + 2 * 31 + 3 * 34) % 103, 106], 'a real question mark is still a question mark');
  assert.equal(L.code128Values(' ~')[1], 0);
  assert.equal(L.code128Values(' ~')[2], 94);
});
