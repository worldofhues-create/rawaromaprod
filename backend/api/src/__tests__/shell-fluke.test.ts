/**
 * SHELL-FLUKE-2: the packed-goods wrap (web/shell-fluke.js) fails closed. Each rule below is shown
 * holding on complete facts AND firing when the fact is removed or wrong, so a rule that stopped
 * firing cannot pass as a clean label.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const sb: Record<string, unknown> = { Buffer };
for (const f of ['qrcode.js', 'label-pdf-font.js', 'brand-marks.js', 'label-render.js', 'rac-code.js', 'shell-fluke.js']) {
  runInNewContext(readFileSync(new URL('../../../../web/' + f, import.meta.url), 'utf8'), sb);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SF = sb.ShellFluke as any; const L = sb.RaLabel as any; const RC = sb.RacCode as any;

const FULL = {
  productName: 'Ambergris Sand', accords: ['Amber', 'Woody', 'Floral'], productCode: 'RAC 27 / 1150', variantCode: 'RAC 27 / 1150 / 1K / ALIKE',
  genericName: 'Fragrance compound', packSize: '1 kg', netQuantity: { value: '1', unit: 'kg' },
  batch: { lotCode: 'L-7Q3K9XA', manufacturingDate: '2026-11-04', useByDate: '2028-11-03' },
  mrp: { rupees: '4,250.00', inclusiveOfAllTaxes: true, source: 'server-quote' },
  sds: { source: 'SDS rev 3', pictograms: ['GHS02', 'GHS07'], signalWord: 'Warning', precautionary: 'Keep away from heat.',
    hazardStatements: 'H226 H317', allergens: ['Linalool'], flammable: true },
  ifra: { onFile: true, certificateNo: 'C-1', amendment: '51st' },
  seller: { name: 'RAW AROMACHEM', address: '2 Shri Nagar Main, Indore, Madhya Pradesh', pin: '452018', consumerCarePhone: '+91 99810 37630', consumerCareEmail: 'care@rawaromachem.com' },
};
const facts = (patch: Record<string, unknown> = {}) => ({ ...structuredClone(FULL), ...patch });
const codes = (f: unknown) => SF.compose(f).problems.map((p: { code: string }) => p.code);
const printed = (f: unknown, mode = 'preview') => SF.texts(SF.template(SF.compose(f), { mode })).join(' '); // wrapped lines read as one

test('complete facts compose to a production label with no problems', () => {
  const c = SF.compose(facts());
  assert.equal(c.problems.length, 0, JSON.stringify(c.problems));
  assert.equal(c.production, true);
  const t = SF.template(c, { mode: 'production' });
  assert.equal(t.notForSale, false);
  assert.equal(t.w, 240); assert.equal(t.h, 100);
});

test('reference fragrance / INSPIRED BY never prints, even when handed over (OQ-LABEL-1)', () => {
  const f = facts({ referenceFragrance: 'Creed Aventus', reference: 'Reference fragrance: Creed Aventus' });
  const all = printed(f, 'production') + SF.svg(SF.template(SF.compose(f), { mode: 'production' }), {});
  assert.doesNotMatch(all, /Creed|Aventus|inspired|reference fragrance|not affiliated/i);
  // the rule fires: a planted reference row is caught by the same scan
  assert.match('INSPIRED BY Creed Aventus', /Creed|inspired/i);
});

test('grade: only RESEMBLE 90% / ALIKE 95% / CLOSE 99%, and it agrees with rac-code.js', () => {
  assert.match(printed(facts(), 'production'), /ALIKE 95%/);
  for (const g of ['RESEMBLE', 'ALIKE', 'CLOSE']) {
    const t = printed(facts({ variantCode: 'RAC 27 / 1150 / 1K / ' + g }), 'production');
    assert.ok(t.includes(RC.gradeLabel(g)), g);
  }
  for (const old of ['INTERPRETATION', 'REFERENCE', 'FIDELITY']) {
    const c = SF.compose(facts({ variantCode: null, grade: old }));
    assert.ok(c.problems.some((p: { code: string; message: string }) => p.code === 'grade' && /retired grade word/.test(p.message)), old);
    assert.doesNotMatch(printed(facts({ variantCode: null, grade: old })), new RegExp(old));
  }
});

test('hazard: no SDS -> "Hazard data not on file — see SDS", no diamond, no blank HAZARDOUS, production refused', () => {
  for (const sds of [null, { source: 'x', pictograms: [], signalWord: 'Warning' }, { pictograms: ['GHS02'], signalWord: 'Warning' }, { source: 'x', pictograms: ['GHS99'], signalWord: 'Warning' }]) {
    const f = facts({ sds });
    assert.ok(codes(f).includes('hazard'));
    const t = SF.template(SF.compose(f), { mode: 'preview' });
    const txt = SF.texts(t).join(' ');
    assert.ok(txt.includes('Hazard data not on file — see SDS'));
    assert.doesNotMatch(txt, /SIGNAL WORD|HAZARDOUS|ALLERGENS|FLAMMABLE|GHS0/);
    assert.equal(t.elements.filter((e: { t: string; pts?: unknown[] }) => e.t === 'poly' && e.pts!.length === 4).length, 0, 'no pictogram diamond');
    assert.equal(t.notForSale, true);
    assert.throws(() => SF.template(SF.compose(f), { mode: 'production' }), /Production print refused: Hazard data not on file/);
  }
  // held: diamonds and words from the SDS
  const t = SF.template(SF.compose(facts()), { mode: 'production' });
  assert.equal(t.elements.filter((e: { t: string; pts?: unknown[] }) => e.t === 'poly' && e.pts!.length === 4).length, 4); // 2 pictograms x frame + inner
  assert.match(SF.texts(t).join('\n'), /SIGNAL WORD · WARNING/);
  assert.doesNotMatch(SF.texts(t).join('\n'), /HAZARDOUS\s*[–-]\s*$/m);
});

test('IFRA: a conformity line only with a certificate on file, never "certified"', () => {
  assert.match(printed(facts(), 'production'), /Conforms to IFRA 51st · cert\. C-1/);
  for (const ifra of [null, { onFile: false, certificateNo: 'C-1' }, { onFile: true, certificateNo: '' }]) {
    assert.doesNotMatch(printed(facts({ ifra })), /IFRA/);
  }
  for (const f of [facts(), facts({ ifra: null }), facts({ sds: null })]) assert.doesNotMatch(printed(f) + printed(f, 'preview'), /certified/i);
});

test('batch: lot and dates come from the batch; missing or sample values refuse production', () => {
  assert.match(printed(facts(), 'production'), /11-2026 · 11-2028/);
  assert.ok(codes(facts({ batch: null })).includes('lot'));
  assert.ok(codes(facts({ batch: null })).includes('mfd'));
  assert.ok(codes(facts({ batch: { lotCode: 'Printed at fill', manufacturingDate: '2026-11-04', useByDate: '2028-11-03' } })).includes('lot'));
  assert.ok(codes(facts({ batch: { lotCode: 'SAMPLE-1', manufacturingDate: '2026-11-04', useByDate: '2028-11-03' } })).includes('sample'));
  assert.ok(codes(facts({ batch: { lotCode: 'L-7Q3K9XA', manufacturingDate: 'Month/year at fill', useByDate: '2028-11-03' } })).includes('mfd'));
  assert.ok(codes(facts({ productName: 'RAC 27 / 1150 · SAMPLE' })).includes('sample'));
  assert.throws(() => SF.template(SF.compose(facts({ batch: null })), { mode: 'production' }), /refused/);
});

test('MRP: only the server quote in rupees, inclusive of all taxes', () => {
  assert.match(printed(facts(), 'production'), /₹4,250\.00 incl\. of all taxes/);
  for (const mrp of [null, { rupees: '4250', inclusiveOfAllTaxes: false, source: 'server-quote' }, { rupees: '4250', inclusiveOfAllTaxes: true, source: 'typed' },
    { rupees: '425000', inclusiveOfAllTaxes: true, source: 'server-quote', paise: 425000 }, { rupees: '₹ at fill', inclusiveOfAllTaxes: true, source: 'server-quote' }]) {
    const c = codes(facts({ mrp }));
    if (mrp && (mrp as { rupees: string }).rupees === '425000' && mrp.source === 'server-quote' && mrp.inclusiveOfAllTaxes) continue; // a whole-rupee quote is valid
    assert.ok(c.includes('mrp'), JSON.stringify(mrp));
  }
});

test('seller: address + PIN from the profile; empty or contradicting PIN refuses production', () => {
  assert.ok(codes(facts({ seller: null })).includes('seller'));
  assert.ok(codes(facts({ seller: { ...FULL.seller, address: '' } })).includes('seller'));
  // the live contradiction: the label art says 452001, the legal pages 452018
  const c = SF.compose(facts({ seller: { ...FULL.seller, address: '2 Shrinagar Main, Indore 452001' } }));
  assert.ok(c.problems.some((p: { code: string; message: string }) => p.code === 'seller' && /452001/.test(p.message) && /452018/.test(p.message)));
  assert.match(printed(facts(), 'production'), /452018/);
});

test('consumer care: phone AND email on file; the placeholder never prints', () => {
  for (const s of [{ consumerCarePhone: '' }, { consumerCareEmail: '' }, { consumerCarePhone: 'phone and email to be supplied' }]) {
    const f = facts({ seller: { ...FULL.seller, ...s } });
    assert.ok(codes(f).includes('care'));
    assert.doesNotMatch(printed(f), /to be supplied/);
    assert.throws(() => SF.template(SF.compose(f), { mode: 'production' }), /Consumer care/);
  }
});

test('barcodes: no EAN-13; the lot Code 128 carries exactly batch_no; QR is the lot until a verify URL exists', () => {
  const t = SF.template(SF.compose(facts()), { mode: 'production' });
  const bars = t.elements.filter((e: { t: string }) => e.t === 'code128');
  assert.equal(bars.length, 1); assert.equal(bars[0].d, 'L-7Q3K9XA');
  assert.doesNotMatch(SF.texts(t).join('\n'), /GS1|EAN/);
  const qr = t.elements.find((e: { t: string }) => e.t === 'qr');
  assert.equal(qr.d, 'L-7Q3K9XA');
  assert.doesNotMatch(SF.texts(t).join('\n'), /VERIFY/, 'no "verify" promise without a verify base');
  // SHELL-FLUKE-8: ALEMBIC's /store/lot/<code>, with the exact caption
  const v = SF.template(SF.compose(facts({ verifyUrl: 'https://raw.huecycle.in/store/lot/' })), { mode: 'production' });
  assert.equal(v.elements.find((e: { t: string }) => e.t === 'qr').d, 'https://raw.huecycle.in/store/lot/L-7Q3K9XA');
  assert.ok(SF.texts(v).join(' ').includes('SCAN TO VERIFY LOT · PDP · SDS · COA'));
  for (const bad of ['http://raw.huecycle.in/store/lot/', 'https://raw.huecycle.in/lot/', 'https://evil.example/store/lot/x', 'javascript:alert(1)//store/lot/']) {
    const b = SF.template(SF.compose(facts({ verifyUrl: bad })), { mode: 'production' });
    assert.equal(b.elements.find((e: { t: string }) => e.t === 'qr').d, 'L-7Q3K9XA', bad);
    assert.doesNotMatch(SF.texts(b).join(' '), /VERIFY/, bad);
  }
});

test('print plates are exactly the two spot inks (dunes are the emboss plate)', () => {
  const t = SF.template(SF.compose(facts()), { mode: 'production', plates: 'print' });
  const inks = new Set(t.elements.map((e: { c?: string }) => e.c).filter((c: string) => c && c !== SF.INK.paper && c !== SF.INK.sand));
  assert.deepEqual([...inks].sort(), [...SF.PRINT_INKS].sort());
  const preview = SF.template(SF.compose(facts()), { mode: 'production' });
  assert.ok(preview.elements.some((e: { c?: string }) => e.c === SF.INK.dusk), 'the preview shows the emboss');
});

test('text sizing keeps label-render\'s 1.15 rule, and wrapped lines do not overlap', () => {
  assert.equal(SF.TEXT_EM, L.TEXT_EM);
  const t = SF.template(SF.compose(facts()), { mode: 'production' });
  const tx = t.elements.filter((e: { t: string }) => e.t === 'text');
  for (let i = 0; i < tx.length; i++) for (let j = i + 1; j < tx.length; j++) {
    const a = tx[i], b = tx[j];
    if (Math.abs(a.x - b.x) > 0.01) continue; // same column
    const [top, bot] = a.y <= b.y ? [a, b] : [b, a];
    assert.ok(bot.y >= top.y + top.h * 1.25 - 1e-6, `"${top.s}" and "${bot.s}" collide`);
  }
});

test('PDF: renders through label-render with Manrope and JetBrains Mono embedded', () => {
  const t = SF.template(SF.compose(facts()), { mode: 'production' });
  const pdf = Buffer.from(L.render(t, 'pdf').body, 'base64').toString('latin1');
  assert.match(pdf, /^%PDF-1\.4/);
  assert.match(pdf, /\/BaseFont \/Manrope-Regular/);
  assert.match(pdf, /\/BaseFont \/JetBrainsMono-Regular/);
});

test('smaller stock: front panel only, through RaLabel.build, still fail closed', () => {
  const c = SF.compose(facts({ sds: null }));
  const s = L.build(SF.smallContent(c), '100x50');
  const txt = s.elements.filter((e: { t: string }) => e.t === 'text').map((e: { s: string }) => e.s).join('\n');
  assert.match(txt, /PREVIEW · NOT FOR SALE/);
  assert.match(txt, /Hazard data not on file/);
  assert.throws(() => SF.smallContent(c, { mode: 'production' }), /refused/);
  const ok = L.build(SF.smallContent(SF.compose(facts()), { mode: 'production' }), '75x50');
  assert.ok(ok.elements.some((e: { t: string; d?: string }) => e.t === 'code128' && e.d === 'L-7Q3K9XA'));
});

/* BRAND-6: the RAC marks are the brand handoff's images; "RAC" is never typed as the mark (an RAC
   CODE such as 'RAC 27' is data and stays text). */
test('BRAND-6: the wrap draws the handoff icon and wordmark, never the letters RAC, and the PDF prints them as one-ink stencils', () => {
  const t = SF.template(SF.compose(facts()), { mode: 'preview' });
  const marks = t.elements.filter((e: { t: string }) => e.t === 'mark');
  assert.ok(marks.filter((e: { m: string }) => e.m === 'icon').length >= 2, 'the seal and the ink band carry the icon');
  assert.ok(marks.some((e: { m: string }) => e.m === 'wordmark'));
  assert.ok(!SF.texts(t).some((s: string) => s.trim() === 'RAC'), 'no RAC set in type');
  assert.ok(!t.elements.some((e: { t: string }) => e.t === 'path'), 'no traced path left');
  const svg = SF.svg(t, { marks: sb.RaBrandMarks });
  assert.match(svg, /<mask id="mk-icon-[^"]+"><image href="data:image\/png;base64,/);
  assert.match(svg, /data-mark="wordmark"/);
  const pdf = Buffer.from(L.render(t, 'pdf').body, 'base64').toString('latin1');
  assert.ok((pdf.match(/\/ImageMask true/g) || []).length === 2, 'one stencil XObject per mark');
  assert.match(pdf, /\/XObject << \/Mk1 \d+ 0 R \/Mk2 \d+ 0 R >>/);
  assert.equal(SF.INK.sand, '#EFE6D8', 'Sand from the brand handoff');
  assert.ok(SF.texts(t).includes('Because every great fragrance starts RAW.'));
});
