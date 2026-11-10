/**
 * RAC-CODES-RP-1 — the RAC code grammar and the ONE search, mirrored from ALEMBIC.
 *
 * packages/contracts/src/rac/*.ts are VERBATIM copies of ALEMBIC
 *   origin/lane/rac-codes @ f76b44a4 (2026-11-10): packages/domain/src/rac/{code,search,line,index}.ts
 * so RawProd's floor, vault, QC and label search rank and normalise exactly as the
 * storefront and the consoles do. The hashes below pin the copy: a hand edit here,
 * or a change there that was not copied, fails this file. Update both in one release.
 *
 * What else crosses the bridge, and must NOT change with the codes (doc 17 §2.5):
 *   fg.batch.received.batch_no == ALEMBIC lot.code, and `sku` == product_sku.sku_code
 *   == ALEMBIC mapped_sku. RAC codes travel BESIDE those (display + search), never in
 *   place of them (OQ-RAC-8).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  scanCode, formulaId, normaliseCode, parseRacCode, buildRacSearchIndex, searchRac, racProductLine,
} from '../../../../packages/contracts/src/rac/index.ts';

const ROOT = new URL('../../../../', import.meta.url);
const PINNED: Record<string, string> = {
  'code.ts': '67c056238683af35f2a918b28eeb95c602c4eb2202ffafb42947f178118ae7d8',
  'index.ts': '613b587ee0224a231251b8be9342009ea72dbc0b01570b9c27cd0c4a17aee4ab',
  'line.ts': '1b0f0fce64571733adaaff14bc0de7af8ad8b78a13534836445f26834761f1fc',
  'search.ts': 'a41d452ba1f267409178ea4cc615eaa79303cbcf3b9813e0f44ff1704ed937a1',
};

test('RAC: the vendored module is byte-identical to ALEMBIC f76b44a4', () => {
  for (const [f, h] of Object.entries(PINNED)) {
    const got = createHash('sha256').update(readFileSync(new URL(`packages/contracts/src/rac/${f}`, ROOT))).digest('hex');
    assert.equal(got, h, `${f} drifted from ALEMBIC`);
  }
});

/* web/label-render.js is a browser UMD; its OPAQUE_RE is read from source, not re-typed. */
const labelSrc = readFileSync(new URL('web/label-render.js', ROOT), 'utf8');
const OPAQUE_RE = new RegExp(/OPAQUE_RE\s*=\s*\/(.+?)\/;/.exec(labelSrc)![1]!);

test('RAC: every code shape scans on a label (OPAQUE_RE) and fits RawProd varchar(50)', () => {
  for (const c of ['RAC 27 / 1150', 'RAC 27 / 1150 / 1K / ALIKE', 'RAC 09 / 1001 / 1P5ML / RESEMBLE', 'RAC 27 / 1150 / ALIKE / F12']) {
    assert.match(scanCode(c), OPAQUE_RE, c);
    assert.ok(c.length <= 50, `${c} fits material_code / formula_code / sku_code`);
    assert.equal(normaliseCode(scanCode(c)), normaliseCode(c), 'scan form and display form search alike');
  }
  assert.equal(formulaId('RAC 27 / 1150', 'ALIKE', 3), 'RAC 27 / 1150 / ALIKE / F3');
  assert.equal(parseRacCode('RAC 27 / 1150 / ALIKE / F3')!.version, 3);
  assert.equal(formulaId('RAC 60 / 1032', 'MATERIAL', 1), null, 'a bought-in material has no formula');
});

const SAMPLE = [
  { code: 'RAC 15 / 1007', category: 'Oil', name: 'RAC Aventus', reference_fragrance: 'Creed Aventus', accords: ['Fruity'], grades: ['RESEMBLE', 'ALIKE', 'CLOSE'],
    old_primary: 'RAC40-01437', old_rac_code: 'RAC / 40 · 01437', shopify_handle: 'creed-aventus', default_variant: 'RAC 15 / 1007 / 5K / RESEMBLE',
    variants: [
      { code: 'RAC 15 / 1007 / 5K / RESEMBLE', pack: '5K', grade: 'RESEMBLE', old_rac_sku: 'RAC40-01437-INT-5K', shopify_sku: 'creed-aventus-INSPIRED-5kg', default: true },
      { code: 'RAC 15 / 1007 / 1K / ALIKE', pack: '1K', grade: 'ALIKE', old_rac_sku: 'RAC40-01437-REF-1K', shopify_sku: 'creed-aventus-IDENTICAL-1kg', old_grade: 'IDENTICAL' },
    ] },
  { code: 'RAC 60 / 1032', category: 'Aromachemical', name: 'RAC Ambergris', accords: [], grades: [], old_primary: 'RAC10-00031',
    variants: [{ code: 'RAC 60 / 1032 / 1K / MATERIAL', pack: '1K', grade: 'MATERIAL', old_rac_sku: 'RAC10-00031-MAT-1K', default: true }] },
];

test('RAC: RawProd search finds new codes, old codes, old grade words, and typos', () => {
  const ix = buildRacSearchIndex(SAMPLE, { scope: 'console' });
  assert.equal(searchRac(ix, 'RAC 15 / 1007')[0]!.code, 'RAC 15 / 1007');
  assert.equal(searchRac(ix, 'RAC151007')[0]!.code, 'RAC 15 / 1007');
  assert.equal(searchRac(ix, 'RAC40-01437')[0]!.code, 'RAC 15 / 1007', 'old code stays searchable');
  assert.equal(searchRac(ix, 'RAC40-01437-REF-1K')[0]!.variant, 'RAC 15 / 1007 / 1K / ALIKE');
  assert.equal(searchRac(ix, 'aventus identical')[0]!.grade, 'ALIKE');
  assert.equal(searchRac(ix, 'ambergirs')[0]!.code, 'RAC 60 / 1032');
});

test('RAC: a label carries code + grade, never the reference fragrance, never a legacy key', () => {
  const line = racProductLine(SAMPLE[0]!, { surface: 'label', referenceCleared: true, variant: 'RAC 15 / 1007 / 1K / ALIKE' });
  assert.equal(line.reference, null);
  assert.equal(line.variantCode, 'RAC 15 / 1007 / 1K / ALIKE');
  assert.equal(line.grade, 'ALIKE 95%');
  assert.equal((line as { legacy?: unknown }).legacy, undefined);
  /* The label convention (OQ-RAC-12): the PRODUCT code on its own line and pack + grade on the
     next. A full variant code is ~30 characters and the renderer truncates a line at the
     label's width (it did, at 100x50: 'Code: RAC 15 / 1007 …'). */
  /* A browser UMD in a "type": "module" tree: evaluated with its own `module`. */
  const umd = (src: string, req?: (p: string) => unknown) => { const m = { exports: {} as unknown }; new Function('module', 'exports', 'require', src)(m, m.exports, req); return m.exports; };
  const qr = umd(readFileSync(new URL('web/qrcode.js', ROOT), 'utf8'));
  const mod = { exports: umd(labelSrc, () => qr) };
  const LR = mod.exports as unknown as { SIZES: Record<string, unknown>; build: (c: unknown, s: string) => unknown; render: (t: unknown, l: string) => { body: string } };
  const out = LR.render(LR.build({ title: line.name, lines: [['Code', line.code], ['Grade', `1K · ${line.grade}`]], code: 'B-2611-0007' }, '100x50'), 'html');
  assert.ok(!/Hue Cycle/i.test(out.body), 'no Hue Cycle footer');
  assert.ok(out.body.includes('Manrope'), 'Manrope on labels');
  assert.ok(/JetBrains Mono[^>]*>Code: RAC 15 \/ 1007</.test(out.body.replace(/&#39;/g, "'")), 'the RAC code in JetBrains Mono');
  assert.ok(!out.body.includes('Creed'), 'no trademark on a pack');
  assert.ok(out.body.includes('data-code128="B-2611-0007"'), 'the barcode still encodes the batch number, not the RAC code');
});

/* RAC-CODES-RP-2: the browser display helper (web/rac-code.js) agrees with the pinned module,
   the vault names RAC formula versions F{n}, and material search ranks with the one search. */
const umdLoad = (rel: string) => { const m = { exports: {} as unknown }; new Function('module', 'exports', readFileSync(new URL(rel, ROOT), 'utf8'))(m, m.exports); return m.exports as Record<string, (...a: unknown[]) => unknown>; };

test('RAC: floor/QC display helper agrees with the pinned module', () => {
  const RC = umdLoad('web/rac-code.js');
  for (const c of ['RAC 27 / 1150', 'RAC 27 / 1150 / 1K / ALIKE', 'RAC 60 / 1032 / 1K / MATERIAL', 'DEMO-MAT-0001', 'RAC40-01437-REF-1K']) {
    const a = RC.parse!(c) as { product?: string; grade?: string } | null;
    const b = parseRacCode(c);
    assert.equal(a?.product ?? null, b?.product ?? null, c);
    assert.equal(a?.grade ?? null, b?.grade ?? null, c);
    assert.equal(RC.normalise!(c), normaliseCode(c), c);
  }
  assert.equal(RC.line!('RAC 27 / 1150', 'RAC 27 / 1150 / 1K / ALIKE'), 'RAC 27 / 1150 · 1K · ALIKE 95%');
  assert.equal(RC.line!('DEMO-PRD-1', 'DEMO-SKU-1'), 'DEMO-PRD-1 · DEMO-SKU-1', 'a non-RAC code passes through untouched');
  assert.equal(RC.version!('RAC 27 / 1150 / ALIKE', 3), formulaId('RAC 27 / 1150', 'ALIKE', 3));
  assert.equal(RC.version!('DEMO-FRM-001', 3), 'v3');
  const vault = readFileSync(new URL('web-vault/vault.js', ROOT), 'utf8');
  const racVersion = new Function(/(function racVersion[\s\S]*?\n {2}\})/.exec(vault)![1] + '; return racVersion;')() as (c: string, n: number) => string;
  assert.equal(racVersion('RAC 27 / 1150 / ALIKE', 3), 'RAC 27 / 1150 / ALIKE / F3');
  assert.equal(racVersion('DEMO-FRM-001', 2), 'v2');
});

test('RAC: material search ranks with the one search -- code spellings, old codes as aliases, typos', async () => {
  const { rankMaterials } = await import('../../../cluster-masterdata/src/rank-materials.ts');
  const rows = [
    { materialId: 'a', materialCode: 'RAC 60 / 1032', materialName: 'RAC Ambergris', uomId: null },
    { materialId: 'b', materialCode: 'RAC 84 / 1002', materialName: 'RAC DEP (Di Ethyl Pthalate)', uomId: null },
    { materialId: 'c', materialCode: 'DEMO-MAT-0001', materialName: 'Demo Citrus Accord 01', uomId: null },
  ];
  const aliases = [{ materialId: 'a', aliasName: 'RAC10-00031' }];
  const top = (q: string) => rankMaterials(rows as never, aliases, q, 5)[0]?.materialId;
  assert.equal(top('RAC601032'), 'a');
  assert.equal(top('RAC-60-1032'), 'a');
  assert.equal(top('RAC10-00031'), 'a', 'old code via rm_alias');
  assert.equal(top('ambergirs'), 'a', 'typo');
  assert.equal(top('pthalate'), 'b');
  assert.equal(top('DEMO-MAT-0001'), 'c', 'non-RAC codes still exact');
});
