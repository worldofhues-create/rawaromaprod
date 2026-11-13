/**
 * Lane pf-c (plan section 8): maceration — the kernel gate inside the real oil-batch state machine
 * (BatchService.transitionOilBatch), the real dispatch and reservation services, and
 * floor-ops/maceration.service.ts for the timer, freeze, extension, early release and alarms.
 *
 *   QC 1 PASS required to enter; a run opens; RELEASED is refused before the minimum (day N of M),
 *   without the freeze step, and without QC 2 after the start; an early release (asked by one
 *   person, approved by another) still needs QC 2; REWORK -> IN_MATURATION restarts the timer; while
 *   open, the batch cannot ship or be reserved; the minimum reached raises one alarm at the production
 *   station.
 *
 * PROM-2 changed two things this file used to assert: a product WITHOUT a setting no longer skips
 * maceration (it rests the branch rule's 45 days: that test now asserts the new rule), and a setting
 * may not be shorter than the branch rule, so the settings below are 45 days or longer. The rule's own
 * tests are in prom-2-rest-rule.test.ts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import { BatchService } from '../../../cluster-production/src/batch/batch.service.js';
import { DispatchService } from '../../../cluster-sales/src/dispatch/dispatch.service.js';
import { PackagingLookupService } from '../../../cluster-packaging/src/packaging-lookup.service.js';
import { ReservationService } from '../../../cluster-packaging/src/reservation/reservation.service.js';
import { ensureSchema, productionDb, packagingDb, salesDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { assertNotMacerating } from '../../../backend-kernel/src/events/maceration-gate.js';
import { MacerationService } from '../floor-ops/maceration.service.js';
import { openAlerts } from '../floor-ops/floor-alerts.js';

let batches: BatchService;
let mac: MacerationService;
let dispatch: DispatchService;
let reservations: ReservationService;
const admin = principal({ userId: randomUUID(), roles: ['admin'], permissions: ['production:maceration_setting:write', 'production:maceration:release_early'] });
const qcHead = principal({ userId: randomUUID(), roles: ['qc'], permissions: ['production:maceration:release_early_request'] });
const op = principal();

before(async () => {
  await ensureSchema();
  batches = new BatchService(productionDb());
  mac = new MacerationService(testClient());
  dispatch = new DispatchService(salesDb(), new PackagingLookupService(packagingDb()));
  reservations = new ReservationService(packagingDb());
});
after(async () => closeTestClient());

/** A batch whose order makes `formulaId` (production order -> plan item -> formula). */
async function batchFor(formulaId: string) {
  const sql = testClient();
  const planItem = randomUUID(), order = randomUUID();
  await sql`insert into production.production_plan_items (production_plan_item_id, formula_id, planned_qty, status) values (${planItem}, ${formulaId}, 10, 'ACTIVE')`;
  await sql`insert into production.production_order (production_order_id, production_plan_item_id, order_qty, status) values (${order}, ${planItem}, 10, 'ACTIVE')`;
  const { batch } = await batches.produceOilBatch({ productionOrderId: order, batchNumber: `MAC-${randomUUID().slice(0, 8)}`, producedQty: 10 }, op);
  return batch.oilBatchId as string;
}
const qc = (oilBatchId: string, result = 'PASS') => batches.recordProductionQc({ oilBatchId, result }, op);
/** Moves the run's start back so `days` have passed. */
const age = (oilBatchId: string, days: number) => testClient()`update production.maceration_run set started_at = now() - make_interval(days => ${days}) where oil_batch_id = ${oilBatchId} and status = 'MACERATING'`;
const openRun = async (oilBatchId: string) => (await mac.runs()).find((r) => r.oilBatchId === oilBatchId);
const tick = () => new Promise((r) => setTimeout(r, 15));

test('settings: validated, min <= max, 1..365', async () => {
  const f = randomUUID();
  await assert.rejects(() => mac.putSetting(f, { required: true, minDays: 50, maxDays: 30 }, admin), /more than maxDays/);
  await assert.rejects(() => mac.putSetting(f, { required: true, minDays: 0, maxDays: 30 }, admin), /1 to 365/);
  const s = await mac.putSetting(f, { required: true, minDays: 50, maxDays: 120, freezeRequired: true, freezeNote: 'chill 24 h at 4 C, filter' }, admin);
  assert.deepEqual([s.required, s.minDays, s.maxDays, s.freezeRequired], [true, 50, 120, true]);
});

test('PROM-2: a product without a setting rests the branch rule (45 days), it no longer skips maceration', async () => {
  const b = await batchFor(randomUUID());
  await assert.rejects(() => batches.transitionOilBatch(b, 'IN_MATURATION', op), /QC 1/);
  await qc(b);
  await batches.transitionOilBatch(b, 'IN_MATURATION', op);
  const run = (await openRun(b))!;
  assert.equal(run.needDays, 45);
  assert.equal(run.maxLabel, 'No maximum set');
  await tick();
  await qc(b);
  await assert.rejects(() => batches.transitionOilBatch(b, 'RELEASED', op), /day 1 of 45/);
  await age(b, 45);
  assert.equal((await batches.transitionOilBatch(b, 'RELEASED', op)).status, 'RELEASED');
});

test('QC 1 must PASS before maceration; then a run opens showing Day 1 of 30', async () => {
  const f = randomUUID();
  await mac.putSetting(f, { required: true, minDays: 50, maxDays: 60 }, admin);
  const b = await batchFor(f);
  await assert.rejects(() => batches.transitionOilBatch(b, 'IN_MATURATION', op), /QC 1/);
  await qc(b, 'FAIL');
  await assert.rejects(() => batches.transitionOilBatch(b, 'IN_MATURATION', op), /QC 1/);
  const [still] = await testClient()`select status from production.oil_batch_master where oil_batch_id = ${b}`;
  assert.equal(still!.status, 'ACTIVE', 'the refused move rolled back');
  await qc(b);
  await batches.transitionOilBatch(b, 'IN_MATURATION', op);
  const run = await openRun(b);
  assert.ok(run);
  assert.equal(run.label, 'Day 1 of 50');
  assert.equal(run.readyForQc2, false);
});

test('release is refused before the minimum, without freeze, and without QC 2 after the start', async () => {
  const f = randomUUID();
  await mac.putSetting(f, { required: true, minDays: 50, maxDays: 60, freezeRequired: true }, admin);
  const b = await batchFor(f);
  await qc(b);
  await batches.transitionOilBatch(b, 'IN_MATURATION', op);
  await age(b, 3);
  await tick();
  await qc(b);
  await assert.rejects(() => batches.transitionOilBatch(b, 'RELEASED', op), /day 4 of 50/);
  await age(b, 51);
  await assert.rejects(() => batches.transitionOilBatch(b, 'RELEASED', op), /freeze/);
  const run = (await openRun(b))!;
  await mac.freezeDone(run.macerationRunId, {}, op);
  // The QC recorded before the aging is still after the start, so make QC 2 stale by moving the start later.
  await testClient()`update production.maceration_run set started_at = now() - interval '51 days', freeze_done_at = now() where oil_batch_id = ${b} and status = 'MACERATING'`;
  await testClient()`update production.production_qc set created_dt = now() - interval '60 days' where oil_batch_id = ${b}`;
  await assert.rejects(() => batches.transitionOilBatch(b, 'RELEASED', op), (e: unknown) => e instanceof ConflictException);
  await tick();
  await qc(b);
  assert.equal((await batches.transitionOilBatch(b, 'RELEASED', op)).status, 'RELEASED');
  const closed = await mac.run(run.macerationRunId);
  assert.equal(closed.status, 'CLOSED');
  assert.deepEqual(closed.events.map((e) => e.event), ['STARTED', 'FREEZE_DONE', 'CLOSED']);
});

test('early release: reason required, a second person approves; QC 2 is still required', async () => {
  const f = randomUUID();
  await mac.putSetting(f, { required: true, minDays: 45, maxDays: 90 }, admin);
  const b = await batchFor(f);
  await qc(b);
  await batches.transitionOilBatch(b, 'IN_MATURATION', op);
  const run = (await openRun(b))!;
  await assert.rejects(() => mac.requestEarlyRelease(run.macerationRunId, {}, qcHead), /reason/);
  await mac.requestEarlyRelease(run.macerationRunId, { reasonCode: 'customer_commitment', reason: 'urgent order SO-12, owner approved' }, qcHead);
  await mac.approveEarlyRelease(run.macerationRunId, {}, admin);
  await testClient()`update production.production_qc set created_dt = now() - interval '1 day' where oil_batch_id = ${b}`;
  await assert.rejects(() => batches.transitionOilBatch(b, 'RELEASED', op), /QC/);
  await tick();
  await qc(b);
  assert.equal((await batches.transitionOilBatch(b, 'RELEASED', op)).status, 'RELEASED');
});

test('extend: logged with a reason, never past the maximum', async () => {
  const f = randomUUID();
  await mac.putSetting(f, { required: true, minDays: 45, maxDays: 55 }, admin);
  const b = await batchFor(f);
  await qc(b);
  await batches.transitionOilBatch(b, 'IN_MATURATION', op);
  const run = (await openRun(b))!;
  await assert.rejects(() => mac.extend(run.macerationRunId, { days: 5 }, op), /reason/);
  await assert.rejects(() => mac.extend(run.macerationRunId, { days: 11, reason: 'x' }, op), /maximum/);
  const ext = await mac.extend(run.macerationRunId, { days: 5, reason: 'aroma not rounded yet' }, op);
  assert.equal(ext.needDays, 50);
});

test('rework restarts the timer', async () => {
  const f = randomUUID();
  await mac.putSetting(f, { required: true, minDays: 45, maxDays: 60 }, admin);
  const b = await batchFor(f);
  await qc(b);
  await batches.transitionOilBatch(b, 'IN_MATURATION', op);
  await age(b, 20);
  assert.equal((await openRun(b))!.day, 21);
  await batches.transitionOilBatch(b, 'REWORK', op);
  await batches.transitionOilBatch(b, 'IN_MATURATION', op);
  const run = (await openRun(b))!;
  assert.equal(run.day, 1);
  assert.equal(run.restartCount, 1);
});

test('while macerating the batch cannot ship or be reserved (FG batch behind the oil batch)', async () => {
  const f = randomUUID();
  await mac.putSetting(f, { required: true, minDays: 45, maxDays: 60 }, admin);
  const b = await batchFor(f);
  await qc(b);
  await batches.transitionOilBatch(b, 'IN_MATURATION', op);
  const sql = testClient();
  const po = randomUUID(), fg = randomUUID();
  await sql`insert into packaging.package_order (package_order_id, oil_batch_id, status) values (${po}, ${b}, 'ACTIVE')`;
  await sql`insert into packaging.finished_good_batch_master (finished_good_batch_id, package_order_id, batch_number, produced_qty, status) values (${fg}, ${po}, ${'FGM-' + fg.slice(0, 6)}, 10, 'ACTIVE')`;
  await sql`insert into packaging.packaging_qc (packaging_qc_id, finished_good_batch_id, overall_result, status) values (${randomUUID()}, ${fg}, 'PASS', 'ACTIVE')`;
  await assert.rejects(() => dispatch.createDispatch({ salesOrderId: randomUUID(), items: [{ finishedGoodBatchId: fg, dispatchedQty: 1 }] }, op), /macerating.*cannot ship/);
  await assert.rejects(() => reservations.createReservation({ finishedGoodBatchId: fg, reservedQty: 1 } as never, op), /macerating.*cannot be reserved/);
  await assert.rejects(() => assertNotMacerating(drizzle(sql), { finishedGoodBatchId: fg }, 'move to the finished-goods rack'), /finished-goods rack/);
});

test('alarm: the minimum reached raises one alert at the production station', async () => {
  const f = randomUUID();
  await mac.putSetting(f, { required: true, minDays: 45, maxDays: 60 }, admin);
  const b = await batchFor(f);
  await qc(b);
  await batches.transitionOilBatch(b, 'IN_MATURATION', op);
  await age(b, 45);
  // The order serves an ALEMBIC requirement, so the CRM hears it.
  const req = randomUUID();
  const order = String((await testClient()`select production_order_id from production.oil_batch_master where oil_batch_id = ${b}`)[0]!.production_order_id);
  await testClient()`insert into bridge.production_requirement (alembic_requirement_id, org_id, correlation_id, order_ref, mapped_sku, qty, uom, needed_by, production_order_id)
    values (${req}, ${randomUUID()}, ${randomUUID()}, 'SO-MAC', 'SKU', 1, 'pc', now(), ${order})`;
  const run = (await openRun(b))!;
  assert.equal(run.minReached, true);
  const first = await mac.sweepAlarms();
  assert.ok(first.alarms.includes(run.macerationRunId));
  const second = await mac.sweepAlarms();
  assert.ok(!second.alarms.includes(run.macerationRunId));
  const alerts = (await openAlerts(testClient(), 'Production')).filter((a) => a.subjectId === b);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!.title, /Maceration complete/);
  const crm = await testClient()`select payload from bridge.outbox where type = 'QcStatusChanged' and aggregate_id = ${req}`;
  assert.equal(crm.length, 1);
  assert.equal((crm[0]!.payload as Record<string, unknown>).status, 'MACERATION_COMPLETE');
});

test('WALK2-RP-15: a setting is chosen by a product with a linked formula, by code and name', async () => {
  const pid = randomUUID(), fid = randomUUID(), code = 'P-' + pid.slice(0, 6);
  await testClient()`insert into packaging.product_master (product_id, product_code, product_name, formula_id, status) values (${pid}, ${code}, 'Ruh Khus Night', ${fid}, 'ACTIVE')`;
  const items = await new MacerationService(testClient()).settingProducts();
  const row = items.find((i) => i.formulaId === fid);
  assert.ok(row);
  assert.equal(row!.productCode, code);
  assert.equal(row!.productName, 'Ruh Khus Night');
});
