/**
 * RP-FAC2 — package order guarded state machine (OrdersService, backend/cluster-packaging/src/
 * orders/orders.service.ts, RP-PKG-001, §33). Before this lane's change a package order sat
 * permanently in DRAFT — status never advanced, materials issuance was an unguarded boolean flip,
 * and any two operators could open concurrent filling sessions on the same order. Covers: the
 * released-oil gate at creation, the guarded DRAFT->MATERIALS_ISSUED issue-materials step
 * (shortage rejection + happy path), the single-writer filling-session guard (duplicate/
 * concurrent ACTIVE sessions), wrong-state recordFilling/endFillingSession, complete's yield
 * roll-up, and cancel's issued-flag reversal.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrdersService } from '../../../cluster-packaging/src/orders/orders.service.js';
import { ensureSchema, packagingDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let svc: OrdersService;

before(async () => {
  await ensureSchema();
  svc = new OrdersService(packagingDb());
});

after(async () => {
  await closeTestClient();
});

async function releasedOilBatch() {
  const sql = testClient();
  const id = crypto.randomUUID();
  await sql`insert into production.oil_batch_master (oil_batch_id, status) values (${id}, 'RELEASED')`;
  return id;
}

async function freshOrderWithItem(materialAvailable: number, requiredQty: number) {
  const sql = testClient();
  const oilBatchId = await releasedOilBatch();
  const order = await svc.createPackageOrder({ productSkuId: crypto.randomUUID(), oilBatchId, orderQty: 100 }, principal());
  const materialId = crypto.randomUUID();
  await sql`insert into packaging.package_order_item
    (package_order_item_id, package_order_id, packaging_material_id, required_qty, issued_qty, status)
    values (${crypto.randomUUID()}, ${order.order.packageOrderId}, ${materialId}, ${requiredQty}, false, 'ACTIVE')`;
  await sql`insert into inventory.inventory_batch (inventory_batch_id, material_id, quantity_on_hand, status)
    values (${crypto.randomUUID()}, ${materialId}, ${materialAvailable}, 'ACTIVE')`;
  return order.order.packageOrderId;
}

test('package order: cannot open against oil that is not RELEASED', async () => {
  const sql = testClient();
  const oilBatchId = crypto.randomUUID();
  await sql`insert into production.oil_batch_master (oil_batch_id, status) values (${oilBatchId}, 'IN_MATURATION')`;
  await assert.rejects(
    () => svc.createPackageOrder({ productSkuId: crypto.randomUUID(), oilBatchId, orderQty: 10 }, principal()),
    ConflictException,
  );
});

test('package order: unknown oil batch 404s', async () => {
  await assert.rejects(
    () => svc.createPackageOrder({ productSkuId: crypto.randomUUID(), oilBatchId: crypto.randomUUID(), orderQty: 10 }, principal()),
    NotFoundException,
  );
});

test('package order: issue-materials happy path moves DRAFT -> MATERIALS_ISSUED', async () => {
  const orderId = await freshOrderWithItem(100, 40);
  const { order } = await svc.issuePackagingMaterials(orderId, principal());
  assert.equal(order.status, 'MATERIALS_ISSUED');
});

test('package order: issue-materials rejects the WHOLE issue on a shortage (no partial issuance)', async () => {
  const orderId = await freshOrderWithItem(10, 40);
  await assert.rejects(() => svc.issuePackagingMaterials(orderId, principal()), ConflictException);
  const order = await svc.getPackageOrder(orderId);
  assert.equal(order!.status, 'DRAFT', 'a rejected issue must leave the order in DRAFT');
});

test('package order: cannot issue materials twice (invalid transition)', async () => {
  const orderId = await freshOrderWithItem(100, 40);
  await svc.issuePackagingMaterials(orderId, principal());
  await assert.rejects(() => svc.issuePackagingMaterials(orderId, principal()), ConflictException);
});

test('package order: concurrent issue-materials calls — only one wins', async () => {
  const orderId = await freshOrderWithItem(100, 40);
  const results = await Promise.allSettled([
    svc.issuePackagingMaterials(orderId, principal()),
    svc.issuePackagingMaterials(orderId, principal()),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('package order: filling session cannot start before materials are issued (wrong state)', async () => {
  const orderId = await freshOrderWithItem(100, 40);
  await assert.rejects(
    () => svc.startFillingSession({ packageOrderId: orderId }, principal()),
    ConflictException,
  );
});

test('package order: filling session start advances order to IN_PROGRESS; a second concurrent ACTIVE session is refused', async () => {
  const orderId = await freshOrderWithItem(100, 40);
  await svc.issuePackagingMaterials(orderId, principal());
  const session = await svc.startFillingSession({ packageOrderId: orderId }, principal());
  const order = await svc.getPackageOrder(orderId);
  assert.equal(order!.status, 'IN_PROGRESS');

  await assert.rejects(
    () => svc.startFillingSession({ packageOrderId: orderId }, principal()),
    ConflictException,
    'single-writer guard: only one ACTIVE filling session per order',
  );

  await assert.doesNotReject(() => svc.recordFilling(session.fillingSessionId, { filledQty: 30, rejectedQty: 2 }, principal()));
});

test('package order: recordFilling refuses once the session has ended (wrong state)', async () => {
  const orderId = await freshOrderWithItem(100, 40);
  await svc.issuePackagingMaterials(orderId, principal());
  const session = await svc.startFillingSession({ packageOrderId: orderId }, principal());
  await svc.endFillingSession(session.fillingSessionId, {}, principal());
  await assert.rejects(
    () => svc.recordFilling(session.fillingSessionId, { filledQty: 5, rejectedQty: 0 }, principal()),
    ConflictException,
  );
  await assert.rejects(() => svc.endFillingSession(session.fillingSessionId, {}, principal()), ConflictException);
});

test('package order: complete rolls up filled/rejected qty and refuses while a session is still ACTIVE', async () => {
  const orderId = await freshOrderWithItem(100, 40);
  await svc.issuePackagingMaterials(orderId, principal());
  const session = await svc.startFillingSession({ packageOrderId: orderId }, principal());
  await svc.recordFilling(session.fillingSessionId, { filledQty: 36, rejectedQty: 4 }, principal());

  await assert.rejects(() => svc.completePackageOrder(orderId, principal()), ConflictException);

  await svc.endFillingSession(session.fillingSessionId, {}, principal());
  const { order, filledQty, rejectedQty } = await svc.completePackageOrder(orderId, principal());
  assert.equal(order.status, 'COMPLETED');
  assert.equal(filledQty, 36);
  assert.equal(rejectedQty, 4);
});

test('package order: cancel from MATERIALS_ISSUED reverses the issued flag', async () => {
  const orderId = await freshOrderWithItem(100, 40);
  await svc.issuePackagingMaterials(orderId, principal());
  const cancelled = await svc.cancelPackageOrder(orderId, principal());
  assert.equal(cancelled.status, 'CANCELLED');

  const items = await svc.listPackageOrderItems({ limit: 100 } as never);
  const forOrder = items.items.filter((i) => i.packageOrderId === orderId);
  assert.ok(forOrder.every((i) => i.issuedQty === false));
});

test('package order: cannot cancel a COMPLETED order (terminal state)', async () => {
  const orderId = await freshOrderWithItem(100, 40);
  await svc.issuePackagingMaterials(orderId, principal());
  const session = await svc.startFillingSession({ packageOrderId: orderId }, principal());
  await svc.endFillingSession(session.fillingSessionId, {}, principal());
  await svc.completePackageOrder(orderId, principal());
  await assert.rejects(() => svc.cancelPackageOrder(orderId, principal()), ConflictException);
});
