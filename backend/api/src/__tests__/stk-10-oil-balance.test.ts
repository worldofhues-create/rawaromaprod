/**
 * STOCK-FIX-RP (STK-10, STK-11): the finished side of the stock equation, through the real services.
 *
 * The rehearsal (docs/plan/stock-e2e-rehearsal.md section 3) packed 14 x 50 g (700,000 mg) from an oil
 * batch of 499,676 mg and was accepted; the oil's produced_qty never moved after a fill; a QC-failed
 * batch's 999,345 mg was never written off; no loss, yield or remnant was recorded anywhere. Each test
 * here is one of those cases, in integer mg: made = the weighed mass, packing draws it down by packs x
 * net content, the remnant is counted and kept, held or written off with a reason, and the equation
 * made = packed + rejected + loss + written off + remaining holds for every batch.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { OrdersService } from '../../../cluster-packaging/src/orders/orders.service.js';
import { BatchService } from '../../../cluster-production/src/batch/batch.service.js';
import { ensureSchema, testClient, packagingDb, productionDb, principal, closeTestClient } from '../../../test-support/db.js';

let orders: OrdersService;
let batches: BatchService;
let pcs: string;
let g: string;
const WRITE_OFF = principal({ roles: ['production'], permissions: ['production:oil_batch:write_off', 'production:oil_batch_remnant:write'] });

before(async () => {
  await ensureSchema();
  orders = new OrdersService(packagingDb());
  batches = new BatchService(productionDb());
  const sql = testClient();
  const uom = async (code: string) => {
    await sql`insert into platform.uom_master (uom_code, uom_name, status) values (${code}, ${code}, 'ACTIVE') on conflict (uom_code) do nothing`;
    return (await sql<{ uom_id: string }[]>`select uom_id::text from platform.uom_master where uom_code = ${code}`)[0]!.uom_id;
  };
  pcs = await uom('pcs');
  g = await uom('g');
});
after(async () => { await closeTestClient(); });

async function sku(netContentMg: number | null, packSize: string | null = null) {
  const id = crypto.randomUUID();
  await testClient()`insert into packaging.product_sku (product_sku_id, sku_code, pack_size, net_content_mg, uom_id, status)
    values (${id}, ${'STK10-' + id.slice(0, 8)}, ${packSize}, ${netContentMg}, ${pcs}, 'ACTIVE')`;
  return id;
}

/** An oil batch made through the real produce path (the floor passes producedMg), then RELEASED. */
async function oil(madeMg: number, release = true) {
  const made = await batches.produceOilBatch({ productionOrderId: crypto.randomUUID(), batchNumber: `B-STK10-${crypto.randomUUID().slice(0, 6)}`, producedQty: madeMg / 1000, producedMg: madeMg, uomId: g }, principal());
  const id = made.batch.oilBatchId;
  if (release) await testClient()`update production.oil_batch_master set status = 'RELEASED' where oil_batch_id = ${id}`;
  return id;
}

async function fill(oilBatchId: string, skuId: string, orderQty: number, filled: number, rejected = 0) {
  const sql = testClient();
  const { order } = await orders.createPackageOrder({ productSkuId: skuId, oilBatchId, orderQty, uomId: pcs }, principal());
  await sql`update packaging.package_order set status = 'MATERIALS_ISSUED' where package_order_id = ${order.packageOrderId}`;
  const session = await orders.startFillingSession({ packageOrderId: order.packageOrderId }, principal());
  await orders.recordFilling(session.fillingSessionId, { filledQty: filled, rejectedQty: rejected, uomId: pcs }, principal());
  await orders.endFillingSession(session.fillingSessionId, {}, principal());
  await orders.completePackageOrder(order.packageOrderId, principal());
  return order.packageOrderId;
}

const balanced = (b: { madeMg: number | null; packedMg: number; rejectedMg: number; lossMg: number; writtenOffMg: number; remainingMg: number | null }) =>
  b.madeMg === b.packedMg + b.rejectedMg + b.lossMg + b.writtenOffMg + (b.remainingMg ?? 0);

test('made is the weighed mass, exact in mg, and is the oil the batch holds before any packing', async () => {
  const id = await oil(499_676);
  const b = await batches.oilBatchBalance(id);
  assert.equal(b.madeMg, 499_676);
  assert.equal(b.remainingMg, 499_676);
  assert.equal(b.packedMg, 0);
});

test('STK-11: a package order of 14 x 50 g (700,000 mg) against 499,676 mg is refused, with the numbers', async () => {
  const id = await oil(499_676);
  const s50 = await sku(50_000);
  await assert.rejects(() => orders.createPackageOrder({ productSkuId: s50, oilBatchId: id, orderQty: 14, uomId: pcs }, principal()),
    (e: unknown) => e instanceof ConflictException && /499,676 mg/.test((e as Error).message) && /700,000 mg/.test((e as Error).message));
});

test('an open package order holds its oil: 9 x 50 g ordered, a second order of 1 x 50 g is refused (500,000 > 499,676)', async () => {
  const id = await oil(499_676);
  const s50 = await sku(50_000);
  await orders.createPackageOrder({ productSkuId: s50, oilBatchId: id, orderQty: 9, uomId: pcs }, principal());
  await assert.rejects(() => orders.createPackageOrder({ productSkuId: s50, oilBatchId: id, orderQty: 1, uomId: pcs }, principal()), ConflictException);
  const b = await batches.oilBatchBalance(id);
  assert.equal(b.committedMg, 450_000);
  assert.equal(b.freeMg, 49_676);
});

test('STK-10: packing draws the oil down by packs x net content; a fill beyond what remains is refused', async () => {
  const id = await oil(499_676);
  const s50 = await sku(null, '50 g'); // no net_content_mg: the plain-mass pack size is read exactly
  const sql = testClient();
  const { order } = await orders.createPackageOrder({ productSkuId: s50, oilBatchId: id, orderQty: 9, uomId: pcs }, principal());
  await sql`update packaging.package_order set status = 'MATERIALS_ISSUED' where package_order_id = ${order.packageOrderId}`;
  const session = await orders.startFillingSession({ packageOrderId: order.packageOrderId }, principal());
  await assert.rejects(() => orders.recordFilling(session.fillingSessionId, { filledQty: 10, rejectedQty: 0, uomId: pcs }, principal()),
    (e: unknown) => e instanceof ConflictException && /more than the batch holds/.test((e as Error).message));
  await orders.recordFilling(session.fillingSessionId, { filledQty: 8, rejectedQty: 1, uomId: pcs }, principal());
  const b = await batches.oilBatchBalance(id);
  assert.equal(b.packedMg, 400_000);
  assert.equal(b.rejectedMg, 50_000);
  assert.equal(b.remainingMg, 49_676);
  assert.ok(balanced(b));
  const n = await sql<{ n: number }[]>`select count(*)::int as n from packaging.filling_session_details where filling_session_id = ${session.fillingSessionId}`;
  assert.equal(n[0]!.n, 1, 'the refused fill left no filling record behind');
});

test('a fill with no way to size a pack is refused, never left undrawn: a SKU in ml with no net content', async () => {
  const id = await oil(100_000);
  const ml = await sku(null, '10 ml');
  await assert.rejects(() => orders.createPackageOrder({ productSkuId: ml, oilBatchId: id, orderQty: 1, uomId: pcs }, principal()),
    (e: unknown) => e instanceof ConflictException && /net content/.test((e as Error).message));
});

test('oil with no measured mass cannot be packed (fail closed)', async () => {
  const id = crypto.randomUUID();
  await testClient()`insert into production.oil_batch_master (oil_batch_id, batch_number, status) values (${id}, 'B-UNMEASURED', 'RELEASED')`;
  const s = await sku(50_000);
  await assert.rejects(() => orders.createPackageOrder({ productSkuId: s, oilBatchId: id, orderQty: 1, uomId: pcs }, principal()),
    (e: unknown) => e instanceof ConflictException && /no made quantity/.test((e as Error).message));
});

test('the remnant: a count under the book is a LOSS with a reason; KEEP leaves it packable; WRITE_OFF needs the named role', async () => {
  const id = await oil(499_676);
  await fill(id, await sku(50_000), 9, 9);
  await assert.rejects(() => batches.recordOilRemnant(id, { weighedMg: 49_000, disposition: 'KEEP' }, WRITE_OFF),
    (e: unknown) => e instanceof ConflictException && /676 mg under the book/.test((e as Error).message));
  await assert.rejects(() => batches.recordOilRemnant(id, { weighedMg: 50_000, disposition: 'KEEP', reason: 'x' }, WRITE_OFF),
    (e: unknown) => e instanceof ConflictException && /more than was made/.test((e as Error).message));
  const kept = await batches.recordOilRemnant(id, { weighedMg: 49_000, disposition: 'KEEP', reason: 'residue in the vessel' }, WRITE_OFF);
  assert.equal(kept!.lossMg, 676);
  assert.equal(kept!.remainingMg, 49_000);
  assert.equal(kept!.remnant!.disposition, 'KEEP');
  // Packed later from the kept remnant: 4 x 10 g.
  await fill(id, await sku(10_000), 4, 4);
  const later = await batches.oilBatchBalance(id);
  assert.equal(later.remainingMg, 9_000);
  // A production operator without the write-off grant is refused; the named role writes it off.
  await assert.rejects(() => batches.recordOilRemnant(id, { weighedMg: 9_000, disposition: 'WRITE_OFF', reason: 'below a pack' }, principal()), ForbiddenException);
  const off = await batches.recordOilRemnant(id, { weighedMg: 9_000, disposition: 'WRITE_OFF', reason: 'below a pack' }, WRITE_OFF);
  assert.equal(off!.writtenOffMg, 9_000);
  assert.equal(off!.remainingMg, 0);
  assert.equal(off!.yieldBp, Math.round((490_000 * 10000) / 499_676));
  assert.ok(balanced(off!));
  const [who] = await testClient()<{ recorded_by: string; recorded_role: string; reason: string }[]>`
    select recorded_by, recorded_role, reason from production.oil_batch_movement where oil_batch_id = ${id} and kind = 'WRITE_OFF'`;
  assert.equal(who!.recorded_role, 'production');
  assert.equal(who!.reason, 'below a pack');
});

test('a HELD remnant stops packing until it is decided again', async () => {
  const id = await oil(200_000);
  await batches.recordOilRemnant(id, { weighedMg: 200_000, disposition: 'HOLD', reason: 'odour check' }, WRITE_OFF);
  const s = await sku(50_000);
  await assert.rejects(() => orders.createPackageOrder({ productSkuId: s, oilBatchId: id, orderQty: 1, uomId: pcs }, principal()),
    (e: unknown) => e instanceof ConflictException && /on hold/.test((e as Error).message));
  await batches.recordOilRemnant(id, { weighedMg: 200_000, disposition: 'KEEP' }, WRITE_OFF);
  await assert.doesNotReject(() => orders.createPackageOrder({ productSkuId: s, oilBatchId: id, orderQty: 4, uomId: pcs }, principal()));
});

test('a FAILED batch is written off explicitly: it cannot be kept, and the write-off balances the equation', async () => {
  const id = await oil(999_345, false);
  await batches.transitionOilBatch(id, 'FAILED', principal());
  const before = await batches.oilBatchBalance(id);
  assert.equal(before.remainingMg, 999_345, 'until someone writes it off, the failed oil is still on the book and the reconciliation lists it');
  await assert.rejects(() => batches.recordOilRemnant(id, { weighedMg: 999_345, disposition: 'KEEP' }, WRITE_OFF),
    (e: unknown) => e instanceof ConflictException && /FAILED/.test((e as Error).message));
  const off = await batches.recordOilRemnant(id, { weighedMg: 999_345, disposition: 'WRITE_OFF', reason: 'QC 1 fail' }, WRITE_OFF);
  assert.equal(off!.writtenOffMg, 999_345);
  assert.equal(off!.remainingMg, 0);
  assert.ok(balanced(off!));
});

test('the ledger is append-only: a movement cannot be rewritten or deleted, even by the owner connection', async () => {
  const id = await oil(1_000);
  const sql = testClient();
  await assert.rejects(() => sql`update production.oil_batch_movement set delta_mg = 2000 where oil_batch_id = ${id}`, /append-only/);
  await assert.rejects(() => sql`delete from production.oil_batch_movement where oil_batch_id = ${id}`, /append-only/);
});

test('two fills racing for the last pack: exactly one wins', async () => {
  const id = await oil(100_000);
  const s50 = await sku(50_000);
  const sql = testClient();
  const open = async () => {
    const { order } = await orders.createPackageOrder({ productSkuId: s50, oilBatchId: id, orderQty: 1, uomId: pcs }, principal());
    await sql`update packaging.package_order set status = 'MATERIALS_ISSUED' where package_order_id = ${order.packageOrderId}`;
    return orders.startFillingSession({ packageOrderId: order.packageOrderId }, principal());
  };
  const a = await open();
  const b = await open();
  // Both orders are inside the batch (2 x 50 g = 100 g). Now each tries to fill 2 packs.
  const r = await Promise.allSettled([
    orders.recordFilling(a.fillingSessionId, { filledQty: 2, uomId: pcs }, principal()),
    orders.recordFilling(b.fillingSessionId, { filledQty: 2, uomId: pcs }, principal()),
  ]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  const bal = await batches.oilBatchBalance(id);
  assert.equal(bal.remainingMg, 0);
});
