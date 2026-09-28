/**
 * Lane produce — the bridge contract, pure (no database):
 *
 *   requirement   the fields ALEMBIC (lane/fulfil) adds to ProductionRequirementCreated/Changed —
 *                 priority {rank, reason, order_value_inr}, needed_by, order_refs, sku, pack_size,
 *                 qty_kg, lot_policy 'fifo' — validated (a bad one is a PERMANENT refusal) and
 *                 normalized onto the requirement row; the v1 shape still works unchanged.
 *   fg.batch.received   exactly {batch_no, sku, pack_size, qty_kg, rack, released_at}; kg from the
 *                 unit or the pack size; refused (never guessed) when neither is a mass.
 *   DOCS-001      qc.batch.released (both verdicts) and compliance.certificate.calculated as RawProd
 *                 emits them, run through ALEMBIC's OWN parsers (test-support/alembic-docs001.ts,
 *                 copied verbatim) — accepted; and a failed verdict is refused for a COA there.
 *   queue         stage + counters; the printed location label; the pick-light wire + signature.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridge as contracts } from '@core/contracts';
import { validateInboundPayload, normalizeRequirementPayload } from '../bridge/contract.js';
import { buildFgBatchReceived } from '../shelf/shelf-task.service.js';
import { colourFor, SIMULATOR_KEY, type PickLightCommand } from '../shelf/pick-light.service.js';
import { signBody, verifyBody } from '../bridge/signing.js';
import { buildQcBatchReleasedPayload } from '../../../cluster-production/src/coa/coa.service.js';
import { buildCertificatePayload, buildCertificateWire } from '../vault-bridge/compliance-certificate-sync.service.js';
import { queueStage, countersOf, type QueueRow } from '../../../cluster-production/src/produce/produce-queue.service.js';
import { parseQcBatchReleased, coaEligibility, parseCertificateCalculated } from '../../../test-support/alembic-docs001.js';

/* ── requirement fields ─────────────────────────────────────────────────────────────────── */

const NEW_SHAPE = {
  requirement_id: '0199a1b2-0000-7000-8000-000000000001',
  priority: { rank: 1, reason: 'high_value', order_value_inr: 48500 },
  needed_by: '2026-10-05',
  order_refs: ['SO-1001', 'SO-1007'],
  sku: 'ALTHAIR-25KG',
  pack_size: '25 kg',
  qty_kg: 75,
  lot_policy: 'fifo',
};

test('requirement: the new-contract payload alone is a valid ProductionRequirementCreated', () => {
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', NEW_SHAPE), []);
  assert.deepEqual(normalizeRequirementPayload(NEW_SHAPE), {
    orderRefs: ['SO-1001', 'SO-1007'], orderRef: 'SO-1001', mappedSku: 'ALTHAIR-25KG', qtyKg: '75', qty: '75', uom: 'kg',
    packSize: '25 kg', neededBy: '2026-10-05', priority: 'high_value', priorityRank: 1, priorityReason: 'high_value',
    orderValueInr: '48500', lotPolicy: 'fifo',
  });
});

test('requirement: v1 fields stay authoritative when both are sent; the v1 shape still validates', () => {
  const both = { ...NEW_SHAPE, order_ref: 'SO-1001', mapped_sku: 'ALTHAIR-25KG', qty: '75000000', uom: 'mg' };
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', both), []);
  const n = normalizeRequirementPayload(both);
  assert.equal(n.qty, '75000000');
  assert.equal(n.uom, 'mg');
  assert.equal(n.qtyKg, '75');
  const v1 = { requirement_id: 'x', order_ref: 'SO-1', mapped_sku: 'SKU-1', qty: 10, uom: 'kg', needed_by: '2026-10-01', priority: 'urgent' };
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', v1), []);
  assert.equal(normalizeRequirementPayload(v1).priority, 'urgent');
  assert.equal(normalizeRequirementPayload(v1).priorityRank, undefined);
});

test('requirement: every malformed new field is a named, permanent refusal', () => {
  const bad = (patch: Record<string, unknown>) => validateInboundPayload('ProductionRequirementCreated', { ...NEW_SHAPE, ...patch });
  assert.deepEqual(bad({ priority: { rank: 1, reason: 'vip', order_value_inr: 1 } }), ['priority:invalid']);
  assert.deepEqual(bad({ priority: { rank: -1, reason: 'fifo', order_value_inr: 1 } }), ['priority:invalid']);
  assert.deepEqual(bad({ priority: { rank: 1.5, reason: 'fifo', order_value_inr: 1 } }), ['priority:invalid']);
  assert.deepEqual(bad({ priority: { rank: 1, reason: 'fifo', order_value_inr: '48500' } }), ['priority:invalid']);
  assert.deepEqual(bad({ priority: { rank: 1, reason: 'fifo' } }), ['priority:invalid']);
  assert.deepEqual(bad({ lot_policy: 'lifo' }), ['lot_policy:invalid']);
  assert.deepEqual(bad({ order_refs: [] }), ['order_refs:invalid']);
  assert.deepEqual(bad({ order_refs: ['SO-1', ''] }), ['order_refs:invalid']);
  assert.deepEqual(bad({ qty_kg: 0 }), ['qty_kg:invalid']);
  assert.deepEqual(bad({ needed_by: '05/10/2026' }), ['needed_by:invalid']);
  // Nothing to take the order ref / SKU / quantity from → the v1 field is reported missing.
  const { order_refs: _o, sku: _s, qty_kg: _q, ...bare } = NEW_SHAPE;
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', bare), ['order_ref:missing', 'mapped_sku:missing', 'qty:missing', 'uom:missing']);
  // Changed: the new fields are optional but checked.
  assert.deepEqual(validateInboundPayload('ProductionRequirementChanged', { priority: { rank: 3, reason: 'promised_date', order_value_inr: 900 } }), []);
  assert.deepEqual(validateInboundPayload('ProductionRequirementChanged', { lot_policy: 'lifo' }), ['lot_policy:invalid']);
});

test('high value: ALEMBIC said so, or the order is ₹25,000 or more (owner decision 2026-09-29)', () => {
  assert.equal(contracts.HIGH_VALUE_THRESHOLD_INR, 25000);
  assert.equal(contracts.isHighValue('high_value', 10), true);
  assert.equal(contracts.isHighValue('fifo', 25000), true);
  assert.equal(contracts.isHighValue('fifo', '24999.99'), false);
  assert.equal(contracts.isHighValue(null, null), false);
});

/* ── fg.batch.received ──────────────────────────────────────────────────────────────────── */

test('fg.batch.received: exactly the six fields; kg from the pack size when the unit is a count', () => {
  const r = buildFgBatchReceived({ batchNo: 'FG-A140226', sku: 'ALTHAIR-25KG', packSize: '25 kg', qty: 4, uomCode: 'DRUM',
    rack: 'R01-S2-B3', releasedAt: '2026-02-15T09:30:00.000Z' });
  assert.ok(r.ok);
  assert.deepEqual(r.payload, { batch_no: 'FG-A140226', sku: 'ALTHAIR-25KG', pack_size: '25 kg', qty_kg: 100, rack: 'R01-S2-B3', released_at: '2026-02-15T09:30:00.000Z' });
  assert.deepEqual(Object.keys(r.payload).sort(), ['batch_no', 'pack_size', 'qty_kg', 'rack', 'released_at', 'sku']);
  assert.deepEqual(contracts.validateFgBatchReceived(r.payload), []);
  assert.doesNotThrow(() => contracts.assertNoFormulaContent(r.payload));
});

test('fg.batch.received: a mass unit converts; a count with no mass pack size is refused, never guessed', () => {
  const g = buildFgBatchReceived({ batchNo: 'B', sku: 'S', packSize: null, qty: 2500, uomCode: 'g', rack: 'A-1', releasedAt: '2026-02-15T09:30:00.000Z' });
  assert.ok(g.ok && g.payload.qty_kg === 2.5 && g.payload.pack_size === null);
  const kg = buildFgBatchReceived({ batchNo: 'B', sku: 'S', packSize: '5 kg', qty: 12.5, uomCode: 'KG', rack: 'A-1', releasedAt: '2026-02-15T09:30:00.000Z' });
  assert.ok(kg.ok && kg.payload.qty_kg === 12.5, 'a batch counted in kg is not multiplied by its pack');
  const bad = buildFgBatchReceived({ batchNo: 'B', sku: 'S', packSize: '1 carton', qty: 3, uomCode: 'EA', rack: 'A-1', releasedAt: '2026-02-15T09:30:00.000Z' });
  assert.equal(bad.ok, false);
  const noRelease = buildFgBatchReceived({ batchNo: 'B', sku: 'S', packSize: '5 kg', qty: 1, uomCode: 'EA', rack: 'A-1', releasedAt: null });
  assert.equal(noRelease.ok, false);
  assert.equal(contracts.packSizeKg('0.5 Kg'), 0.5);
  assert.equal(contracts.packSizeKg('500g'), 0.5);
  assert.equal(contracts.packSizeKg('25KG'), 25);
  assert.equal(contracts.packSizeKg('1 litre'), null);
});

/* ── DOCS-001 through ALEMBIC's own parser ──────────────────────────────────────────────── */

function althairCoa(overrides: Record<string, unknown> = {}) {
  return {
    batchCoaId: '0199a1b2-0000-7000-8000-00000000b0a1', oilBatchId: '0199a1b2-0000-7000-8000-00000000b0b1',
    productId: '0199a1b2-0000-7000-8000-00000000b0c1',
    sgResult: '0.9950', sgSpecMin: '0.9500', sgSpecMax: '1.5000', sgPass: true,
    flashPointResultC: '116.0', flashPointSpecMinC: '110.0', flashPointSpecMaxC: '120.0', flashPointPass: true,
    colourAppearance: 'Deep Brown', colourAppearancePass: true,
    odourDescription: 'Warm Spicy Vanilla Fragrance', odourPass: true,
    productionDate: '2026-02-14', bestBefore: '2028-02-14', overallResult: 'PASS',
    testedBy: null, testedDt: new Date(), releasedBy: null, releasedDt: null, rejectedBy: null, rejectedDt: null, rejectReason: null,
    status: 'TESTED', createdDt: new Date(), updatedDt: new Date(), createdBy: null, updatedBy: null,
    ...overrides,
  } as Parameters<typeof buildQcBatchReleasedPayload>[0]['coa'];
}

function wire(status: 'passed' | 'failed', coa = althairCoa(), photos: Parameters<typeof buildQcBatchReleasedPayload>[0]['photos'] = []) {
  const internal = buildQcBatchReleasedPayload({
    batchNo: 'A140226', productRef: 'ALTHAIR', skuCodes: ['ALTHAIR-25KG'], coa, photos,
    releasedAt: new Date('2026-02-15T09:00:00.000Z'), releasedBy: 'u', releasedByName: null,
  });
  return contracts.toQcBatchReleasedWire(internal, {
    status, factorySku: 'ALTHAIR-25KG', qcRecordRef: 'QC-2026-0412',
    colourAppearancePass: coa.colourAppearancePass, odourPass: coa.odourPass,
  });
}

test('qc.batch.released: the Althair sample is exactly COMPLIANCE_FACTS.md\'s example and ALEMBIC accepts it and would issue a COA', () => {
  const w = wire('passed', althairCoa(), [
    { documentId: null, url: 'https://files.example.invalid/qc/A140226/sg.jpg', caption: null, documentPath: null },
    { documentId: null, url: 'http://insecure.example.invalid/x.jpg', caption: null, documentPath: null }, // not https → dropped
  ]);
  assert.deepEqual(w, {
    batch_no: 'A140226',
    product_ref: { factory_sku: 'ALTHAIR-25KG' },
    status: 'passed',
    results: [
      { key: 'odour', label: 'Odour description', value: 'Warm Spicy Vanilla Fragrance', pass: true },
      { key: 'colour_appearance', label: 'Colour and appearance', value: 'Deep Brown', pass: true },
      { key: 'specific_gravity', label: 'Specific Gravity at 20/4°C', value: '0.995', unit: null, method: null, spec: { min: '0.950', max: '1.500' }, pass: true },
      { key: 'flash_point', label: 'Zero Reference Flash Point', value: '116.0', unit: '°C', method: 'Pensky-Martens, closed cup', spec: { min: '110.0', max: '120.0' }, pass: true },
    ],
    photos: [{ url: 'https://files.example.invalid/qc/A140226/sg.jpg', asset_ref: null, caption: null, result_key: null }],
    production_date: '2026-02-14',
    best_before: '2028-02-14',
    released_at: '2026-02-15T09:00:00.000Z',
    qc_record_ref: 'QC-2026-0412',
  });
  assert.deepEqual(contracts.checkQcBatchReleasedWire(w), []);
  const parsed = parseQcBatchReleased(w);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(coaEligibility(parsed.release, 'A140226'), { ok: true });
  assert.doesNotThrow(() => contracts.assertNoFormulaContent(w));
});

test('qc.batch.released: a FAILED verdict is accepted by ALEMBIC and makes it refuse the COA', () => {
  const w = wire('failed', althairCoa({ flashPointResultC: '121.5', flashPointPass: false, overallResult: 'FAIL' }));
  assert.equal(w.status, 'failed');
  assert.deepEqual(contracts.checkQcBatchReleasedWire(w), []);
  const parsed = parseQcBatchReleased(w);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.equal(coaEligibility(parsed.release, 'A140226').ok, false);
  // RawProd never sends a "passed" verdict that contradicts its own numbers.
  const contradiction = wire('passed', althairCoa({ flashPointResultC: '121.5', flashPointPass: true }));
  assert.ok(contracts.checkQcBatchReleasedWire(contradiction).includes('results.flash_point.above_spec'));
});

test('compliance.certificate.calculated: IFRA and allergen wires parse on ALEMBIC; formula_version is the number, the ref is opaque', () => {
  const FVR = `fvr_${'0123456789abcdef'.repeat(2)}`;
  const ifra = buildCertificatePayload({
    productRef: 'ALTHAIR', skuCodes: ['ALTHAIR-25KG'], kind: 'ifra', amendment: '51st',
    values: contracts.IFRA_CATEGORY_CODES.map((category) => ({ category, limitPct: category === '4' ? 25 : category === '1' ? 0 : 100 })),
    calculatedAt: '2026-08-31T10:00:00.000Z', formulaVersionRef: FVR,
  });
  const iw = buildCertificateWire(ifra, ['ALTHAIR-25KG'], 3);
  assert.equal(iw.formula_version, 3);
  assert.deepEqual(iw.product_ref, { factory_sku: 'ALTHAIR-25KG' });
  const pi = parseCertificateCalculated(iw);
  assert.ok(pi.ok, JSON.stringify(pi));
  assert.equal(pi.calc.ifra!.limits['4'], '25.00');
  assert.equal(pi.calc.ifra!.limits['12'], '100');

  const allergen = buildCertificatePayload({
    productRef: 'ALTHAIR', skuCodes: ['ALTHAIR-25KG'], kind: 'allergen', amendment: null,
    values: contracts.EU_ALLERGEN_CAS_26.map((cas) => (cas === '104-55-2'
      ? { name: 'Cinnamal', cas, natural: 0.02, synthetic: 'A' as const, total: 0.02 }
      : { name: cas, cas, natural: 'A' as const, synthetic: 'A' as const, total: 'A' as const })),
    calculatedAt: '2026-08-31T10:00:00.000Z', formulaVersionRef: FVR,
  });
  const aw = buildCertificateWire(allergen, ['ALTHAIR-25KG'], 3);
  const pa = parseCertificateCalculated(aw);
  assert.ok(pa.ok, JSON.stringify(pa));
  assert.deepEqual(pa.calc.allergen!.rows.find((r) => r.cas === '104-55-2'), { cas: '104-55-2', natural: '0.02', synthetic: 'A', total: '0.02' });
  assert.throws(() => buildCertificateWire(ifra, [], 3), contracts.CertificateWireError);
  assert.throws(() => buildCertificateWire(ifra, ['X'], null), contracts.CertificateWireError);
});

test('aggregate types: qc_batch for a QC verdict, product for a calculation, fg_batch for a put-away', () => {
  assert.equal(contracts.COMPLIANCE_AGGREGATE_TYPES['qc.batch.released'], 'qc_batch');
  assert.equal(contracts.COMPLIANCE_AGGREGATE_TYPES['compliance.certificate.calculated'], 'product');
  assert.equal(contracts.FG_BATCH_AGGREGATE_TYPE, 'fg_batch');
});

/* ── queue, location label, pick-light ──────────────────────────────────────────────────── */

test('queue stage: where a requirement stands, from its run, QC and shelf', () => {
  const base = { lifecycle_status: 'ACCEPTED', produce_block_reason: null, production_order_id: null, run_status: null,
    oil_batch_id: null, coa_status: null, coa_result: null, fg_batch_id: null, rack: null };
  assert.equal(queueStage(base), 'TO_PLAN');
  assert.equal(queueStage({ ...base, produce_block_reason: 'NO_APPROVED_FORMULA' }), 'BLOCKED');
  assert.equal(queueStage({ ...base, lifecycle_status: 'REJECTED_MAPPING' }), 'UNKNOWN_SKU');
  const run = { ...base, production_order_id: 'o', run_status: 'PLANNING' };
  assert.equal(queueStage(run), 'PLANNED');
  assert.equal(queueStage({ ...run, run_status: 'INPROGRESS' }), 'IN_PRODUCTION');
  assert.equal(queueStage({ ...run, oil_batch_id: 'b' }), 'QC_PENDING');
  assert.equal(queueStage({ ...run, oil_batch_id: 'b', coa_status: 'TESTED', coa_result: 'FAIL' }), 'QC_FAILED');
  assert.equal(queueStage({ ...run, oil_batch_id: 'b', coa_status: 'REJECTED', coa_result: 'PASS' }), 'QC_FAILED');
  assert.equal(queueStage({ ...run, oil_batch_id: 'b', coa_status: 'TESTED', coa_result: 'PASS' }), 'QC_PASSED');
  assert.equal(queueStage({ ...run, oil_batch_id: 'b', coa_status: 'RELEASED' }), 'QC_RELEASED');
  assert.equal(queueStage({ ...run, oil_batch_id: 'b', coa_status: 'RELEASED', fg_batch_id: 'f' }), 'READY_FOR_PUTAWAY');
  assert.equal(queueStage({ ...run, oil_batch_id: 'b', coa_status: 'RELEASED', fg_batch_id: 'f', rack: 'R1-S1-B1' }), 'ON_SHELF');
});

test('counters: open, kg still to produce, overdue, high value, blocked', () => {
  const row = (p: Partial<QueueRow>): QueueRow => ({
    alembicRequirementId: 'x', position: 1, orderRef: 'SO', orderRefs: ['SO'], sku: 'S', packSize: null, productCode: null,
    qty: '10', uom: 'kg', qtyKg: 10, neededBy: '', receivedAt: '', priorityRank: null, priorityReason: null, orderValueInr: null,
    lotPolicy: null, highValue: false, overdue: false, lifecycleStatus: 'ACCEPTED', stage: 'TO_PLAN', blockReason: null,
    blockMessage: null, productionOrderId: null, runStatus: null, runQty: null, formula: null, batchNo: null, qcStatus: null,
    fgBatchId: null, rack: null, ...p,
  });
  const c = countersOf([
    row({ highValue: true, overdue: true }),
    row({ stage: 'BLOCKED', qtyKg: 5 }),
    row({ stage: 'ON_SHELF', qtyKg: 100, highValue: true }),
    row({ lifecycleStatus: 'REJECTED_MAPPING', stage: 'UNKNOWN_SKU', qtyKg: 7 }),
  ]);
  assert.deepEqual(c, { open: 3, kgToProduce: 15, overdue: 1, highValue: 1, blocked: 1, toPlan: 1, qcFailed: 0, readyForPutaway: 0 });
});

test('location label: rack-shelf-bin, a code that carries its parent\'s is not repeated', () => {
  assert.equal(contracts.locationLabel('R01', 'R01-S2', 'R01-S2-B3'), 'R01-S2-B3');
  assert.equal(contracts.locationLabel('A', '2', '7'), 'A-2-7');
  assert.equal(contracts.locationLabel('R01', null, null), 'R01');
  assert.equal(contracts.locationLabel(null, null, null), null);
});

test('pick-light: exactly {task_id, rack, shelf, bin, qty, colour}, HMAC-signed over the raw body', () => {
  const cmd: PickLightCommand = { task_id: '0199a1b2-0000-7000-8000-000000000009', rack: 'R01', shelf: 'R01-S2', bin: 'R01-S2-B3', qty: 4, colour: colourFor('PUTAWAY') };
  assert.deepEqual(Object.keys(cmd).sort(), ['bin', 'colour', 'qty', 'rack', 'shelf', 'task_id']);
  assert.equal(colourFor('PUTAWAY'), 'blue');
  assert.equal(colourFor('PICK'), 'green');
  const raw = JSON.stringify(cmd);
  const sig = signBody(raw, SIMULATOR_KEY);
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  assert.equal(verifyBody(raw, SIMULATOR_KEY, sig), true);
  assert.equal(verifyBody(raw.replace('"qty":4', '"qty":5'), SIMULATOR_KEY, sig), false);
});
