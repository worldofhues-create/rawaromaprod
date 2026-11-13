/**
 * PROM-REVIEW (LD-85; ALEMBIC docs/plan/program/process-promises.md): attacks on the factory side of the
 * process promises, with the production default in force (qc.reference_required on, rounds the verdict).
 * Real Postgres, the real oil-batch state machine, the real maceration and QC services.
 *
 *   - a rest cut short through a held state: IN_MATURATION -> HOLD -> RELEASED part-way through the rest
 *     is refused; HOLD -> IN_MATURATION resumes the same timer and does not restart it shorter;
 *   - released early by the person who asked: withdrawing and asking again in someone else's name does
 *     not let the first person approve their own request; the database refuses the same person twice;
 *   - an honest early release is recorded as one: the fact says early_release with fewer days than
 *     required, and ALEMBIC's own parser (the verbatim copy) accepts it, including the check that the
 *     days do not exceed the run's own dates.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { BatchService } from '../../../cluster-production/src/batch/batch.service.js';
import { ensureSchema, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { parseBatchRestRecorded } from '../../../test-support/alembic-prom.js';
import { QcFloorService } from '../prodfloor/qc-floor.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { MacerationService } from '../floor-ops/maceration.service.js';

let batches: BatchService;
let qc: QcFloorService;
let mac: MacerationService;
const qcA = principal({ userId: randomUUID(), roles: ['qc'] });
const qcB = principal({ userId: randomUUID(), roles: ['qc'] });
const qcC = principal({ userId: randomUUID(), roles: ['qc'] });
const op = principal();
const CPS = [{ name: 'Clarity', checkType: 'PASS_FAIL' }, { name: 'Odour against the retained reference', checkType: 'REFERENCE', critical: true }];
const DAY = 86_400_000;

before(async () => {
  await ensureSchema();
  const s = testClient();
  const policy = new PolicyService(s);
  batches = new BatchService(productionDb());
  qc = new QcFloorService(s, policy);
  mac = new MacerationService(s);
});
after(async () => closeTestClient());

const tick = () => new Promise((r) => setTimeout(r, 15));
async function product() {
  const productId = randomUUID(), formulaId = randomUUID(), code = 'PRV-' + productId.slice(0, 6).toUpperCase();
  await testClient()`insert into packaging.product_master (product_id, product_code, product_name, formula_id, status) values (${productId}, ${code}, 'Oud Rose Vetiver', ${formulaId}, 'ACTIVE')`;
  await qc.publish(productId, { reason: 'PROM-REVIEW checkpoints', checkpoints: CPS }, qcA);
  const cps = (await qc.checkpoints(productId)).checkpoints;
  return { productId, formulaId, clarity: cps.find((c) => c.checkType === 'PASS_FAIL')!.id, odour: cps.find((c) => c.checkType === 'REFERENCE')!.id };
}
type P = Awaited<ReturnType<typeof product>>;
async function resting(p: P) {
  const planItem = randomUUID(), order = randomUUID();
  await testClient()`insert into production.production_plan_items (production_plan_item_id, formula_id, planned_qty, status) values (${planItem}, ${p.formulaId}, 10, 'ACTIVE')`;
  await testClient()`insert into production.production_order (production_order_id, production_plan_item_id, order_qty, status) values (${order}, ${planItem}, 10, 'ACTIVE')`;
  const { batch } = await batches.produceOilBatch({ productionOrderId: order, producedQty: 10 }, op);
  const b = { id: batch.oilBatchId as string, no: batch.batchNumber as string };
  await round(b, p, qcA);
  await batches.transitionOilBatch(b.id, 'IN_MATURATION', op);
  const run = (await mac.runs()).find((r) => r.oilBatchId === b.id)!;
  return { ...b, runId: run.macerationRunId as string };
}
const round = (b: { id: string }, p: P, who = qcA) => qc.recordRound(b.id, { productId: p.productId, results: [{ checkpointId: p.clarity, pass: true }, { checkpointId: p.odour, pass: true }] }, who);
const ageRun = (b: { id: string }, days: number) => testClient()`update production.maceration_run set started_at = started_at - make_interval(days => ${days}) where oil_batch_id = ${b.id} and status = 'MACERATING'`;
const retain = (b: { id: string; no: string }) => testClient()`insert into quality.qc_sample_retention (oil_batch_id, sample_code, retained_dt, status) values (${b.id}, ${'RS-' + b.no}, now(), 'ACTIVE')`;
const startedMs = async (b: { id: string }) => Number((await testClient()`select (extract(epoch from started_at) * 1000)::float8 as ms from production.maceration_run where oil_batch_id = ${b.id} and status = 'MACERATING'`)[0]!.ms);

test('a rest cannot be cut short through HOLD, and HOLD -> IN_MATURATION resumes the same timer', async () => {
  const p = await product();
  const b = await resting(p);
  await ageRun(b, 10); // day 11 of 45
  const before = await startedMs(b);
  await batches.transitionOilBatch(b.id, 'HOLD', op);
  await assert.rejects(() => batches.transitionOilBatch(b.id, 'RELEASED', op), /day 11 of 45 of maceration\. An early release needs a second person/,
    'a batch put on hold part-way through its rest is not released from the hold');
  await batches.transitionOilBatch(b.id, 'IN_MATURATION', op);
  assert.equal(await startedMs(b), before, 'resuming keeps the original start: the hold neither shortened nor restarted the rest');
  await assert.rejects(() => round(b, p, qcB), /resting \(day 11 of 45\)/, 'no QC 2 round while it rests, hold or no hold');
});

test('the person who asked for an early release can never approve it, however the request is re-made', async () => {
  const p = await product();
  const b = await resting(p);
  const why = { reasonCode: 'customer_commitment', reason: 'Trade order promised for the 20th, confirmed by the owner' };
  await mac.requestEarlyRelease(b.runId, why, qcA);
  await assert.rejects(() => mac.approveEarlyRelease(b.runId, {}, qcA), /someone else must approve it/);
  // A withdraws; C asks in their own name; A may now approve C's request (two different people) -- but
  // C may not approve their own, and nobody may record A as both.
  await mac.declineEarlyRelease(b.runId, { reason: 'withdrawn to re-ask' }, qcA);
  await mac.requestEarlyRelease(b.runId, why, qcC);
  await assert.rejects(() => mac.approveEarlyRelease(b.runId, {}, qcC), /someone else must approve it/);
  await assert.rejects(() => testClient()`update production.maceration_run set early_release_at = now(), early_release_approved_by = early_release_by where maceration_run_id = ${b.runId}`,
    /check|violates|constraint/i, 'the database refuses the requester as approver, whatever the service does');
  const [r] = await testClient()`select early_release_at, early_release_approved_by from production.maceration_run where maceration_run_id = ${b.runId}`;
  assert.equal(r!.early_release_at, null, 'nothing was released');
});

test('an early release is recorded as one, and ALEMBIC accepts the record, days within the run\'s own dates', async () => {
  const p = await product();
  const b = await resting(p);
  await ageRun(b, 30); // day 31 of 45
  await mac.requestEarlyRelease(b.runId, { reasonCode: 'customer_commitment', reason: 'Trade order promised for the 20th, confirmed by the owner' }, qcA);
  await mac.approveEarlyRelease(b.runId, {}, qcB);
  await tick();
  await retain(b);
  await round(b, p, qcC);
  await batches.transitionOilBatch(b.id, 'RELEASED', op);
  const facts = await testClient()`select payload from bridge.outbox where type = 'batch.rest.recorded' and aggregate_id = ${b.runId}`;
  assert.equal(facts.length, 1);
  const payload = (typeof facts[0]!.payload === 'string' ? JSON.parse(facts[0]!.payload) : facts[0]!.payload) as Record<string, unknown>;
  assert.equal(payload.early_release, true);
  assert.equal(payload.early_release_reason_code, 'customer_commitment');
  assert.ok((payload.days_rested as number) < (payload.required_days as number), 'fewer days than required, said plainly');
  assert.ok((payload.days_rested as number) <= Math.floor((Date.parse(String(payload.closed_at)) - Date.parse(String(payload.started_at))) / DAY));
  const parsed = parseBatchRestRecorded(payload);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  for (const leak of ['Oud Rose Vetiver', qcA.userId, qcB.userId, 'Trade order promised']) assert.ok(!JSON.stringify(payload).includes(leak), `${leak} stays at the factory`);
});
