/**
 * Compliance-document bridge contract (owner rulings 2026-09-28) — pure, no database. Pins the
 * exact wire payloads of `qc.batch.released` and `compliance.certificate.calculated`
 * (@core/contracts bridge/compliance-events.ts, docs/bridge/EVENT_CONTRACT.md), the COA date/spec
 * arithmetic, and the no-formula-content gate every compliance payload passes before it is written
 * to the bridge outbox.
 *
 * The COA fixture is the owner's own sample (compliance-samples/Althair COA.pdf): batch A140226,
 * SG 0.995 against 0.950–1.500, flash point 116.0 °C against 110.0–120.0 °C, "Deep Brown",
 * "Warm Spicy Vanilla Fragrance", produced 14-02-2026, best before 14-02-2028 (24-month shelf life).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridge as contracts } from '@core/contracts';
import {
  addMonthsYmd,
  buildQcBatchReleasedPayload,
  failedTests,
  withinSpec,
} from '../../../cluster-production/src/coa/coa.service.js';
import { buildCertificatePayload } from '../vault-bridge/compliance-certificate-sync.service.js';
import { signBody, verifyBody } from '../bridge/signing.js';

const RELEASER = '0199a1b2-0000-7000-8000-00000000c0a1';
const DOC = '0199a1b2-0000-7000-8000-00000000d0c1';

function althairCoa(overrides: Record<string, unknown> = {}) {
  return {
    batchCoaId: '0199a1b2-0000-7000-8000-00000000b0a1', oilBatchId: '0199a1b2-0000-7000-8000-00000000b0b1',
    productId: '0199a1b2-0000-7000-8000-00000000b0c1',
    sgResult: '0.9950', sgSpecMin: '0.9500', sgSpecMax: '1.5000', sgPass: true,
    flashPointResultC: '116.0', flashPointSpecMinC: '110.0', flashPointSpecMaxC: '120.0', flashPointPass: true,
    colourAppearance: 'Deep Brown', colourAppearancePass: true,
    odourDescription: 'Warm Spicy Vanilla Fragrance', odourPass: true,
    productionDate: '2026-02-14', bestBefore: '2028-02-14', overallResult: 'PASS',
    testedBy: RELEASER, testedDt: new Date(), releasedBy: null, releasedDt: null, status: 'TESTED',
    createdDt: new Date(), updatedDt: new Date(), createdBy: null, updatedBy: null,
    ...overrides,
  } as Parameters<typeof buildQcBatchReleasedPayload>[0]['coa'];
}

const RELEASED_AT = new Date('2026-02-15T09:30:00.000Z');

/* ── COA arithmetic ─────────────────────────────────────────────────────────────────────── */

test('COA: best-before = production date + shelf life in months, clamped to month end', () => {
  assert.equal(addMonthsYmd('2026-02-14', 24), '2028-02-14'); // the Althair sample
  assert.equal(addMonthsYmd('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsYmd('2027-01-31', 13), '2028-02-29'); // leap year
  assert.equal(addMonthsYmd('2026-11-15', 3), '2027-02-15');
});

test('COA: a result on the spec boundary is in spec; outside is not', () => {
  assert.equal(withinSpec(0.95, 0.95, 1.5), true);
  assert.equal(withinSpec(1.5, 0.95, 1.5), true);
  assert.equal(withinSpec(0.9499, 0.95, 1.5), false);
  assert.equal(withinSpec(120.1, 110, 120), false);
  assert.deepEqual(failedTests({ sgPass: true, flashPointPass: false, colourAppearancePass: true, odourPass: false }), ['flash point', 'odour']);
});

/* ── qc.batch.released ──────────────────────────────────────────────────────────────────── */

test('qc.batch.released: the exact payload for the Althair sample batch', () => {
  const payload = buildQcBatchReleasedPayload({
    batchNo: 'A140226', productRef: 'ALTHAIR', skuCodes: ['ALTHAIR-25KG', 'ALTHAIR-5KG'], coa: althairCoa(),
    photos: [
      { documentId: DOC, url: null, caption: 'Retained sample', documentPath: 'https://files.example.invalid/a140226.jpg' },
      { documentId: null, url: 'https://files.example.invalid/label.jpg', caption: null, documentPath: null },
    ],
    releasedAt: RELEASED_AT, releasedBy: RELEASER, releasedByName: 'QC Analyst',
  });
  assert.deepEqual(payload, {
    batchNo: 'A140226',
    productRef: 'ALTHAIR',
    skuCodes: ['ALTHAIR-25KG', 'ALTHAIR-5KG'],
    results: [
      { test: 'specific_gravity_20_4', value: 0.995, unit: null, specMin: 0.95, specMax: 1.5, pass: true },
      { test: 'flash_point_pmcc', value: 116, unit: '°C', specMin: 110, specMax: 120, pass: true },
    ],
    colourAppearance: 'Deep Brown',
    odourDescription: 'Warm Spicy Vanilla Fragrance',
    photos: [
      { url: 'https://files.example.invalid/a140226.jpg', assetRef: `document:${DOC}`, caption: 'Retained sample' },
      { url: 'https://files.example.invalid/label.jpg', caption: null },
    ],
    productionDate: '2026-02-14',
    bestBefore: '2028-02-14',
    releasedAt: '2026-02-15T09:30:00.000Z',
    releasedBy: RELEASER,
    releasedByName: 'QC Analyst',
  });
  assert.deepEqual(contracts.validateQcBatchReleased(payload), []);
  assert.doesNotThrow(() => contracts.assertNoFormulaContent(payload));
});

test('qc.batch.released: a failed test can never validate as a release payload', () => {
  const payload = buildQcBatchReleasedPayload({
    batchNo: 'A140226', productRef: 'ALTHAIR', skuCodes: [], coa: althairCoa({ flashPointResultC: '121.0', flashPointPass: false, overallResult: 'FAIL' }),
    photos: [], releasedAt: RELEASED_AT, releasedBy: RELEASER, releasedByName: null,
  });
  assert.deepEqual(contracts.validateQcBatchReleased(payload), ['results.flash_point_pmcc.pass']);
});

/* ── compliance.certificate.calculated ──────────────────────────────────────────────────── */

const FVR = `fvr_${'0123456789abcdef'.repeat(2)}`;

test('compliance.certificate.calculated: the exact IFRA and allergen payloads', () => {
  const ifra = buildCertificatePayload({
    productRef: 'ALTHAIR', skuCodes: ['ALTHAIR-25KG'], kind: 'ifra', amendment: '51',
    values: [{ category: '1', limitPct: 0 }, { category: '4', limitPct: 25 }, { category: '12', limitPct: 100 }],
    calculatedAt: '2026-08-31T10:00:00.000Z', formulaVersionRef: FVR,
  });
  assert.deepEqual(ifra, {
    productRef: 'ALTHAIR', skuCodes: ['ALTHAIR-25KG'], kind: 'ifra', amendment: '51',
    values: [{ category: '1', limitPct: 0 }, { category: '4', limitPct: 25 }, { category: '12', limitPct: 100 }],
    calculatedAt: '2026-08-31T10:00:00.000Z', formulaVersionRef: FVR,
  });
  const allergen = buildCertificatePayload({
    productRef: 'ALTHAIR', skuCodes: [], kind: 'allergen', amendment: null,
    values: [
      { name: 'Cinnamal', cas: '104-55-2', natural: 0.02, synthetic: 'A', total: 0.02 },
      { name: 'Coumarin', cas: '91-64-5', natural: 'A', synthetic: 'A', total: 'A' },
    ],
    calculatedAt: new Date('2026-08-31T10:00:00.000Z'), formulaVersionRef: FVR,
  });
  assert.equal(allergen.kind, 'allergen');
  assert.deepEqual(Object.keys(allergen).sort(), ['amendment', 'calculatedAt', 'formulaVersionRef', 'kind', 'productRef', 'skuCodes', 'values']);
});

test('compliance.certificate.calculated: refuses formula content, a non-opaque version ref, or bad numbers', () => {
  const base = { productRef: 'ALTHAIR', skuCodes: [], kind: 'ifra', amendment: '51', calculatedAt: '2026-08-31T10:00:00.000Z', formulaVersionRef: FVR };
  assert.throws(() => buildCertificatePayload({ ...base, values: [{ category: '4', limitPct: 25, materialId: 'x' }] }), contracts.FormulaContentError);
  assert.throws(() => buildCertificatePayload({ ...base, formulaVersionRef: '0199a1b2-0000-7000-8000-00000000b0a1', values: [{ category: '4', limitPct: 25 }] }), /formulaVersionRef/);
  assert.throws(() => buildCertificatePayload({ ...base, values: [{ category: '4', limitPct: 125 }] }), /values\.4/);
  assert.throws(() => buildCertificatePayload({ ...base, values: [] }), /values/);
});

/* ── the gate itself ────────────────────────────────────────────────────────────────────── */

test('assertNoFormulaContent: any spelling, any depth', () => {
  for (const bad of [
    { material_id: 'x' }, { MaterialId: 'x' }, { nested: [{ ok: 1 }, { percentage: 3 }] }, { formula_version_id: 'x' },
    { deep: { deeper: { ingredients: [] } } }, { formulaId: 'x' }, { recipe: 'x' }, { 'formula-name': 'x' },
  ]) {
    assert.throws(() => contracts.assertNoFormulaContent(bad), contracts.FormulaContentError, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => contracts.assertNoFormulaContent({ productRef: 'P', values: [{ category: '4', limitPct: 1 }], formulaVersionRef: FVR }));
});

/* ── signature over the exact bytes ─────────────────────────────────────────────────────── */

test('the signed envelope of a compliance event verifies byte-for-byte, and a tampered one does not', () => {
  const body = JSON.stringify({
    event_id: '0199a1b2-0000-7000-8000-00000000e0e1', version: 1, type: contracts.QC_BATCH_RELEASED,
    org_id: '0199a1b2-0000-7000-8000-00000000f0f1', correlation_id: '0199a1b2-0000-7000-8000-00000000b0a1',
    causation_id: null, occurred_at: RELEASED_AT.toISOString(), source: 'rawprod',
    aggregate: { type: contracts.COMPLIANCE_AGGREGATE_TYPES[contracts.QC_BATCH_RELEASED], id: '0199a1b2-0000-7000-8000-00000000b0a1' },
    payload: { batchNo: 'A140226' },
  });
  const sig = signBody(body, 'shared-secret');
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  assert.equal(verifyBody(body, 'shared-secret', sig), true);
  assert.equal(verifyBody(body.replace('A140226', 'A140227'), 'shared-secret', sig), false);
});
