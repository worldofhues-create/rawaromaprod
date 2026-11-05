/**
 * Lane pf-c (plan 12.4): ONE label template definition, rendered to ZPL, TSPL, EPL, ESC/POS, PDF
 * and the browser fallback (HTML) — web/label-render.js, the same file the page loads and the
 * print agent (tools/print-agent) requires. Every size in 12.4 is covered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Loaded as the page loads it (a classic script), in a vm with Buffer for the binary languages.
const sandbox: Record<string, unknown> = { Buffer };
runInNewContext(readFileSync(new URL('../../../../web/label-render.js', import.meta.url), 'utf8'), sandbox);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const L = sandbox.RaLabel as any;

const SIZES_12_4 = ['38x25', '50x25', '75x50', '100x50', '100x100', '100x150', '62mm', 'a4'];
const content = {
  title: 'PACKED',
  brand: 'RAW AROMA CHEM',
  lines: [['Order', 'SO-1234'], ['Lot', 'FG-2611-014'], ['Carton', '1 of 3']],
  code: 'CTN-SO1234-1',
};

test('every label size in plan 12.4 is defined, with real millimetres', () => {
  for (const s of SIZES_12_4) {
    const d = L.SIZES[s];
    assert.ok(d, s);
    assert.ok(d.w > 0, s);
  }
  assert.deepEqual([L.SIZES['38x25'].w, L.SIZES['38x25'].h], [38, 25]);
  assert.deepEqual([L.SIZES['100x150'].w, L.SIZES['100x150'].h], [100, 150]);
  assert.equal(L.SIZES['62mm'].continuous, true);
});

test('build: every element sits inside the label at every size', () => {
  for (const s of SIZES_12_4) {
    const t = L.build(content, s);
    assert.equal(t.size, s);
    assert.ok(t.h > 0);
    for (const e of t.elements) {
      assert.ok(e.x >= 0 && e.y >= 0, `${s} ${JSON.stringify(e)}`);
      assert.ok(e.x + (e.w ?? 0) <= t.w + 0.01, `${s} width ${JSON.stringify(e)}`);
      assert.ok(e.y + (e.h ?? 0) <= t.h + 0.01, `${s} height ${JSON.stringify(e)}`);
    }
    assert.ok(t.elements.some((e: { t: string; d?: string }) => e.t === 'code128' && e.d === 'CTN-SO1234-1'), s);
  }
});

test('reprint: the label says REPRINT in every language', () => {
  const t = L.build({ ...content, reprint: true }, '100x50');
  assert.equal(t.reprint, true);
  for (const lang of ['zpl', 'tspl', 'epl']) assert.match(L.render(t, lang).body, /REPRINT/, lang);
  assert.match(Buffer.from(L.render(t, 'escpos').body, 'base64').toString('latin1'), /REPRINT/);
  assert.match(Buffer.from(L.render(t, 'pdf').body, 'base64').toString('latin1'), /REPRINT/);
  assert.match(L.render(t, 'html').body, /REPRINT/);
  // Even a template built without the banner element gets it from the renderer.
  const bare = { ...L.build(content, '100x50'), reprint: true };
  assert.match(L.render(bare, 'zpl').body, /REPRINT/);
});

test('ZPL: a whole ^XA..^XZ label at 203 dpi with the barcode and every line', () => {
  const out = L.render(L.build(content, '100x50'), 'zpl', { dpi: 203 });
  assert.equal(out.encoding, 'utf8');
  assert.match(out.body, /^\^XA/);
  assert.match(out.body, /\^XZ\s*$/);
  assert.match(out.body, /\^PW800/); // 100 mm at 8 dots/mm
  assert.match(out.body, /\^BC.*\^FDCTN-SO1234-1\^FS/s);
  for (const v of ['SO-1234', 'FG-2611-014', '1 of 3']) assert.ok(out.body.includes(v), v);
});

test('ZPL/TSPL/EPL: control characters in data cannot break out of a field', () => {
  const evil = L.build({ ...content, lines: [['Order', 'A^XZ~JA"x']] }, '100x50');
  const z = L.render(evil, 'zpl').body;
  assert.equal((z.match(/\^XZ/g) ?? []).length, 1);
  assert.ok(!z.includes('~JA'));
  const t = L.render(evil, 'tspl').body;
  assert.ok(!/"A\^XZ~JA"x"/.test(t));
  assert.ok(t.includes('\\["]'));
});

test('TSPL: SIZE in mm, CLS, TEXT/BARCODE, PRINT', () => {
  const out = L.render(L.build(content, '75x50'), 'tspl').body;
  assert.match(out, /^SIZE 75 mm,50 mm/m);
  assert.match(out, /^CLS/m);
  assert.match(out, /^BARCODE .*"128".*"CTN-SO1234-1"/m);
  assert.match(out, /^PRINT 1,1/m);
});

test('EPL: N, q width, B barcode, P1', () => {
  const out = L.render(L.build(content, '50x25'), 'epl').body;
  assert.match(out, /^N$/m);
  assert.match(out, /^q400$/m);
  assert.match(out, /^B\d+,\d+,0,1,/m);
  assert.match(out, /^P1$/m);
});

test('ESC/POS: init, the text, a CODE128 barcode and a cut', () => {
  const bytes = Buffer.from(L.render(L.build(content, '75x50'), 'escpos').body, 'base64');
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40]);
  const s = bytes.toString('latin1');
  assert.ok(s.includes('SO-1234'));
  assert.ok(s.includes('\x1dk\x49')); // GS k 73 = CODE128
  assert.ok(s.includes('\x1dV'));
});

test('PDF: a valid one-page PDF at the label size', () => {
  const pdf = Buffer.from(L.render(L.build(content, '100x150'), 'pdf').body, 'base64').toString('latin1');
  assert.match(pdf, /^%PDF-1\.4/);
  assert.match(pdf, /%%EOF\s*$/);
  assert.match(pdf, /\/MediaBox \[0 0 283\.46 425\.2\d*\]/);
  assert.ok(pdf.includes('(Order: SO-1234) Tj'));
  const xref = Number(/startxref\s+(\d+)/.exec(pdf)![1]);
  assert.equal(pdf.slice(xref, xref + 4), 'xref');
});

test('62 mm continuous: the length follows the content', () => {
  const short = L.build({ ...content, lines: [['Lot', 'X']] }, '62mm');
  const long = L.build({ ...content, lines: Array.from({ length: 10 }, (_, i) => ['L' + i, 'v' + i]) }, '62mm');
  assert.ok(long.h > short.h);
});

test('code128: every pattern is 11 modules (stop 13), and the check digit is the standard one', () => {
  assert.equal(L.CODE128.length, 107);
  L.CODE128.forEach((p: string, i: number) => {
    const sum = p.split('').reduce((a, b) => a + Number(b), 0);
    assert.equal(sum, i === 106 ? 13 : 11, `pattern ${i}`);
  });
  assert.equal(new Set(L.CODE128).size, 107);
  // Start B (104) + 1*'A'(33) = 137 mod 103 = 34.
  const v = L.code128Values('A');
  assert.equal(JSON.stringify(v), '[104,33,34,106]');
});

test('unknown language or size is refused', () => {
  assert.throws(() => L.build(content, '10x10'), /size/);
  assert.throws(() => L.render(L.build(content, '100x50'), 'postscript'), /language/);
});
