/**
 * G1/PB-08 (FINAL_OS §2.3/§41, ledger PB-08) — OrdersService's break-glass MANUAL CONTINUITY
 * path (backend/cluster-sales/src/orders/orders.service.ts). Permission-layer refusal (who may
 * call these routes at all) is covered by permissions-guard.test.ts +
 * ra-roles-g1-manual-continuity.test.ts; this file covers what the SERVICE itself does once a
 * call is let through: every write stamps `origin = MANUAL_CONTINUITY` + the caller's reason on
 * the sales_order row, and reports the action toward ALEMBIC via `bridge.outbox`
 * (emitBridgeManualEvent) alongside this cluster's own `sales.outbox` audit event — for
 * create, confirm, and standalone item-add alike.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { OrdersService } from '../../../cluster-sales/src/orders/orders.service.js';
import { ensureSchema, salesDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let svc: OrdersService;

before(async () => {
  await ensureSchema();
  svc = new OrdersService(salesDb());
});

after(async () => {
  await closeTestClient();
});

const OWNER = '00000000-0000-7000-8000-0000000000a1';

test('manual continuity create: stamps origin=MANUAL_CONTINUITY + the reason on the row', async () => {
  const { salesOrder } = await svc.createSalesOrder(
    {
      customerId: randomUUID(),
      items: [{ productSkuId: randomUUID(), orderedQty: 5, rate: 10, amount: 50 }],
      reason: 'ALEMBIC bridge is down; customer needs this order today',
    },
    principal({ userId: OWNER }),
  );
  assert.equal(salesOrder.origin, 'MANUAL_CONTINUITY');
  assert.equal(salesOrder.continuityReason, 'ALEMBIC bridge is down; customer needs this order today');
  assert.equal(salesOrder.status, 'DRAFT');
});

test('manual continuity create: records BOTH the internal audit event and the ALEMBIC bridge event, in the same transaction as the order', async () => {
  const { salesOrder } = await svc.createSalesOrder(
    {
      customerId: randomUUID(),
      items: [{ productSkuId: randomUUID(), orderedQty: 1, rate: 1, amount: 1 }],
      reason: 'audit trail check',
    },
    principal({ userId: OWNER }),
  );

  const sql = testClient();
  const internal = await sql`select payload from sales.outbox
    where type = 'sales.order.manual_continuity' and aggregate_id = ${salesOrder.salesOrderId}`;
  assert.equal(internal.length, 1, 'exactly one internal manual-continuity audit event');
  assert.equal((internal[0]!.payload as { action: string }).action, 'created');
  assert.equal((internal[0]!.payload as { reason: string }).reason, 'audit trail check');

  const bridge = await sql`select payload from bridge.outbox
    where type = 'SalesOrderManualContinuityCreated' and aggregate_id = ${salesOrder.salesOrderId}`;
  assert.equal(bridge.length, 1, 'exactly one bridge.outbox row toward ALEMBIC');
  assert.equal((bridge[0]!.payload as { reason: string }).reason, 'audit trail check');
});

test('manual continuity confirm: re-stamps the reason + emits its own audit/bridge events', async () => {
  const { salesOrder } = await svc.createSalesOrder(
    {
      customerId: randomUUID(),
      items: [{ productSkuId: randomUUID(), orderedQty: 1, rate: 1, amount: 1 }],
      reason: 'create reason',
    },
    principal({ userId: OWNER }),
  );

  const confirmed = await svc.confirmSalesOrder(
    salesOrder.salesOrderId,
    { reason: 'confirm reason — customer already paid offline' },
    principal({ userId: OWNER }),
  );
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(confirmed.continuityReason, 'confirm reason — customer already paid offline');

  const sql = testClient();
  const bridge = await sql`select 1 from bridge.outbox
    where type = 'SalesOrderManualContinuityConfirmed' and aggregate_id = ${salesOrder.salesOrderId}`;
  assert.equal(bridge.length, 1);
});

test('manual continuity confirm: refuses (NotFoundException) for an unknown sales order', async () => {
  await assert.rejects(
    () => svc.confirmSalesOrder(randomUUID(), { reason: 'x' }, principal({ userId: OWNER })),
    NotFoundException,
  );
});

test('manual continuity item-add: stamps the parent order + emits the item_added audit/bridge events', async () => {
  const { salesOrder } = await svc.createSalesOrder(
    {
      customerId: randomUUID(),
      items: [{ productSkuId: randomUUID(), orderedQty: 1, rate: 1, amount: 1 }],
      reason: 'create reason',
    },
    principal({ userId: OWNER }),
  );

  const item = await svc.createSalesOrderItem(
    {
      salesOrderId: salesOrder.salesOrderId,
      productSkuId: randomUUID(),
      orderedQty: 2,
      rate: 5,
      amount: 10,
      reason: 'customer added a second line by phone',
    },
    principal({ userId: OWNER }),
  );
  assert.equal(item.salesOrderId, salesOrder.salesOrderId);

  const sql = testClient();
  const updated = await sql`select origin, continuity_reason from sales.sales_order where sales_order_id = ${salesOrder.salesOrderId}`;
  assert.equal(updated[0]!.origin, 'MANUAL_CONTINUITY');
  assert.equal(updated[0]!.continuity_reason, 'customer added a second line by phone');

  const bridge = await sql`select 1 from bridge.outbox
    where type = 'SalesOrderManualContinuityItemAdded' and aggregate_id = ${salesOrder.salesOrderId}`;
  assert.equal(bridge.length, 1);
});

test('manual continuity item-add: refuses (NotFoundException) for an unknown parent order', async () => {
  await assert.rejects(
    () =>
      svc.createSalesOrderItem(
        { salesOrderId: randomUUID(), reason: 'x' },
        principal({ userId: OWNER }),
      ),
    NotFoundException,
  );
});
