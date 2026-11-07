/**
 * SCAN-1 (owner: "Product scanning: we need both QR and barcode"). Every label carries a Code 128
 * AND a QR code with the SAME opaque payload, in every printer language, at every 12.4 size that
 * can hold both at a scannable module size. 38 x 25 mm cannot (Code 128 at the 0.25 mm minimum bar
 * plus its quiet zones is wider than the label), so it prints the QR plus the code as text, and the
 * template records why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const sandbox: Record<string, unknown> = { Buffer };
runInNewContext(readFileSync(new URL('../../../../web/qrcode.js', import.meta.url), 'utf8'), sandbox);
runInNewContext(readFileSync(new URL('../../../../web/label-render.js', import.meta.url), 'utf8'), sandbox);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const L = sandbox.RaLabel as any;
type El = { t: string; x: number; y: number; w: number; h: number; d?: string; s?: string; m?: number };

const BOTH = ['50x25', '75x50', '100x50', '100x100', '100x150', '62mm', 'a4'];
const content = { title: 'PICKED', lines: [['Order', 'SO-1234'], ['Tote', 'T-12']], code: 'L-7Q3K9XA' };

test('every size except 38x25 carries Code 128 and QR with the same payload, inside the label, not overlapping', () => {
  for (const s of BOTH) {
    const t = L.build(content, s);
    const bar = t.elements.find((e: El) => e.t === 'code128');
    const qr = t.elements.find((e: El) => e.t === 'qr');
    assert.ok(bar && qr, s);
    assert.equal(bar.d, 'L-7Q3K9XA', s);
    assert.equal(qr.d, 'L-7Q3K9XA', s);
    assert.deepEqual({ ...t.codes }, { code128: true, qr: true, note: null }, s);
    for (const e of [bar, qr]) {
      assert.ok(e.x >= 0 && e.y >= 0 && e.x + e.w <= t.w + 1e-6 && e.y + e.h <= t.h + 1e-6, `${s} ${e.t} inside`);
    }
    const apart = bar.x + bar.w <= qr.x || qr.x + qr.w <= bar.x || bar.y + bar.h <= qr.y || qr.y + qr.h <= bar.y;
    assert.ok(apart, `${s} codes overlap`);
    assert.ok(bar.m >= 0.25, `${s} bar module ${bar.m}`);
    assert.ok(qr.m >= 0.375, `${s} qr module ${qr.m}`);
    assert.ok(bar.h >= 5, `${s} bar height ${bar.h}`);
    // quiet zones: 10 modules either side of the bars, 4 around the QR, inside the label edge
    assert.ok(bar.x >= 10 * bar.m - 1e-6 && bar.x + bar.w + 10 * bar.m <= t.w + 1e-6, `${s} bar quiet zone`);
    assert.ok(qr.x >= 4 * qr.m - 1e-6 && qr.x + qr.w + 4 * qr.m <= t.w + 1e-6, `${s} qr quiet zone`);
    // the human-readable code is printed too
    assert.ok(t.elements.some((e: El) => e.t === 'text' && e.s === 'L-7Q3K9XA'), `${s} readable code`);
  }
});

test('38x25: QR plus the readable code, and the template says why Code 128 was left off', () => {
  const t = L.build(content, '38x25');
  assert.equal(t.elements.filter((e: El) => e.t === 'code128').length, 0);
  const qr = t.elements.find((e: El) => e.t === 'qr');
  assert.equal(qr.d, 'L-7Q3K9XA');
  assert.ok(qr.m >= 0.375);
  assert.ok(t.elements.some((e: El) => e.t === 'text' && e.s === 'L-7Q3K9XA'));
  assert.equal(t.codes.code128, false);
  assert.equal(t.codes.qr, true);
  assert.match(t.codes.note, /Code 128 .* needs \d+(\.\d+)? mm .* 38 mm/);
});

test('the QR payload is the opaque id only: build refuses a code with spaces or lower-case words in it', () => {
  assert.throws(() => L.build({ ...content, code: 'Linalool 78-70-6' }, '100x50'), /opaque/);
  assert.throws(() => L.build({ ...content, code: 'BIN A-01 10%' }, '100x50'), /opaque/);
  for (const ok of ['L-7Q3K9XA', 'A-01-03', 'CTN-SO1234-1', 'T-12', 'RM-2026-0042', 'AWB123456789']) L.build({ ...content, code: ok }, '100x50');
});

test('ZPL: ^BQ QR next to ^BC Code 128, same data', () => {
  const z = L.render(L.build(content, '100x50'), 'zpl').body;
  assert.match(z, /\^BCN,\d+,N,N,N\^FDL-7Q3K9XA\^FS/);
  assert.match(z, /\^BQN,2,\d+\^FDMA,L-7Q3K9XA\^FS/);
});

test('TSPL: QRCODE and BARCODE "128", same data', () => {
  const b = L.render(L.build(content, '100x50'), 'tspl').body;
  assert.match(b, /BARCODE \d+,\d+,"128",\d+,0,0,\d+,\d+,"L-7Q3K9XA"/);
  assert.match(b, /QRCODE \d+,\d+,M,\d+,A,0,"L-7Q3K9XA"/);
});

test('EPL: Code 128 with B, QR drawn as module boxes (EPL2 has no QR command on most models)', () => {
  const t = L.build(content, '100x50');
  const b = L.render(t, 'epl').body;
  assert.match(b, /\nB\d+,\d+,0,1,\d+,\d+,\d+,N,"L-7Q3K9XA"/);
  const qr = t.elements.find((e: El) => e.t === 'qr');
  const dark = L.qrMatrix(qr.d).flat().filter(Boolean).length;
  const boxes = (b.match(/\nLO\d+,\d+,\d+,\d+/g) || []).length;
  assert.ok(boxes > 20 && boxes <= dark, `${boxes} boxes for ${dark} dark modules`);
});

test('ESC/POS: GS ( k QR store + print, after the GS k Code 128', () => {
  const bytes = [...Buffer.from(L.render(L.build(content, '100x50'), 'escpos').body, 'base64')];
  const hex = Buffer.from(bytes).toString('hex');
  assert.ok(hex.includes('1d6b49'), 'code 128');
  const data = Buffer.from('L-7Q3K9XA').toString('hex');
  assert.ok(hex.includes('1d286b' + (data.length / 2 + 3).toString(16).padStart(2, '0') + '00315030' + data), 'QR store');
  assert.ok(hex.includes('1d286b0300315130'), 'QR print');
});

test('PDF and HTML: the QR modules are drawn from the same matrix (round trip)', () => {
  const t = L.build(content, '100x50');
  const qr = t.elements.find((e: El) => e.t === 'qr');
  const M = L.qrMatrix('L-7Q3K9XA');
  const html = L.render(t, 'html').body;
  const svg = html.match(/<svg[^>]*data-qr="L-7Q3K9XA"[^>]*>(.*?)<\/svg>/);
  assert.ok(svg, 'qr svg');
  const cells = [...svg[1].matchAll(/<rect x="(\d+)" y="(\d+)"/g)].map((m) => `${m[1]},${m[2]}`);
  const want: string[] = [];
  M.forEach((row: boolean[], r: number) => row.forEach((d, c) => { if (d) want.push(`${c},${r}`); }));
  assert.deepEqual(cells.sort(), want.sort());
  assert.ok(html.includes('data-code128="L-7Q3K9XA"'));
  const pdf = Buffer.from(L.render(t, 'pdf').body, 'base64').toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4'));
  const rects = (pdf.match(/ re f/g) || []).length;
  assert.ok(rects >= want.length + L.code128Bars('L-7Q3K9XA').bars.length, 'pdf draws both');
  assert.ok(qr.w === qr.h && Math.abs(qr.w - M.length * qr.m) < 1e-6);
});

test('an old stored template (Code 128 only) still renders in every language', () => {
  const old = { v: 1, size: '100x50', w: 100, h: 50, reprint: false, elements: [{ t: 'code128', x: 3, y: 30, w: 94, h: 10, d: 'L-7Q3K9XA' }] };
  for (const lang of L.LANGUAGES) assert.ok(L.render(old, lang).body.length > 0, lang);
});
