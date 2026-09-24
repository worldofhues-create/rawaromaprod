/**
 * G3 rule: packaging QC PASS → FG batch released + availability event emitted on the bridge to
 * ALEMBIC (backend/api/src/automation/packaging-release.service.ts), fed by the
 * `packaging.qc.recorded` outbox row PackagingQcService.create() now records
 * (backend/api/src/packaging-qc/packaging-qc.service.ts).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../../test-support/db.js';
import { PackagingQcService } from '../../packaging-qc/packaging-qc.service.js';
import { PackagingReleaseService } from '../packaging-release.service.js';

let qcSvc: PackagingQcService;
let releaseSvc: PackagingReleaseService;

before(async () => {
  await ensureSchema();
  qcSvc = new PackagingQcService(testClient() as never);
  releaseSvc = new PackagingReleaseService(testClient() as never);
});
after(async () => {
  await closeTestClient();
});

function drain(): Promise<void> {
  return (releaseSvc as unknown as { drain(): Promise<void> }).drain();
}

async function freshFgBatch(): Promise<string> {
  const sql = testClient();
  const id = randomUUID();
  await sql`insert into packaging.finished_good_batch_master (finished_good_batch_id, batch_number, produced_qty, status)
    values (${id}, ${'FG-' + id.slice(0, 8)}, 100, 'ACTIVE')`;
  return id;
}

/** Wires a full production_order → oil_batch → package_order → FG batch chain, plus a linked
 * bridge.production_requirement, so the bridge emission path is exercised end to end. */
async function freshBridgeLinkedFgBatch(): Promise<{ fgBatchId: string; alembicRequirementId: string }> {
  const sql = testClient();
  const productionOrderId = randomUUID();
  await sql`insert into production.production_order (production_order_id, order_qty, status) values (${productionOrderId}, 10, 'INPROGRESS')`;

  const alembicRequirementId = randomUUID();
  await sql`insert into bridge.production_requirement
    (alembic_requirement_id, org_id, correlation_id, order_ref, mapped_sku, qty, uom, needed_by, production_order_id)
    values (${alembicRequirementId}, ${randomUUID()}, ${randomUUID()}, 'ORDER-1', 'SKU-1', 10, 'KG', now(), ${productionOrderId})`;

  const oilBatchId = randomUUID();
  await sql`insert into production.oil_batch_master (oil_batch_id, production_order_id, batch_number, produced_qty)
    values (${oilBatchId}, ${productionOrderId}, ${'OIL-' + oilBatchId.slice(0, 8)}, 10)`;

  const packageOrderId = randomUUID();
  await sql`insert into packaging.package_order (package_order_id, oil_batch_id, order_qty, status) values (${packageOrderId}, ${oilBatchId}, 10, 'ACTIVE')`;

  const fgBatchId = randomUUID();
  await sql`insert into packaging.finished_good_batch_master (finished_good_batch_id, package_order_id, batch_number, produced_qty, status)
    values (${fgBatchId}, ${packageOrderId}, ${'FG-' + fgBatchId.slice(0, 8)}, 100, 'ACTIVE')`;

  return { fgBatchId, alembicRequirementId };
}

test('packaging QC PASS releases the FG batch to availability', async () => {
  const fgBatchId = await freshFgBatch();
  await qcSvc.create({ finishedGoodBatchId: fgBatchId, overallResult: 'PASS' }, principal());

  await drain();

  const sql = testClient();
  const batch = await sql`select status from packaging.finished_good_batch_master where finished_good_batch_id = ${fgBatchId}`;
  assert.equal(batch[0]?.status, 'RELEASED');
});

test('packaging QC FAIL does not release the FG batch (no action needed — ATP already reflects it)', async () => {
  const fgBatchId = await freshFgBatch();
  await qcSvc.create({ finishedGoodBatchId: fgBatchId, overallResult: 'FAIL' }, principal());

  await drain();

  const sql = testClient();
  const batch = await sql`select status from packaging.finished_good_batch_master where finished_good_batch_id = ${fgBatchId}`;
  assert.equal(batch[0]?.status, 'ACTIVE', 'FAIL leaves the batch status untouched');
});

test('duplicate packaging QC PASS delivery does not re-emit a second bridge event', async () => {
  const { fgBatchId, alembicRequirementId } = await freshBridgeLinkedFgBatch();
  await qcSvc.create({ finishedGoodBatchId: fgBatchId, overallResult: 'PASS' }, principal());

  await drain();
  await drain(); // a second tick re-offering the same (already-DONE) candidate

  const sql = testClient();
  const batch = await sql`select status from packaging.finished_good_batch_master where finished_good_batch_id = ${fgBatchId}`;
  assert.equal(batch[0]?.status, 'RELEASED');

  const bridgeEvents = await sql`select count(*)::int as c from bridge.outbox where type = 'FgBatchAvailable' and aggregate_id = ${alembicRequirementId}`;
  assert.equal(bridgeEvents[0]?.c, 1, 'exactly one FgBatchAvailable event despite 2 drain ticks');

  const req = await sql`select last_emitted_version from bridge.production_requirement where alembic_requirement_id = ${alembicRequirementId}`;
  assert.equal(Number(req[0]?.last_emitted_version), 1);
});

test('an FG batch not linked to any bridge requirement releases locally without a bridge event', async () => {
  const fgBatchId = await freshFgBatch(); // not bridge-linked
  await qcSvc.create({ finishedGoodBatchId: fgBatchId, overallResult: 'PASS' }, principal());

  await drain();

  const sql = testClient();
  const batch = await sql`select status from packaging.finished_good_batch_master where finished_good_batch_id = ${fgBatchId}`;
  assert.equal(batch[0]?.status, 'RELEASED');
});
