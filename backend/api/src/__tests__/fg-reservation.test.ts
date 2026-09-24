/**
 * RP-FAC — finished-good reservation guard (ReservationService.createReservation). Before this
 * lane's change there was NO availability guard at all (see the removed comment in
 * reservation.service.ts): any reserved_qty was accepted unconditionally, so concurrent
 * reservations against a scarce FG batch could reserve well past what was produced — a direct
 * violation of the FG AVAILABLE = PRODUCED − DISPATCHED − CONSUMED − RESERVED − BLOCKED invariant
 * (master directive §23/§34). Covers: happy path, negative-stock (over-reservation) attempt,
 * concurrent over-reservation, QC-FAIL blocking, and release/re-reserve (the FG rework/cancel
 * analogue — a reservation is "cancelled" by releasing the hold).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ReservationService } from '../../../cluster-packaging/src/reservation/reservation.service.js';
import { ensureSchema, packagingDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let svc: ReservationService;

before(async () => {
  await ensureSchema();
  svc = new ReservationService(packagingDb());
});

after(async () => {
  await closeTestClient();
});

// lane/j2: FG is sellable only after packaging QC PASS, so the default fixture is a PASSED
// batch; pass `qcResult: null` for an un-inspected one.
async function freshFgBatch(producedQty: number, opts: { qcResult?: string | null } = {}) {
  const qcResult = opts.qcResult === undefined ? 'PASS' : opts.qcResult;
  const sql = testClient();
  const id = crypto.randomUUID();
  await sql`insert into packaging.finished_good_batch_master
    (finished_good_batch_id, batch_number, produced_qty, status)
    values (${id}, ${'FG-' + id}, ${producedQty}, 'ACTIVE')`;
  if (qcResult) {
    await sql`insert into packaging.packaging_qc
      (packaging_qc_id, finished_good_batch_id, overall_result, status)
      values (${crypto.randomUUID()}, ${id}, ${qcResult}, 'ACTIVE')`;
  }
  return id;
}

test('fg reservation: happy path reserves within available stock', async () => {
  const batchId = await freshFgBatch(100);
  const row = await svc.createReservation(
    { finishedGoodBatchId: batchId, reservedQty: 40 },
    principal(),
  );
  assert.equal(row.status, 'ACTIVE');
  assert.equal(Number(row.reservedQty), 40);
});

test('fg reservation: negative-stock attempt (over-reservation) is rejected', async () => {
  const batchId = await freshFgBatch(50);
  await svc.createReservation({ finishedGoodBatchId: batchId, reservedQty: 30 }, principal());
  await assert.rejects(
    () => svc.createReservation({ finishedGoodBatchId: batchId, reservedQty: 21 }, principal()),
    ConflictException,
    'only 20 remain (50 produced - 30 reserved); reserving 21 more must be rejected',
  );
});

test('fg reservation: unknown batch 404s', async () => {
  await assert.rejects(
    () => svc.createReservation({ finishedGoodBatchId: crypto.randomUUID(), reservedQty: 1 }, principal()),
    NotFoundException,
  );
});

test('fg reservation: a batch that FAILED packaging QC has zero available stock', async () => {
  const batchId = await freshFgBatch(100, { qcResult: 'FAIL' });
  await assert.rejects(
    () => svc.createReservation({ finishedGoodBatchId: batchId, reservedQty: 1 }, principal()),
    ConflictException,
  );
});

test('fg reservation: release frees the hold so it can be re-reserved (cancel analogue)', async () => {
  const batchId = await freshFgBatch(20);
  const held = await svc.createReservation({ finishedGoodBatchId: batchId, reservedQty: 20 }, principal());
  await assert.rejects(
    () => svc.createReservation({ finishedGoodBatchId: batchId, reservedQty: 1 }, principal()),
    ConflictException,
  );
  await svc.releaseReservation(held.finishedGoodReservationId, principal());
  const rebooked = await svc.createReservation({ finishedGoodBatchId: batchId, reservedQty: 20 }, principal());
  assert.equal(Number(rebooked.reservedQty), 20);
});

test('fg reservation: concurrent over-reservation attempts never exceed produced stock', async () => {
  // 5 concurrent requests for 30 units each against a 100-unit batch: naive unguarded code lets
  // all 5 through (150 > 100, a real over-reservation). The transactional, row-locked guard must
  // let through at most 3 (90) and reject the rest — total reserved can never exceed produced.
  const batchId = await freshFgBatch(100);
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      svc.createReservation({ finishedGoodBatchId: batchId, reservedQty: 30 }, principal()),
    ),
  );
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  for (const r of results) {
    if (r.status === 'rejected') assert.ok(r.reason instanceof ConflictException);
  }
  assert.ok(succeeded.length <= 3, `at most 3 of 5 concurrent 30-unit reservations can fit in 100 (got ${succeeded.length})`);

  const sql = testClient();
  const totalReserved = (
    await sql`select coalesce(sum(reserved_qty),0)::float as total from packaging.finished_good_reservation
               where finished_good_batch_id = ${batchId} and released_dt is null`
  )[0]!.total;
  assert.ok(totalReserved <= 100, `total reserved (${totalReserved}) must never exceed produced (100)`);
  assert.equal(totalReserved, succeeded.length * 30);
});

/* lane/j2 — an un-inspected FG batch is not ATP: neither reservable nor counted by the fg-stock
 * read model (was: only an explicit packaging-QC FAIL zeroed availability). */
test('fg reservation: a batch with NO packaging QC yet is not reservable and shows 0 ATP', async () => {
  const batchId = await freshFgBatch(20, { qcResult: null });
  await assert.rejects(
    () => svc.createReservation({ finishedGoodBatchId: batchId, reservedQty: 1 }, principal()),
    (e: unknown) => e instanceof ConflictException && /not PASSED packaging QC/.test((e as Error).message),
  );
  const { FgStockService } = await import('../fg-stock/fg-stock.service.js');
  const stock = await new FgStockService(testClient()).availability({ limit: 200 });
  const row = (stock.items as unknown as Array<{ finishedGoodBatchId: string; availableQty: number }>)
    .find((r) => r.finishedGoodBatchId === batchId);
  assert.equal(row?.availableQty, 0);
});
