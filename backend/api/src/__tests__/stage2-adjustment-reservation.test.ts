/**
 * STAGE-2-RP (a): POST /v1/stock-adjustments refuses a decrease that cuts into a reservation.
 *
 * The "raw stock adjustment" sheet (api/src/imports/factory-kinds.ts) refused a decrease that would
 * leave a lot holding less than production has reserved from it at planning (STK-9), but the check
 * lived in the sheet's plan. The single route posted the same decrease without a word: 100 kg on
 * hand, 80 kg reserved for a run, a count correction of -50 was accepted, and the run then went to
 * the floor for 80 kg of a lot that held 50. The check is now in StockService.createStockAdjustment,
 * the function both doors call, so neither can post what the other refuses.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { StockService } from '../../../cluster-inventory/src/stock/stock.service.js';
import { ensureSchema, inventoryDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let svc: StockService;
before(async () => { await ensureSchema(); svc = new StockService(inventoryDb()); });
after(async () => { await closeTestClient(); });

async function uom(code: string): Promise<string> {
  const sql = testClient();
  const [have] = await sql<{ id: string }[]>`select uom_id::text as id from platform.uom_master where uom_code = ${code} limit 1`;
  if (have) return have.id;
  const id = crypto.randomUUID();
  await sql`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values (${id}, ${code}, ${code}, 'ACTIVE')`;
  return id;
}
async function lot(onHand: number, uomId: string | null = null): Promise<string> {
  const sql = testClient();
  const id = crypto.randomUUID(), rmBatchId = crypto.randomUUID();
  await sql`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, quantity_on_hand, uom_id, status)
            values (${id}, ${rmBatchId}, ${crypto.randomUUID()}, ${onHand}, ${uomId}, 'ACTIVE')`;
  await sql`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result, status)
            values (${crypto.randomUUID()}, ${rmBatchId}, 'ACCEPT', 'ACTIVE')`;
  return id;
}
const onHand = async (id: string) => Number((await testClient()`select quantity_on_hand::text as q from inventory.inventory_batch where inventory_batch_id = ${id}`)[0]!.q);
const adjustments = async (id: string) => Number((await testClient()`select count(*)::int as n from inventory.stock_adjustment where inventory_batch_id = ${id}`)[0]!.n);

test('a decrease that cuts into a reservation is refused, and nothing is written', async () => {
  const id = await lot(100);
  await svc.createStockReservation({ inventoryBatchId: id, reservedQty: 80 }, principal());
  await assert.rejects(
    () => svc.createStockAdjustment({ inventoryBatchId: id, adjustmentQty: -50, adjustmentReason: 'count' } as never, principal()),
    (e: unknown) => e instanceof ConflictException && /reserved for production/.test((e as Error).message) && /cuts into the reservation/.test((e as Error).message),
  );
  assert.equal(await onHand(id), 100, 'the stock figure is untouched');
  assert.equal(await adjustments(id), 0, 'no adjustment row is left behind');
});

test('a decrease down to exactly what is reserved is accepted; one more unit is not', async () => {
  const id = await lot(100);
  await svc.createStockReservation({ inventoryBatchId: id, reservedQty: 80 }, principal());
  await svc.createStockAdjustment({ inventoryBatchId: id, adjustmentQty: -20, adjustmentReason: 'count' } as never, principal());
  assert.equal(await onHand(id), 80);
  await assert.rejects(
    () => svc.createStockAdjustment({ inventoryBatchId: id, adjustmentQty: -1, adjustmentReason: 'count' } as never, principal()),
    ConflictException,
  );
  assert.equal(await onHand(id), 80);
});

test('a released reservation no longer holds the stock, and an increase is never refused for a reservation', async () => {
  const id = await lot(100);
  const r = await svc.createStockReservation({ inventoryBatchId: id, reservedQty: 80 }, principal());
  await svc.createStockAdjustment({ inventoryBatchId: id, adjustmentQty: 5, adjustmentReason: 'count' } as never, principal());
  assert.equal(await onHand(id), 105);
  await testClient()`update inventory.stock_reservation set released_dt = now(), status = 'RELEASED' where stock_reservation_id = ${r.stockReservationId}`;
  await svc.createStockAdjustment({ inventoryBatchId: id, adjustmentQty: -50, adjustmentReason: 'count' } as never, principal());
  assert.equal(await onHand(id), 55);
});

test('a lot with no reservation is adjusted as before, and still cannot go below zero', async () => {
  const id = await lot(10);
  await svc.createStockAdjustment({ inventoryBatchId: id, adjustmentQty: -4, adjustmentReason: 'count' } as never, principal());
  assert.equal(await onHand(id), 6);
  await assert.rejects(
    () => svc.createStockAdjustment({ inventoryBatchId: id, adjustmentQty: -7, adjustmentReason: 'count' } as never, principal()),
    (e: unknown) => e instanceof ConflictException && /negative/.test((e as Error).message),
  );
});

test('the reservation is compared in the lot\'s unit: 2 kg on hand, 1500 g reserved, a decrease of 1 kg is refused', async () => {
  const kg = await uom('KG'), g = await uom('G');
  const id = await lot(2, kg);
  await svc.createStockReservation({ inventoryBatchId: id, reservedQty: 1500, uomId: g }, principal());
  await assert.rejects(
    () => svc.createStockAdjustment({ inventoryBatchId: id, adjustmentQty: -1, uomId: kg, adjustmentReason: 'count' } as never, principal()),
    (e: unknown) => e instanceof ConflictException && /cuts into the reservation/.test((e as Error).message),
  );
  await svc.createStockAdjustment({ inventoryBatchId: id, adjustmentQty: -0.5, uomId: kg, adjustmentReason: 'count' } as never, principal());
  assert.equal(await onHand(id), 1.5);
});
