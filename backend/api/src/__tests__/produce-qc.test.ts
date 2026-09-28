/**
 * Lane produce — QC certification: batch QC with spec checks → release / fail. Real Postgres, the
 * real CoaService, BatchService and FgLabelService.
 *
 *   fail      QC's FAIL verdict (reject) marks the COA REJECTED, sends `qc.batch.released` with
 *             `status: 'failed'` (DOCS-001 — ALEMBIC takes both verdicts; its own parser accepts it
 *             and refuses a COA for the batch), tells the requirement the run serves
 *             `QcStatusChanged: failed`, alerts QC/production/packaging, and BLOCKS labelling.
 *   recover   a re-test that passes and is released sends `status: 'passed'` (the latest verdict
 *             wins on ALEMBIC), `QcStatusChanged: passed`, and the batch can then be labelled.
 *   guards    a released batch cannot be rejected; a second reject is a no-op.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { bridge as contracts } from '@core/contracts';
import { CoaService } from '../../../cluster-production/src/coa/coa.service.js';
import { BatchService } from '../../../cluster-production/src/batch/batch.service.js';
import { FgLabelService } from '../packaging-qc/fg-label.service.js';
import { ensureSchema, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { eachUom, rack, requirement } from '../../../test-support/produce-fixtures.js';
import { parseQcBatchReleased, coaEligibility } from '../../../test-support/alembic-docs001.js';

const qcUser = principal({ userId: randomUUID(), roles: ['qc'] });
let coa: CoaService;
let batches: BatchService;
let labels: FgLabelService;

before(async () => {
  await ensureSchema();
  coa = new CoaService(productionDb());
  batches = new BatchService(productionDb());
  labels = new FgLabelService(testClient());
});
after(async () => { await closeTestClient(); });

const PASSING = {
  sgResult: 0.995, flashPointResultC: 116, colourAppearance: 'Deep Brown', colourAppearancePass: true,
  odourDescription: 'Warm Spicy Vanilla Fragrance', odourPass: true,
};

/** Product (formula) → plan item → run serving an ALEMBIC requirement → oil batch → FG batch. */
async function chain() {
  const sql = testClient();
  const formulaId = randomUUID();
  const productId = randomUUID();
  const code = `QCP-${productId.slice(0, 8)}`;
  await sql`insert into packaging.product_master (product_id, formula_id, product_code, product_name, status)
            values (${productId}, ${formulaId}, ${code}, 'Althair', 'ACTIVE')`;
  const skuId = randomUUID();
  const sku = `${code}-25KG`;
  await sql`insert into packaging.product_sku (product_sku_id, product_id, sku_code, pack_size, status) values (${skuId}, ${productId}, ${sku}, '25 kg', 'ACTIVE')`;
  const planItemId = randomUUID();
  await sql`insert into production.production_plan_items (production_plan_item_id, formula_id, status) values (${planItemId}, ${formulaId}, 'ACTIVE')`;
  const orderId = randomUUID();
  await sql`insert into production.production_order (production_order_id, production_plan_item_id, order_qty, status)
            values (${orderId}, ${planItemId}, 100, 'COMPLETED')`;
  const req = await requirement({ sku, qtyKg: 100, productionOrderId: orderId });
  const { batch } = await batches.produceOilBatch(
    { productionOrderId: orderId, batchNumber: `Q${productId.slice(0, 7)}`, producedQty: 100, producedDt: '2026-09-20T08:00:00.000Z' }, qcUser);
  await coa.upsertSpec(productId, { sgMin: 0.95, sgMax: 1.5, flashPointMinC: 110, flashPointMaxC: 120, shelfLifeMonths: 24 }, qcUser);
  const packageOrderId = randomUUID();
  await sql`insert into packaging.package_order (package_order_id, product_sku_id, oil_batch_id, order_qty, status)
            values (${packageOrderId}, ${skuId}, ${batch.oilBatchId}, 4, 'COMPLETED')`;
  const fgId = randomUUID();
  const uom = await eachUom();
  await sql`insert into packaging.finished_good_batch_master
    (finished_good_batch_id, package_order_id, product_sku_id, batch_number, produced_qty, uom_id, manufacturing_date, expiry_date, status)
    values (${fgId}, ${packageOrderId}, ${skuId}, ${`FG-${fgId.slice(0, 8)}`}, 4, ${uom.id}, '2026-09-22', '2028-09-20', 'ACTIVE')`;
  return { productId, sku, batch, req, fgId };
}

async function facts(batchCoaId: string) {
  return testClient()`select type, payload from bridge.outbox where aggregate_id = ${batchCoaId} and type = 'qc.batch.released' order by seq`;
}
async function qcStatusEvents(reqId: string) {
  return testClient()`select payload->>'qc_status' as s from bridge.outbox where aggregate_id = ${reqId} and type = 'QcStatusChanged' order by seq`;
}

test('fail verdict: REJECTED, a `failed` fact ALEMBIC accepts (and refuses a COA for), QcStatusChanged, alert, labelling blocked', async () => {
  await rack();
  const c = await chain();
  const { coa: tested } = await coa.recordCoa({ oilBatchId: c.batch.oilBatchId, ...PASSING, flashPointResultC: 124, photos: [] }, qcUser);
  assert.equal(tested.overallResult, 'FAIL');
  // Recording a failing result already alerts (labelling cannot happen: nothing is released).
  const onRecord = await testClient()`select kind from production.produce_alert where ref_id = ${tested.batchCoaId}`;
  assert.deepEqual(onRecord.map((a) => a.kind), ['qc_failed']);

  const res = await coa.rejectCoa(tested.batchCoaId, 'Flash point out of spec after re-check', qcUser);
  assert.equal(res.emitted, true);
  assert.equal(res.coa.status, 'REJECTED');
  assert.equal(res.coa.rejectReason, 'Flash point out of spec after re-check');
  const [fact] = await facts(tested.batchCoaId);
  const w = fact!.payload as contracts.QcBatchReleasedWire;
  assert.equal(w.status, 'failed');
  assert.deepEqual(w.product_ref, { factory_sku: c.sku }, 'the SKU of the requirement the run serves');
  assert.equal(w.results.find((r) => r.key === 'flash_point')!.pass, false);
  const parsed = parseQcBatchReleased(w);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.equal(coaEligibility(parsed.release, w.batch_no).ok, false);
  assert.doesNotThrow(() => contracts.assertNoFormulaContent(w));
  assert.deepEqual((await qcStatusEvents(c.req.id)).map((e) => e.s), ['failed']);
  const alerts = await testClient()`select kind, roles from production.produce_alert where ref_id = ${tested.batchCoaId} order by seq`;
  assert.equal(alerts.length, 2);
  assert.deepEqual([...(alerts[1]!.roles as string[])].sort(), ['packaging', 'production', 'qc']);

  await assert.rejects(() => labels.apply(c.fgId, { labelCount: 4 }, principal({ roles: ['packaging'] })),
    (e: unknown) => e instanceof ConflictException && /failed QC — it cannot be labelled/.test((e as Error).message));
  assert.equal((await testClient()`select 1 from packaging.fg_label_record where finished_good_batch_id = ${c.fgId}`).length, 0);

  // A second reject changes nothing and sends nothing.
  const again = await coa.rejectCoa(tested.batchCoaId, 'again', qcUser);
  assert.equal(again.emitted, false);
  assert.equal((await facts(tested.batchCoaId)).length, 1);
});

test('recover: a passing re-test, released, supersedes the failed verdict and the batch can be labelled', async () => {
  await rack();
  const c = await chain();
  const { coa: first } = await coa.recordCoa({ oilBatchId: c.batch.oilBatchId, ...PASSING, odourPass: false, photos: [] }, qcUser);
  await coa.rejectCoa(first.batchCoaId, 'Odour off-note', qcUser);
  const { coa: retest } = await coa.recordCoa({ oilBatchId: c.batch.oilBatchId, ...PASSING, photos: [] }, qcUser);
  assert.equal(retest.status, 'TESTED');
  assert.equal(retest.overallResult, 'PASS');
  assert.equal(retest.rejectReason, null, 'the re-test clears the earlier verdict');
  const released = await coa.releaseCoa(retest.batchCoaId, qcUser);
  assert.equal(released.emitted, true);
  const all = await facts(retest.batchCoaId);
  assert.deepEqual(all.map((f) => (f.payload as contracts.QcBatchReleasedWire).status), ['failed', 'passed']);
  const latest = parseQcBatchReleased(all[1]!.payload);
  assert.ok(latest.ok && coaEligibility(latest.release, latest.release.batchNo).ok);
  assert.deepEqual((await qcStatusEvents(c.req.id)).map((e) => e.s), ['failed', 'passed']);

  const label = await labels.apply(c.fgId, { labelCount: 4 }, principal({ roles: ['packaging'] })) as { labelContent: Record<string, unknown> };
  assert.equal(label.labelContent.qcStatus, 'RELEASED');

  await assert.rejects(() => coa.rejectCoa(retest.batchCoaId, 'too late', qcUser), /already been released/);
});
