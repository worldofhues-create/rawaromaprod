#!/usr/bin/env node
/* SHELL-FLUKE-3: render the Shell Fluke previews -- one product with every fact on file, one whose
 * hazard data is not held -- as HTML (SVG), PDF (label-render.js, embedded Manrope + JetBrains Mono)
 * and, with --png, PNG through headless Chrome.
 *   node tools/labels/shell-fluke-preview.mjs docs/brand/shots/shell-fluke [--png]
 * The facts below are PREVIEW FIXTURES, not records: the seller, care line and MRP are
 * obviously synthetic (example.invalid, a 555 number) so a preview can never pass for a pack. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(process.argv[2] || 'docs/brand/shots/shell-fluke');
mkdirSync(out, { recursive: true });
const sb = { Buffer };
for (const f of ['web/qrcode.js', 'web/label-pdf-font.js', 'web/label-render.js', 'web/shell-fluke.js']) runInNewContext(readFileSync(join(ROOT, f), 'utf8'), sb);
const L = sb.RaLabel, SF = sb.ShellFluke;

const seller = { name: 'RAW AROMACHEM (PREVIEW)', address: '1 Preview Road, Indore, Madhya Pradesh', pin: '452000',
  consumerCarePhone: '+91 00000 00000', consumerCareEmail: 'care@preview.invalid', country: 'India' };
const full = {
  productName: 'Ambergris Sand', accords: ['Amber', 'Woody', 'Floral'], productCode: 'RAC 27 / 1150', variantCode: 'RAC 27 / 1150 / 1K / ALIKE',
  genericName: 'Fragrance compound', packSize: '1 kg', netQuantity: { value: '1', unit: 'kg' },
  batch: { lotCode: 'L-7Q3K9XA', manufacturingDate: '2026-11-04', useByDate: '2028-11-03' },
  mrp: { rupees: '4,250.00', inclusiveOfAllTaxes: true, source: 'server-quote' },
  sds: { source: 'SDS rev 3 (preview fixture)', pictograms: ['GHS02', 'GHS07'], signalWord: 'Warning',
    precautionary: 'Keep away from heat and open flame. Avoid contact with skin and eyes. Keep out of reach of children.',
    hazardStatements: 'H226 H317', allergens: ['Linalool', 'Limonene', 'Coumarin'], flammable: true },
  ifra: { onFile: true, certificateNo: 'IFRA-PREVIEW-0001', amendment: '51st' },
  seller,
  referenceFragrance: 'Creed Aventus', // handed over on purpose: it must NOT print (OQ-LABEL-1)
};
const unclassified = { ...full, productName: 'Vetiver Haze', accords: ['Woody', 'Earthy'], productCode: 'RAC 31 / 2204', variantCode: 'RAC 31 / 2204 / 250G / CLOSE',
  packSize: '250 g', netQuantity: { value: '250', unit: 'g' }, sds: null, ifra: null, batch: { lotCode: 'L-4M8T2RD', manufacturingDate: '2026-11-06', useByDate: '2028-11-05' } };

function page(svgs, title, w, h) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="${join(ROOT, 'web/ui-contract/fonts/type.css')}">
<style>@page{size:${w}mm ${h}mm;margin:0}body{margin:0;background:#fff}svg{display:block}</style>${svgs}`;
}
const deps = { code128Bars: L.code128Bars, qrMatrix: L.qrMatrix };
const made = [];
for (const [slug, facts] of [['full-data', full], ['hazmat-unclassified', unclassified]]) {
  const c = SF.compose(facts);
  const t = SF.template(c, { mode: 'preview' });
  writeFileSync(join(out, `${slug}.wrap.html`), page(SF.svg(t, deps), slug, t.w, t.h));
  writeFileSync(join(out, `${slug}.wrap.pdf`), Buffer.from(L.render(t, 'pdf').body, 'base64'));
  const plates = SF.template(c, { mode: 'preview', plates: 'print' });
  writeFileSync(join(out, `${slug}.plates.pdf`), Buffer.from(L.render(plates, 'pdf').body, 'base64'));
  const small = L.build(SF.smallContent(c), '100x50');
  writeFileSync(join(out, `${slug}.front-100x50.html`), page(L.render(small, 'html').body, slug, 100, 50));
  writeFileSync(join(out, `${slug}.front-100x50.pdf`), Buffer.from(L.render(small, 'pdf').body, 'base64'));
  made.push({ slug, production: c.production, problems: c.problems.map((p) => p.code) });
}
const cap = SF.capStrip();
writeFileSync(join(out, 'cap-strip.html'), page(SF.svg(cap, deps), 'cap', cap.w, cap.h));
console.log(JSON.stringify(made));

if (process.argv.includes('--png')) {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const shots = [['full-data.wrap', 240, 100], ['hazmat-unclassified.wrap', 240, 100], ['full-data.front-100x50', 100, 50], ['hazmat-unclassified.front-100x50', 100, 50], ['cap-strip', 40, 8]];
  for (const [n, wmm, hmm] of shots) {
    // the window in CSS px is the label in mm at 96 dpi; scale 3 gives ~11 px per mm
    const px = (mm) => Math.ceil(mm * 96 / 25.4);
    execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', `--window-size=${px(wmm)},${px(hmm)}`,
      '--force-device-scale-factor=3', '--virtual-time-budget=3000', `--screenshot=${join(out, n + '.png')}`, 'file://' + join(out, n + '.html')], { stdio: 'ignore' });
  }
}
