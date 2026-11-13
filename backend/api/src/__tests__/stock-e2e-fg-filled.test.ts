/**
 * STOCK-E2E-1 — a finished-goods batch cannot hold more than its package order filled.
 *
 * Found by the raw-material-to-sale rehearsal (docs/plan/stock-e2e-rehearsal.md, STK-4): an oil batch
 * of 499.676 g was put on a package order of 14 x 50 g, 14 units were recorded as filled, and the
 * finished-goods batch was then accepted at 59 units. Finished stock is whatever producedQty says
 * (fg-stock reads it), so 45 units that were never filled became available to reserve, label and
 * ship. The filling session is the record of what went into packs; the batch is bounded by it, in the
 * same unit, across every batch made on that order.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { BatchService as PackagingBatchService } from '../../../cluster-packaging/src/batch/batch.service.js';
import { ensureSchema, testClient, packagingDb, principal } from '../../../test-support/db.js';

before(async () => { await ensureSchema(); });
after(async () => { await testClient().end(); });

async function filledOrder(filled: number, rejected = 0) {
  const sql = testClient();
  const uomId = crypto.randomUUID();
  const oilBatchId = crypto.randomUUID();
  const packageOrderId = crypto.randomUUID();
  const fillingSessionId = crypto.randomUUID();
  await sql`insert into production.oil_batch_master (oil_batch_id, status) values (${oilBatchId}, 'RELEASED')`;
  await sql`insert into packaging.package_order (package_order_id, oil_batch_id, order_qty, uom_id, status)
    values (${packageOrderId}, ${oilBatchId}, ${filled + rejected}, ${uomId}, 'COMPLETED')`;
  await sql`insert into packaging.filling_session (filling_session_id, package_order_id, status)
    values (${fillingSessionId}, ${packageOrderId}, 'COMPLETED')`;
  await sql`insert into packaging.filling_session_details (filling_session_detail_id, filling_session_id, filled_qty, uom_id, rejected_qty, status)
    values (${crypto.randomUUID()}, ${fillingSessionId}, ${filled}, ${uomId}, ${rejected}, 'ACTIVE')`;
  return { packageOrderId, uomId };
}

const make = (o: { packageOrderId: string; uomId: string }, producedQty: number) =>
  new PackagingBatchService(packagingDb()).produceFinishedGoodBatch(
    { packageOrderId: o.packageOrderId, productSkuId: crypto.randomUUID(), batchNumber: `FG-F-${crypto.randomUUID().slice(0, 8)}`, producedQty, uomId: o.uomId },
    principal(),
  );

test('an FG batch of more units than were filled is refused, and says how many were filled', async () => {
  const o = await filledOrder(14);
  await assert.rejects(() => make(o, 59), (e: unknown) =>
    e instanceof ConflictException && /14/.test((e as Error).message) && /59/.test((e as Error).message));
});

test('the bound is across every batch on the order: 14 filled, 10 made, then 5 more is refused and 4 is not', async () => {
  const o = await filledOrder(14);
  await make(o, 10);
  await assert.rejects(() => make(o, 5), ConflictException);
  const ok = await make(o, 4);
  assert.equal(Number(ok.batch.producedQty), 4);
});

test('rejected units are not finished goods: 12 filled and 2 rejected bounds the batch at 12', async () => {
  const o = await filledOrder(12, 2);
  await assert.rejects(() => make(o, 13), ConflictException);
  const ok = await make(o, 12);
  assert.equal(Number(ok.batch.producedQty), 12);
});
