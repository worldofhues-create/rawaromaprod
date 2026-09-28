/**
 * The Vault's IFRA / allergen calculation engine (compliance-calc.ts) — pure, no database. Worked
 * examples, each number derived by hand in the comment beside it, so a reader can check the rule
 * rather than trust the code:
 *
 *   allergen % in product  = Σ (ingredient % × allergen % in ingredient) / 100, natural and
 *                            synthetic separately, total = natural + synthetic; 'A' at zero or
 *                            below the reporting threshold
 *   IFRA limit(category)   = min over restricted ingredients (max % in product / ingredient % in
 *                            fragrance × 100), capped at 100, PROHIBITED → 0, floor to 2 dp
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IFRA_CATEGORIES,
  aggregateLines,
  calculateAllergens,
  calculateIfra,
  type MaterialComplianceData,
} from '../compliance/compliance-calc.js';

const M1 = 'aaaaaaaa-0000-7000-8000-000000000001';
const M2 = 'aaaaaaaa-0000-7000-8000-000000000002';
const M3 = 'aaaaaaaa-0000-7000-8000-000000000003';

const LIMONENE = { name: 'Limonene', cas: '138-86-3' };
const LINALOOL = { name: 'Linalool', cas: '78-70-6' };
const CITRAL = { name: 'Citral', cas: '5392-40-5' };
const COUMARIN = { name: 'Coumarin', cas: '91-64-5' };
const REFS = [LIMONENE, LINALOOL, CITRAL, COUMARIN];

// Fragrance: M1 20 %, M2 30 %, M3 50 %.
const LINES = [
  { materialId: M1, percentage: 20 },
  { materialId: M2, percentage: 30 },
  { materialId: M3, percentage: 50 },
];

function data(overrides: Partial<Record<string, Partial<MaterialComplianceData>>> = {}): Map<string, MaterialComplianceData> {
  const base: Record<string, MaterialComplianceData> = {
    [M1]: {
      materialId: M1, allergenComplete: true, ifraComplete: true, ifraAmendment: '51',
      allergens: [
        { cas: LIMONENE.cas, naturalPct: 5, syntheticPct: 0 },
        { cas: LINALOOL.cas, naturalPct: 2, syntheticPct: 1 },
      ],
      ifra: [
        { category: '1', restrictionType: 'PROHIBITED', maxPct: null, amendment: '51' },
        { category: '4', restrictionType: 'RESTRICTED', maxPct: 2, amendment: '51' },
      ],
    },
    [M2]: {
      materialId: M2, allergenComplete: true, ifraComplete: true, ifraAmendment: '51',
      allergens: [
        { cas: LIMONENE.cas, naturalPct: 0, syntheticPct: 10 },
        { cas: CITRAL.cas, naturalPct: 0.01, syntheticPct: 0 },
      ],
      ifra: [
        { category: '4', restrictionType: 'RESTRICTED', maxPct: 6, amendment: '51' },
        { category: '5A', restrictionType: 'RESTRICTED', maxPct: 1.5, amendment: '51' },
        { category: '7A', restrictionType: 'RESTRICTED', maxPct: 0.5, amendment: '51' },
        { category: '12', restrictionType: 'RESTRICTED', maxPct: 100, amendment: '51' },
      ],
    },
    // Explicitly declared: no regulated allergens, not IFRA-restricted.
    [M3]: { materialId: M3, allergenComplete: true, ifraComplete: true, ifraAmendment: '51', allergens: [], ifra: [] },
  };
  const out = new Map<string, MaterialComplianceData>();
  for (const [id, d] of Object.entries(base)) {
    if (overrides[id] === null) continue;
    out.set(id, { ...d, ...(overrides[id] ?? {}) });
  }
  return out;
}

const byCas = <T extends { cas: string }>(values: T[], cas: string): T => values.find((v) => v.cas === cas)!;

/* ── allergens ──────────────────────────────────────────────────────────────────────────── */

test('allergens: Σ(ingredient % × allergen %)/100 with the natural/synthetic split and total', () => {
  const r = calculateAllergens(LINES, data(), REFS, 0);
  assert.ok(r.ok);
  // Limonene: natural 20×5/100 = 1; synthetic 30×10/100 = 3; total 4.
  assert.deepEqual(byCas(r.values, LIMONENE.cas), { ...LIMONENE, natural: 1, synthetic: 3, total: 4 });
  // Linalool: natural 20×2/100 = 0.4; synthetic 20×1/100 = 0.2; total 0.6.
  assert.deepEqual(byCas(r.values, LINALOOL.cas), { ...LINALOOL, natural: 0.4, synthetic: 0.2, total: 0.6 });
  // Citral: natural 30×0.01/100 = 0.003; nothing synthetic → 'A'.
  assert.deepEqual(byCas(r.values, CITRAL.cas), { ...CITRAL, natural: 0.003, synthetic: 'A', total: 0.003 });
});

test("allergens: a regulated allergen no ingredient contains is reported 'A' in all three columns", () => {
  const r = calculateAllergens(LINES, data(), REFS, 0);
  assert.ok(r.ok);
  assert.deepEqual(byCas(r.values, COUMARIN.cas), { ...COUMARIN, natural: 'A', synthetic: 'A', total: 'A' });
  // One row per regulated allergen, in list order — never more, never fewer.
  assert.deepEqual(r.values.map((v) => v.cas), REFS.map((x) => x.cas));
});

test("allergens: below the reporting threshold reads 'A' (compared unrounded)", () => {
  // Threshold 0.01 %: Citral 0.003 → A; Linalool synthetic 0.2 stays.
  const r = calculateAllergens(LINES, data(), REFS, 0.01);
  assert.ok(r.ok);
  assert.deepEqual(byCas(r.values, CITRAL.cas), { ...CITRAL, natural: 'A', synthetic: 'A', total: 'A' });
  assert.equal(byCas(r.values, LINALOOL.cas).synthetic, 0.2);
  // Natural 0.006 + synthetic 0.006 = 0.012: each part below 0.01 → 'A', the total above → reported.
  const lines = [{ materialId: M1, percentage: 60 }, { materialId: M3, percentage: 40 }];
  const d = data({ [M1]: { allergens: [{ cas: CITRAL.cas, naturalPct: 0.01, syntheticPct: 0.01 }] } });
  const r2 = calculateAllergens(lines, d, REFS, 0.01);
  assert.ok(r2.ok);
  assert.deepEqual(byCas(r2.values, CITRAL.cas), { ...CITRAL, natural: 'A', synthetic: 'A', total: 0.012 });
});

test('allergens: the same material on two lines is summed before multiplying', () => {
  const split = [
    { materialId: M1, percentage: 12 }, { materialId: M1, percentage: 8 },
    { materialId: M2, percentage: 30 }, { materialId: M3, percentage: 50 },
  ];
  assert.deepEqual([...aggregateLines(split)], [[M1, 20], [M2, 30], [M3, 50]]);
  assert.deepEqual(calculateAllergens(split, data(), REFS, 0), calculateAllergens(LINES, data(), REFS, 0));
});

test('allergens: a material with no profile, or data not marked complete, blocks the certificate and is named', () => {
  const noProfile = calculateAllergens(LINES, data({ [M3]: null as never }), REFS, 0);
  assert.equal(noProfile.ok, false);
  assert.ok(!noProfile.ok && noProfile.reason === 'missing_data');
  assert.deepEqual(!noProfile.ok && noProfile.missingMaterialIds, [M3]);
  const incomplete = calculateAllergens(LINES, data({ [M2]: { allergenComplete: false } }), REFS, 0);
  assert.deepEqual(!incomplete.ok && incomplete.missingMaterialIds, [M2]);
});

test('allergens: no regulated list configured → no certificate (never a fabricated list)', () => {
  const r = calculateAllergens(LINES, data(), [], 0);
  assert.ok(!r.ok && r.reason === 'not_configured');
});

/* ── IFRA ───────────────────────────────────────────────────────────────────────────────── */

const limit = (values: { category: string; limitPct: number }[], c: string) => values.find((v) => v.category === c)!.limitPct;

test('IFRA: one row per category 1..12 incl. 5A-5D, 7A/7B, 10A/10B, 11A/11B', () => {
  const r = calculateIfra(LINES, data(), '51');
  assert.ok(r.ok);
  assert.deepEqual(r.values.map((v) => v.category), [...IFRA_CATEGORIES]);
  assert.equal(r.values.length, 18);
});

test('IFRA: the limit is the MINIMUM over restricted ingredients of (max % in product / ingredient %) × 100', () => {
  const r = calculateIfra(LINES, data(), '51');
  assert.ok(r.ok);
  // Category 4: M1 2/20×100 = 10; M2 6/30×100 = 20 → min 10.
  assert.equal(limit(r.values, '4'), 10);
  // Category 5A: only M2, 1.5/30×100 = 5.
  assert.equal(limit(r.values, '5A'), 5);
});

test('IFRA: a prohibited ingredient makes its category 0 %', () => {
  const r = calculateIfra(LINES, data(), '51');
  assert.ok(r.ok);
  assert.equal(limit(r.values, '1'), 0); // M1 PROHIBITED in category 1
});

test('IFRA: capped at 100 %, unrestricted categories are 100 %, and limits are floored to 2 dp', () => {
  const r = calculateIfra(LINES, data(), '51');
  assert.ok(r.ok);
  assert.equal(limit(r.values, '12'), 100); // M2 100/30×100 = 333.3 → capped
  assert.equal(limit(r.values, '2'), 100); // nothing restricted
  assert.equal(limit(r.values, '7A'), 1.66); // M2 0.5/30×100 = 1.6666… → 1.66, never rounded up
});

test('IFRA: a specification-type standard does not change the number but is noted', () => {
  const d = data({ [M3]: { ifra: [{ category: '9', restrictionType: 'SPECIFICATION', maxPct: null, amendment: '51' }] } });
  const r = calculateIfra(LINES, d, '51');
  assert.ok(r.ok);
  assert.equal(limit(r.values, '9'), 100);
  assert.ok(r.notes.some((n) => n.includes('category 9')));
});

test('IFRA: missing data, stale amendment, or no amendment configured → no certificate', () => {
  const missing = calculateIfra(LINES, data({ [M2]: { ifraComplete: false } }), '51');
  assert.deepEqual(!missing.ok && missing.missingMaterialIds, [M2]);
  // M3 declared "not restricted" against amendment 49; amendment 51 is in force → stale → missing.
  const stale = calculateIfra(LINES, data({ [M3]: { ifraAmendment: '49' } }), '51');
  assert.deepEqual(!stale.ok && stale.missingMaterialIds, [M3]);
  const staleRow = calculateIfra(LINES, data({ [M1]: { ifra: [{ category: '4', restrictionType: 'RESTRICTED', maxPct: 2, amendment: '49' }] } }), '51');
  assert.deepEqual(!staleRow.ok && staleRow.missingMaterialIds, [M1]);
  const unconfigured = calculateIfra(LINES, data(), null);
  assert.ok(!unconfigured.ok && unconfigured.reason === 'not_configured');
});

/* ── output carries numbers only ────────────────────────────────────────────────────────── */

test('no formula content in either result: no material id, no ingredient percentage', () => {
  const a = calculateAllergens(LINES, data(), REFS, 0);
  const i = calculateIfra(LINES, data(), '51');
  assert.ok(a.ok && i.ok);
  const json = JSON.stringify([a.values, i.values, a.notes, i.notes]);
  for (const id of [M1, M2, M3]) assert.ok(!json.includes(id), 'a material id must never appear in a result');
  for (const v of a.values) assert.deepEqual(Object.keys(v).sort(), ['cas', 'name', 'natural', 'synthetic', 'total']);
  for (const v of i.values) assert.deepEqual(Object.keys(v).sort(), ['category', 'limitPct']);
});
