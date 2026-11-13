/**
 * PROM-3 (LD-85, ALEMBIC docs/plan/program/process-promises.md P-03, S-06, S-08): "Every batch is checked
 * against a retained reference before it ships" is made true by the server. Real Postgres; the real QC
 * floor service, oil-batch state machine, maceration and policy services, reference service and CoA
 * payload builder.
 *
 *   - a checkpoint set without a REFERENCE checkpoint cannot be published (rule on, the default);
 *   - QC 1 and QC 2 are rounds the SERVER names; no round while the batch rests;
 *   - a typed production_qc PASS moves nothing into maceration and releases nothing;
 *   - QC 2 approves only with a retained sample, and counts only after the rest;
 *   - the first batches of a product compare with nothing and say so (NO_REFERENCE_YET);
 *   - a reference is proposed by one person and approved by ANOTHER; one ACTIVE per product (index);
 *     replacing it retires the old one with a reason and names its successor;
 *   - with a reference, the REFERENCE checkpoint must carry that bottle's sample code; an expired one holds QC;
 *   - `qc.batch.released` carries the stages and the reference, ALEMBIC's own parser accepts them, and no
 *     product name, formula or material crosses (D-1); the inspector is the person signed in.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { BatchService } from '../../../cluster-production/src/batch/batch.service.js';
import { CoaService } from '../../../cluster-production/src/coa/coa.service.js';
import { ensureSchema, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { parseQcBatchReleased } from '../../../test-support/alembic-docs001.js';
import { parseQcReferenceEstablished } from '../../../test-support/alembic-prom.js';
import { readFileSync } from 'node:fs';
import { QcFloorService } from '../prodfloor/qc-floor.service.js';
import { ReferenceStandardService } from '../prodfloor/reference-standard.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { MacerationService } from '../floor-ops/maceration.service.js';
import { bridge } from '@core/contracts';

let batches: BatchService, qc: QcFloorService, refs: ReferenceStandardService, policy: PolicyService, mac: MacerationService, coa: CoaService;
const qcA = principal({ userId: randomUUID(), roles: ['qc'] });
const qcB = principal({ userId: randomUUID(), roles: ['qc'] });
const admin = principal({ userId: randomUUID(), roles: ['admin'] });
const op = principal();
const CPS = [{ name: 'Clarity', checkType: 'PASS_FAIL' }, { name: 'Odour against the retained reference', checkType: 'REFERENCE', critical: true }];

before(async () => {
  await ensureSchema();
  const s = testClient();
  policy = new PolicyService(s);
  batches = new BatchService(productionDb());
  qc = new QcFloorService(s, policy);
  refs = new ReferenceStandardService(s);
  mac = new MacerationService(s);
  coa = new CoaService(productionDb());
});
after(async () => closeTestClient());

const tick = () => new Promise((r) => setTimeout(r, 15));
async function product() {
  const productId = randomUUID(), formulaId = randomUUID(), code = 'P3-' + productId.slice(0, 6).toUpperCase();
  await testClient()`insert into packaging.product_master (product_id, product_code, product_name, formula_id, status) values (${productId}, ${code}, 'Oud Rose Vetiver', ${formulaId}, 'ACTIVE')`;
  await qc.publish(productId, { reason: 'PROM-3 test checkpoints', checkpoints: CPS }, qcA);
  const cps = (await qc.checkpoints(productId)).checkpoints;
  return { productId, formulaId, code, clarity: cps.find((c) => c.checkType === 'PASS_FAIL')!.id, odour: cps.find((c) => c.checkType === 'REFERENCE')!.id };
}
async function batchOf(p: { formulaId: string }) {
  const planItem = randomUUID(), order = randomUUID();
  await testClient()`insert into production.production_plan_items (production_plan_item_id, formula_id, planned_qty, status) values (${planItem}, ${p.formulaId}, 10, 'ACTIVE')`;
  await testClient()`insert into production.production_order (production_order_id, production_plan_item_id, order_qty, status) values (${order}, ${planItem}, 10, 'ACTIVE')`;
  const { batch } = await batches.produceOilBatch({ productionOrderId: order, batchNumber: `P3-${randomUUID().slice(0, 8)}`, producedQty: 10 }, op);
  return { id: batch.oilBatchId as string, no: batch.batchNumber as string };
}
type P = Awaited<ReturnType<typeof product>>;
const pass = (p: P, sampleCode?: string) => [{ checkpointId: p.clarity, pass: true }, { checkpointId: p.odour, pass: true, ...(sampleCode !== undefined ? { referenceSampleCode: sampleCode } : {}) }];
const round = (b: { id: string }, p: P, who = qcA, sampleCode?: string) => qc.recordRound(b.id, { productId: p.productId, results: pass(p, sampleCode) }, who);
const retain = async (b: { id: string; no: string }) => { const code = 'RS-' + b.no; await testClient()`insert into quality.qc_sample_retention (oil_batch_id, sample_code, retained_dt, status) values (${b.id}, ${code}, now(), 'ACTIVE')`; return code; };
const serveRest = (b: { id: string }) => testClient()`update production.maceration_run set started_at = started_at - make_interval(days => min_days + extend_days) where oil_batch_id = ${b.id} and status = 'MACERATING'`;

/** A batch through QC 1, the rest and QC 2, released. Returns its retained sample code. */
async function released(p: P, sampleCode?: string) {
  const b = await batchOf(p);
  await round(b, p, qcA, sampleCode);
  await batches.transitionOilBatch(b.id, 'IN_MATURATION', op);
  await serveRest(b);
  await tick();
  const kept = await retain(b);
  await round(b, p, qcB, sampleCode);
  await batches.transitionOilBatch(b.id, 'RELEASED', op);
  return { ...b, kept };
}

test('the rule is data: qc.reference_required v1 is on; a set without a REFERENCE checkpoint is refused', async () => {
  const [v] = await testClient()`select body from platform.policy_version where policy_key = 'qc.reference_required' order by version limit 1`;
  assert.deepEqual((typeof v!.body === 'string' ? JSON.parse(v!.body) : v!.body).defaultValue, { required: true });
  const id = randomUUID();
  await testClient()`insert into packaging.product_master (product_id, product_code, product_name, status) values (${id}, ${'P3N-' + id.slice(0, 6)}, 'x', 'ACTIVE')`;
  await assert.rejects(() => qc.publish(id, { reason: 'no comparison', checkpoints: [{ name: 'Clarity', checkType: 'PASS_FAIL' }] }, qcA),
    /needs a comparison to its retained reference/);
});

test('a typed production_qc PASS moves nothing into maceration and releases nothing', async () => {
  const p = await product();
  const b = await batchOf(p);
  await batches.recordProductionQc({ oilBatchId: b.id, result: 'PASS' }, op);
  await assert.rejects(() => batches.transitionOilBatch(b.id, 'IN_MATURATION', op), /QC 1 \(a full round/);
  await round(b, p);
  await batches.transitionOilBatch(b.id, 'IN_MATURATION', op);
  await serveRest(b);
  await tick();
  await batches.recordProductionQc({ oilBatchId: b.id, result: 'PASS' }, op);
  await assert.rejects(() => batches.transitionOilBatch(b.id, 'RELEASED', op), /QC 2 \(a full round.*A typed QC result does not release a batch/);
});

test('QC 1 and QC 2 are named by the server; no round while the batch rests; QC 2 needs a retained sample and counts only after the rest', async () => {
  const p = await product();
  const b = await batchOf(p);
  const r1 = await round(b, p);
  assert.equal(r1.stage, 'QC1');
  assert.equal(r1.referenceBasis, 'NO_REFERENCE_YET', 'the first batches of a product compare with nothing, and say so');
  await assert.rejects(() => round(b, p, qcB), /last QC decision is APPROVE/, 'QC 1 approved closes QC 1, not QC 2');
  await batches.transitionOilBatch(b.id, 'IN_MATURATION', op);
  const run = (await mac.runs()).find((r) => r.oilBatchId === b.id)!;
  assert.equal(run.needDays, 45);
  await assert.rejects(() => round(b, p, qcB), /resting \(day 1 of 45\): QC 2 is taken when the rest ends/);
  await serveRest(b);
  await tick();
  await assert.rejects(() => round(b, p, qcB), /Retain a sample of this batch before QC 2 approves it/);
  await retain(b);
  const r2 = await round(b, p, qcB);
  assert.equal(r2.stage, 'QC2');
  assert.equal((await batches.transitionOilBatch(b.id, 'RELEASED', op)).status, 'RELEASED');
  const [mr] = await testClient()`select qc1_round_id::text as r, qc1_production_qc_id from production.maceration_run where oil_batch_id = ${b.id}`;
  assert.equal(mr!.r, r1.roundId, 'the run records which QC 1 round it started on');
  assert.equal(mr!.qc1_production_qc_id, null);
  const facts = await testClient()`select payload from bridge.outbox where type = 'batch.rest.recorded' and aggregate_id = ${run.macerationRunId}`;
  assert.equal(facts.length, 1);
  await assert.rejects(() => round(b, p, qcA), /released; no further round|last QC decision is APPROVE/);
});

test('a reference is proposed by one person, approved by another; one ACTIVE per product; replacing it retires the old one with a reason', async () => {
  const p = await product();
  const first = await released(p);
  await assert.rejects(() => refs.propose({ oilBatchId: first.id }, qcA), /why/);
  const proposed = await refs.propose({ oilBatchId: first.id, reason: 'first batch, panel approved the odour' }, qcA);
  assert.match(proposed.referenceCode, new RegExp(`^R-${p.code}-1$`));
  await assert.rejects(() => refs.propose({ oilBatchId: first.id, reason: 'again' }, qcA), /already waiting/);
  await assert.rejects(() => refs.approve(proposed.referenceStandardId, {}, qcA), /someone else must approve/);
  await assert.rejects(() => testClient()`update quality.reference_standard set approved_by = proposed_by, approved_dt = now(), status = 'ACTIVE' where reference_standard_id = ${proposed.referenceStandardId}`,
    /reference_standard_two_people_chk/, 'the database holds the two-person rule too');
  const ok = await refs.approve(proposed.referenceStandardId, {}, qcB);
  assert.equal(ok.status, 'ACTIVE');
  await assert.rejects(() => testClient()`insert into quality.reference_standard (reference_code, product_id, oil_batch_id, qc_sample_retention_id, status, proposed_by, proposal_reason, approved_by, approved_dt)
      values (${'R-DUP-' + randomUUID().slice(0, 6)}, ${p.productId}, ${first.id}, ${randomUUID()}, 'ACTIVE', 'a', 'b', 'c', now())`, /reference_standard_one_active_uq/);

  const second = await released(p, first.kept);
  const next = await refs.propose({ oilBatchId: second.id, reason: 'the first bottle is nearly used up' }, qcB);
  await assert.rejects(() => refs.approve(next.referenceStandardId, {}, qcA), /Say why R-.* is retired/);
  const swapped = await refs.approve(next.referenceStandardId, { retireReason: 'bottle nearly used up' }, qcA);
  assert.equal(swapped.retired, proposed.referenceCode);
  const [old] = await testClient()`select status, successor_id::text as s from quality.reference_standard where reference_standard_id = ${proposed.referenceStandardId}`;
  assert.deepEqual([old!.status, old!.s], ['RETIRED', next.referenceStandardId]);
  const declined = await refs.propose({ oilBatchId: first.id, reason: 'try the first bottle again' }, qcA);
  await assert.rejects(() => refs.decline(declined.referenceStandardId, {}, qcB), /why/);
  assert.equal((await refs.decline(declined.referenceStandardId, { reason: 'one reference at a time' }, qcB)).status, 'DECLINED');
});

test('with a reference, the REFERENCE checkpoint must carry that bottle\'s sample code; the round records which reference', async () => {
  const p = await product();
  const first = await released(p);
  const r = await refs.propose({ oilBatchId: first.id, reason: 'the reference' }, qcA);
  await refs.approve(r.referenceStandardId, {}, qcB);
  const b = await batchOf(p);
  await assert.rejects(() => round(b, p), new RegExp(`compare with the retained reference ${r.referenceCode} and scan its sample code \\(${first.kept}\\)`));
  await assert.rejects(() => round(b, p, qcA, 'RS-SOMETHING-ELSE'), /scan its sample code/);
  const ok = await round(b, p, qcA, first.kept);
  assert.equal(ok.referenceBasis, 'REFERENCE');
  assert.equal(ok.referenceStandardId, r.referenceStandardId);
  const ctx = await qc.batch(b.id);
  assert.equal(ctx.reference.active?.referenceCode, r.referenceCode);
  assert.equal(ctx.stage.next, 'QC1');
  assert.equal(ctx.stage.canRecord, true);
});

test('an expired reference holds QC (a Block), and the screen says why', async () => {
  const p = await product();
  const first = await released(p);
  const r = await refs.propose({ oilBatchId: first.id, reason: 'the reference', expiresAt: new Date(Date.now() + 60_000).toISOString() }, qcA);
  await refs.approve(r.referenceStandardId, {}, qcB);
  await testClient()`update quality.reference_standard set expires_at = now() - interval '1 minute' where reference_standard_id = ${r.referenceStandardId}`;
  const b = await batchOf(p);
  await assert.rejects(() => round(b, p, qcA, first.kept), new RegExp(`${r.referenceCode} for this product has expired: QC is held`));
  assert.match((await qc.context(b.id, p.productId)).reference.note, /has expired: QC is held/);
});

test('qc.batch.released carries the stages and the reference; ALEMBIC\'s parser accepts them; no name, formula or material crosses', async () => {
  const p = await product();
  const first = await released(p);
  const r = await refs.propose({ oilBatchId: first.id, reason: 'the reference' }, qcA);
  await refs.approve(r.referenceStandardId, {}, qcB);
  const second = await released(p, first.kept);
  const block = await coa.promiseBlock(productionDb(), second.id);
  assert.deepEqual(block.stages.map((s) => [s.stage, s.decision]), [['QC1', 'APPROVE'], ['QC2', 'APPROVE']]);
  assert.equal(block.reference?.ref, r.referenceCode);
  assert.equal(block.reference?.sample_code, first.kept);
  assert.equal(block.is_reference_batch, false);
  const refBlock = await coa.promiseBlock(productionDb(), first.id);
  assert.equal(refBlock.is_reference_batch, true, 'the approved bottle\'s own batch says it is the reference');
  assert.equal(refBlock.reference, null, 'it compared with none: no comparison is claimed');
  const internal = {
    batchNo: second.no, productRef: p.code, skuCodes: ['SKU-1'], results: [
      { test: bridge.COA_TEST_SPECIFIC_GRAVITY, value: 0.995, unit: null, specMin: 0.99, specMax: 1.0, pass: true },
      { test: bridge.COA_TEST_FLASH_POINT, value: 101, unit: '°C', specMin: 95, specMax: 110, pass: true },
    ], colourAppearance: 'Pale yellow liquid', odourDescription: 'Conforms', photos: [], productionDate: '2026-09-14', bestBefore: '2028-09-14',
    releasedAt: '2026-10-29T09:15:00.000Z', releasedBy: qcA.userId, releasedByName: null,
  } as unknown as bridge.QcBatchReleasedPayload;
  const wire = bridge.toQcBatchReleasedWire(internal, { status: 'passed', factorySku: 'SKU-1', qcRecordRef: randomUUID(), colourAppearancePass: true, odourPass: true, promise: block });
  assert.deepEqual(bridge.checkQcBatchReleasedWire(wire), []);
  assert.doesNotThrow(() => bridge.assertNoFormulaContent(wire));
  const parsed = parseQcBatchReleased(wire);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.equal(parsed.release.promise?.reference?.ref, r.referenceCode);
  const old = bridge.toQcBatchReleasedWire(internal, { status: 'passed', factorySku: 'SKU-1', qcRecordRef: randomUUID(), colourAppearancePass: true, odourPass: true });
  assert.ok(!('stages' in old), 'without the block the wire is exactly the old shape');
  const promiseJson = JSON.stringify(block);
  for (const leak of ['Oud Rose Vetiver', p.formulaId, 'Vetiver']) assert.ok(!promiseJson.includes(leak), `the block carries ${leak}`);
});

test('the inspector is the person signed in; the rule is data and can be published; no record override', async () => {
  const p = await product();
  const b = await batchOf(p);
  await assert.rejects(() => batches.recordProductionQc({ oilBatchId: b.id, result: 'PASS', inspectedBy: randomUUID() } as never, op), /taken from your sign-in/);
  await assert.rejects(() => policy.override('qc.reference_required', 'oil_batch', b.id, { required: false }, 'urgent', admin), /a reason is not a test result/);
  await assert.rejects(() => policy.publish('qc.reference_required', { rules: [], hasDefault: true, defaultValue: { required: 'no' } }, 'bad', admin), /required must be true or false/);
});

test('a reference is proposed only from a batch that rested and passed QC 2', async () => {
  const p = await product();
  const b = await batchOf(p);
  await round(b, p);
  await retain(b);
  await assert.rejects(() => refs.propose({ oilBatchId: b.id, reason: 'passed QC 1 only' }, qcA), /rested and passed QC 2/);
});

test('approving a reference sends qc.reference.established in the same transaction: ALEMBIC\'s parser accepts it, the shared fixture parses, no person, name or material crosses', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../test-support/fixtures/qc-reference-established.json', import.meta.url), 'utf8'));
  assert.ok(parseQcReferenceEstablished(fixture).ok, 'the shared fixture parses on ALEMBIC\'s side');
  assert.deepEqual(bridge.checkQcReferenceEstablishedWire(fixture), [], 'and passes RawProd\'s own check');
  const p = await product();
  const first = await released(p);
  const r = await refs.propose({ oilBatchId: first.id, reason: 'the first reference' }, qcA);
  const sent = (id: string) => testClient()`select payload from bridge.outbox where type = 'qc.reference.established' and aggregate_id = ${id}`;
  assert.equal((await sent(r.referenceStandardId)).length, 0, 'nothing is sent while it waits for a second person');
  await refs.approve(r.referenceStandardId, {}, qcB);
  const rows = await sent(r.referenceStandardId);
  assert.equal(rows.length, 1);
  const payload = (typeof rows[0]!.payload === 'string' ? JSON.parse(rows[0]!.payload) : rows[0]!.payload) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), Object.keys(fixture).sort(), 'the shared fixture\'s shape');
  const parsed = parseQcReferenceEstablished(payload);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.equal(parsed.record.batchNo, first.no);
  assert.equal(parsed.record.reference.ref, r.referenceCode);
  assert.equal(parsed.record.reference.sampleCode, first.kept);
  assert.equal(parsed.record.replacesRef, null);
  const wire = JSON.stringify(payload);
  for (const leak of ['Oud Rose Vetiver', 'Vetiver', p.formulaId, qcA.userId, qcB.userId, 'the first reference']) assert.ok(!wire.includes(leak), `payload carries ${leak}`);
  assert.doesNotThrow(() => bridge.assertNoFormulaContent(payload));

  // Replacing it names the reference it retired.
  const second = await released(p, first.kept);
  const next = await refs.propose({ oilBatchId: second.id, reason: 'the first bottle is nearly used up' }, qcB);
  await refs.approve(next.referenceStandardId, { retireReason: 'bottle nearly used up' }, qcA);
  const swap = (await sent(next.referenceStandardId))[0]!.payload as Record<string, unknown>;
  const swapParsed = parseQcReferenceEstablished(typeof swap === 'string' ? JSON.parse(swap) : swap);
  assert.ok(swapParsed.ok && swapParsed.record.replacesRef === r.referenceCode);
});

test('a bottle with no sample code cannot become the reference, and a code-less reference never matches a blank scan', async () => {
  const p = await product();
  const first = await released(p);
  const r = await refs.propose({ oilBatchId: first.id, reason: 'the reference' }, qcA);
  await testClient()`update quality.qc_sample_retention set sample_code = null where oil_batch_id = ${first.id}`;
  await assert.rejects(() => refs.approve(r.referenceStandardId, {}, qcB), /no sample code on file: label the bottle/);
  assert.equal((await testClient()`select status from quality.reference_standard where reference_standard_id = ${r.referenceStandardId}`)[0]!.status, 'PENDING', 'nothing changed');
  // A reference that lost its code after approval holds QC rather than accepting a blank scan.
  await testClient()`update quality.qc_sample_retention set sample_code = ${first.kept} where oil_batch_id = ${first.id}`;
  await refs.approve(r.referenceStandardId, {}, qcB);
  await testClient()`update quality.qc_sample_retention set sample_code = null where oil_batch_id = ${first.id}`;
  const b = await batchOf(p);
  await assert.rejects(() => round(b, p, qcA, ''), /has no sample code on file: QC is held/);
});
