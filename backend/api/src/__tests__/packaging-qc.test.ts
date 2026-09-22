/**
 * RP-FAC — packaging QC disposition (PackagingQcService) auto-grading, and proof that its
 * outcome actually changes FG inventory availability (master directive §28-§34: "QC outcome must
 * automatically change inventory availability"). PackagingQcService itself just records the
 * inspection; the availability effect is asserted end-to-end through ReservationService and
 * DispatchService, which both consult the latest packaging_qc row before allowing a hold/ship.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { PackagingQcService } from '../packaging-qc/packaging-qc.service.js';
import { ReservationService } from '../../../cluster-packaging/src/reservation/reservation.service.js';
import { ensureSchema, packagingDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let qc: PackagingQcService;
let reservations: ReservationService;

before(async () => {
  await ensureSchema();
  qc = new PackagingQcService(testClient());
  reservations = new ReservationService(packagingDb());
});

after(async () => {
  await closeTestClient();
});

async function freshFgBatch(producedQty: number) {
  const sql = testClient();
  const id = crypto.randomUUID();
  await sql`insert into packaging.finished_good_batch_master
    (finished_good_batch_id, batch_number, produced_qty, status)
    values (${id}, ${'QC-' + id}, ${producedQty}, 'ACTIVE')`;
  return id;
}

test('packaging QC: all-PASS checks grade overall PASS', async () => {
  const batchId = await freshFgBatch(10);
  const row = (await qc.create(
    { finishedGoodBatchId: batchId, leakageCheck: 'PASS', labelCheck: 'PASS', cartonCheck: 'PASS' },
    principal(),
  )) as { overallResult: string };
  assert.equal(row.overallResult, 'PASS');
});

test('packaging QC: any FAIL check grades overall FAIL', async () => {
  const batchId = await freshFgBatch(10);
  const row = (await qc.create(
    { finishedGoodBatchId: batchId, leakageCheck: 'FAIL', labelCheck: 'PASS', cartonCheck: 'PASS' },
    principal(),
  )) as { overallResult: string };
  assert.equal(row.overallResult, 'FAIL');
});

test('packaging QC: a HOLD check (no FAIL) grades overall HOLD', async () => {
  const batchId = await freshFgBatch(10);
  const row = (await qc.create(
    { finishedGoodBatchId: batchId, leakageCheck: 'PASS', labelCheck: 'HOLD', cartonCheck: 'PASS' },
    principal(),
  )) as { overallResult: string };
  assert.equal(row.overallResult, 'HOLD');
});

test('packaging QC outcome automatically changes availability: a FAIL zeroes reservable stock', async () => {
  const batchId = await freshFgBatch(50);
  // Before QC: full stock reservable.
  const held = await reservations.createReservation({ finishedGoodBatchId: batchId, reservedQty: 10 }, principal());
  await reservations.releaseReservation(held.finishedGoodReservationId, principal());

  await qc.create(
    { finishedGoodBatchId: batchId, leakageCheck: 'FAIL', labelCheck: 'PASS', cartonCheck: 'PASS' },
    principal(),
  );

  // After a FAIL QC disposition, availability must drop to zero with no further code changes —
  // the same read every reservation/dispatch guard already uses.
  await assert.rejects(
    () => reservations.createReservation({ finishedGoodBatchId: batchId, reservedQty: 1 }, principal()),
    ConflictException,
  );
});
