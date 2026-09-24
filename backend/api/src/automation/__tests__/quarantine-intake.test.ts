/**
 * G3 rule: GRN posted → RM batch QUARANTINE + incoming QC inspection created
 * (backend/api/src/automation/quarantine-intake.service.ts).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSchema, testClient, closeTestClient } from '../../../../test-support/db.js';
import { QuarantineIntakeService } from '../quarantine-intake.service.js';

let svc: QuarantineIntakeService;

before(async () => {
  await ensureSchema();
  svc = new QuarantineIntakeService(testClient() as never);
});
after(async () => {
  await closeTestClient();
});

function applyOne(rmBatchId: string): Promise<void> {
  return (svc as unknown as { applyOne(id: string): Promise<void> }).applyOne(rmBatchId);
}
function drain(): Promise<void> {
  return (svc as unknown as { drain(): Promise<void> }).drain();
}

async function freshActiveRmBatch(materialId = randomUUID()): Promise<string> {
  const sql = testClient();
  const rmBatchId = randomUUID();
  await sql`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, received_qty, status)
    values (${rmBatchId}, ${materialId}, ${'RMB-' + rmBatchId.slice(0, 8)}, 100, 'ACTIVE')`;
  return rmBatchId;
}

test('quarantines a freshly received RM batch and opens a PENDING incoming QC inspection', async () => {
  const rmBatchId = await freshActiveRmBatch();
  await applyOne(rmBatchId);

  const sql = testClient();
  const batch = await sql`select status from inventory.rm_batch_master where rm_batch_id = ${rmBatchId}`;
  assert.equal(batch[0]?.status, 'QUARANTINE');

  const inspections = await sql`select overall_result, status from quality.qc_inspections where rm_batch_id = ${rmBatchId}`;
  assert.equal(inspections.length, 1);
  assert.equal(inspections[0]?.overall_result, 'PENDING');
});

test('duplicate event delivery for the same RM batch creates no second QC inspection', async () => {
  const rmBatchId = await freshActiveRmBatch();
  await applyOne(rmBatchId);
  await applyOne(rmBatchId); // redelivery
  await applyOne(rmBatchId); // and again

  const sql = testClient();
  const inspections = await sql`select count(*)::int as c from quality.qc_inspections where rm_batch_id = ${rmBatchId}`;
  assert.equal(inspections[0]?.c, 1, 'exactly one inspection despite 3 delivery attempts');

  const batch = await sql`select status from inventory.rm_batch_master where rm_batch_id = ${rmBatchId}`;
  assert.equal(batch[0]?.status, 'QUARANTINE');
});

test('a batch already progressed past ACTIVE (e.g. already RELEASED) is left alone', async () => {
  const rmBatchId = await freshActiveRmBatch();
  const sql = testClient();
  await sql`update inventory.rm_batch_master set status = 'RELEASED' where rm_batch_id = ${rmBatchId}`;

  await applyOne(rmBatchId);

  const inspections = await sql`select count(*)::int as c from quality.qc_inspections where rm_batch_id = ${rmBatchId}`;
  assert.equal(inspections[0]?.c, 0, 'no inspection is opened against a batch that already moved past receiving');
  const batch = await sql`select status from inventory.rm_batch_master where rm_batch_id = ${rmBatchId}`;
  assert.equal(batch[0]?.status, 'RELEASED');
});

test('drain() picks up a real inventory.batch.created outbox row end to end', async () => {
  const rmBatchId = await freshActiveRmBatch();
  const sql = testClient();
  await sql`insert into inventory.outbox (type, aggregate_id, payload) values ('inventory.batch.created', ${rmBatchId}, ${JSON.stringify({ rmBatchId })}::jsonb)`;

  await drain();

  const batch = await sql`select status from inventory.rm_batch_master where rm_batch_id = ${rmBatchId}`;
  assert.equal(batch[0]?.status, 'QUARANTINE');
  const inspections = await sql`select count(*)::int as c from quality.qc_inspections where rm_batch_id = ${rmBatchId}`;
  assert.equal(inspections[0]?.c, 1);
});
