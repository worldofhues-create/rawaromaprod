/**
 * RP-FAC2 — RM stock reservation guard (StockService.createStockReservation /
 * releaseStockReservation, backend/cluster-inventory/src/stock/stock.service.ts). Before this
 * lane's change, the over-reserve check was a plain check-then-insert on the base connection (no
 * lock, no transaction) — exactly the race lane F had already fixed for FG reservations. Covers:
 * happy path, negative-stock (over-reservation) attempt, concurrent over-reservation never
 * exceeding on-hand, a QC REJECT/HOLD/REWORK batch having zero eligible stock, and release
 * (the RM analogue of the FG reservation release / cancel path) via the new guarded endpoint —
 * plus the old generic-editor bypass being closed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { StockService } from '../../../cluster-inventory/src/stock/stock.service.js';
import { EditService } from '../edit/edit.service.js';
import {
  ensureSchema,
  inventoryDb,
  testClient,
  principal,
  closeTestClient,
} from '../../../test-support/db.js';

let svc: StockService;
let editSvc: EditService;

before(async () => {
  await ensureSchema();
  svc = new StockService(inventoryDb());
  editSvc = new EditService(testClient());
});

after(async () => {
  await closeTestClient();
});

async function freshBatch(onHand: number, opts: { qcResult?: string } = {}) {
  const sql = testClient();
  const id = crypto.randomUUID();
  const rmBatchId = crypto.randomUUID();
  await sql`insert into inventory.inventory_batch
    (inventory_batch_id, rm_batch_id, material_id, quantity_on_hand, status)
    values (${id}, ${rmBatchId}, ${crypto.randomUUID()}, ${onHand}, 'ACTIVE')`;
  if (opts.qcResult) {
    await sql`insert into quality.qc_inspections
      (qc_inspection_id, rm_batch_id, overall_result, status)
      values (${crypto.randomUUID()}, ${rmBatchId}, ${opts.qcResult}, 'ACTIVE')`;
  }
  return id;
}

test('stock reservation: happy path reserves within available stock', async () => {
  const batchId = await freshBatch(100);
  const row = await svc.createStockReservation(
    { inventoryBatchId: batchId, reservedQty: 40 },
    principal(),
  );
  assert.equal(row.status, 'ACTIVE');
  assert.equal(Number(row.reservedQty), 40);
});

test('stock reservation: negative-stock attempt (over-reservation) is rejected', async () => {
  const batchId = await freshBatch(50);
  await svc.createStockReservation({ inventoryBatchId: batchId, reservedQty: 30 }, principal());
  await assert.rejects(
    () => svc.createStockReservation({ inventoryBatchId: batchId, reservedQty: 21 }, principal()),
    ConflictException,
    'only 20 remain (50 on-hand - 30 reserved); reserving 21 more must be rejected',
  );
});

test('stock reservation: unknown batch 404s', async () => {
  await assert.rejects(
    () => svc.createStockReservation({ inventoryBatchId: crypto.randomUUID(), reservedQty: 1 }, principal()),
    NotFoundException,
  );
});

test('stock reservation: a batch QC dispositioned REJECT has zero eligible stock', async () => {
  const batchId = await freshBatch(100, { qcResult: 'REJECT' });
  await assert.rejects(
    () => svc.createStockReservation({ inventoryBatchId: batchId, reservedQty: 1 }, principal()),
    ConflictException,
  );
});

test('stock reservation: a batch QC dispositioned REWORK has zero eligible stock (RP-QC-002 eligibility)', async () => {
  const batchId = await freshBatch(100, { qcResult: 'REWORK' });
  await assert.rejects(
    () => svc.createStockReservation({ inventoryBatchId: batchId, reservedQty: 1 }, principal()),
    ConflictException,
  );
});

test('stock reservation: release frees the hold so it can be re-reserved', async () => {
  const batchId = await freshBatch(20);
  const held = await svc.createStockReservation({ inventoryBatchId: batchId, reservedQty: 20 }, principal());
  await assert.rejects(
    () => svc.createStockReservation({ inventoryBatchId: batchId, reservedQty: 1 }, principal()),
    ConflictException,
  );
  await svc.releaseStockReservation(held.stockReservationId, principal());
  const rebooked = await svc.createStockReservation({ inventoryBatchId: batchId, reservedQty: 20 }, principal());
  assert.equal(Number(rebooked.reservedQty), 20);
});

test('stock reservation: releasing an already-released reservation is rejected (no double-release)', async () => {
  const batchId = await freshBatch(10);
  const held = await svc.createStockReservation({ inventoryBatchId: batchId, reservedQty: 10 }, principal());
  await svc.releaseStockReservation(held.stockReservationId, principal());
  await assert.rejects(
    () => svc.releaseStockReservation(held.stockReservationId, principal()),
    ConflictException,
  );
});

test('stock reservation: concurrent over-reservation attempts never exceed on-hand stock', async () => {
  // 5 concurrent requests for 30 units each against a 100-unit batch: naive unguarded code lets
  // all 5 through (150 > 100). The transactional, row-locked guard must let through at most 3
  // (90) and reject the rest.
  const batchId = await freshBatch(100);
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      svc.createStockReservation({ inventoryBatchId: batchId, reservedQty: 30 }, principal()),
    ),
  );
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  for (const r of results) {
    if (r.status === 'rejected') assert.ok(r.reason instanceof ConflictException);
  }
  assert.ok(succeeded.length <= 3, `at most 3 of 5 concurrent 30-unit reservations can fit in 100 (got ${succeeded.length})`);

  const sql = testClient();
  const totalReserved = (
    await sql`select coalesce(sum(reserved_qty),0)::float as total from inventory.stock_reservation
               where inventory_batch_id = ${batchId} and released_dt is null`
  )[0]!.total;
  assert.ok(totalReserved <= 100, `total reserved (${totalReserved}) must never exceed on-hand (100)`);
  assert.equal(totalReserved, succeeded.length * 30);
});

test('stock reservation: the generic EditService editor can no longer PATCH status/reservedQty directly (bypass closed)', async () => {
  const batchId = await freshBatch(50);
  const held = await svc.createStockReservation({ inventoryBatchId: batchId, reservedQty: 10 }, principal());
  const p = principal({ permissions: ['inventory:stock_reservation:write'] });
  await assert.rejects(
    () => editSvc.update('reservations', held.stockReservationId, { status: 'RELEASED', reservedQty: 999 }, p),
    /No editable fields supplied/,
  );
});
