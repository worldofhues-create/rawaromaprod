/**
 * G3 rule: production order + resolved material needs + available RM short → stock requirement
 * → DRAFT purchase request (grouped per vendor mapping) → RFQ draft; never a purchase order
 * (backend/api/src/automation/material-shortage.service.ts).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSchema, testClient, closeTestClient } from '../../../../test-support/db.js';
import { MaterialShortageService } from '../material-shortage.service.js';

let svc: MaterialShortageService;

before(async () => {
  await ensureSchema();
  svc = new MaterialShortageService(testClient() as never);
});
after(async () => {
  await closeTestClient();
});

function applyOne(productionOrderId: string): Promise<void> {
  return (svc as unknown as { applyOne(id: string): Promise<void> }).applyOne(productionOrderId);
}

async function freshOrder(): Promise<string> {
  const sql = testClient();
  const id = randomUUID();
  await sql`insert into production.production_order (production_order_id, order_qty, status) values (${id}, 100, 'PLANNING')`;
  return id;
}

async function addIngredient(productionOrderId: string, materialId: string, requiredQty: number): Promise<void> {
  const sql = testClient();
  await sql`insert into production.production_order_ingredients (production_order_id, material_id, required_qty, issued_qty, status)
    values (${productionOrderId}, ${materialId}, ${requiredQty}, false, 'PENDING')`;
}

async function stockOnHand(materialId: string, qty: number): Promise<void> {
  const sql = testClient();
  await sql`insert into inventory.inventory_batch (rm_batch_id, material_id, quantity_on_hand, status) values (${randomUUID()}, ${materialId}, ${qty}, 'ACTIVE')`;
}

test('no shortage: sufficient unreserved stock drafts nothing', async () => {
  const orderId = await freshOrder();
  const materialId = randomUUID();
  await addIngredient(orderId, materialId, 10);
  await stockOnHand(materialId, 50);

  await applyOne(orderId);

  const sql = testClient();
  const prs = await sql`select count(*)::int as c from procurement.purchase_request where stock_requirement_id in
    (select stock_requirement_id from procurement.stock_requirement where requirement_source = ${'PRODUCTION_ORDER:' + orderId})`;
  assert.equal(prs[0]?.c, 0);
});

test('shortage: drafts a stock requirement + DRAFT purchase request + RFQ, never a purchase order', async () => {
  const orderId = await freshOrder();
  const materialId = randomUUID();
  await addIngredient(orderId, materialId, 100);
  await stockOnHand(materialId, 20); // short by 80

  await applyOne(orderId);

  const sql = testClient();
  const reqs = await sql`select stock_requirement_id, required_qty from procurement.stock_requirement where material_id = ${materialId}`;
  assert.equal(reqs.length, 1);
  assert.equal(Number(reqs[0]?.required_qty), 80);

  const items = await sql`select pr.status as pr_status, i.required_qty from procurement.purchase_request_items i
    join procurement.purchase_request pr on pr.purchase_request_id = i.purchase_request_id
    where i.material_id = ${materialId}`;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.pr_status, 'DRAFT');
  assert.equal(Number(items[0]?.required_qty), 80);

  const rfqItems = await sql`select r.status as rfq_status from procurement.rfq_items i join procurement.rfq_master r on r.rfq_id = i.rfq_id where i.material_id = ${materialId}`;
  assert.equal(rfqItems.length, 1);
  assert.equal(rfqItems[0]?.rfq_status, 'DRAFT');

  const purchaseOrders = await sql`select count(*)::int as c from procurement.purchase_order where purchase_request_id in
    (select purchase_request_id from procurement.purchase_request where stock_requirement_id = ${reqs[0]?.stock_requirement_id})`;
  assert.equal(purchaseOrders[0]?.c, 0, 'the rule must never auto-issue a purchase order');
});

test('short materials are grouped into one DRAFT PR per preferred vendor', async () => {
  const orderId = await freshOrder();
  const materialA = randomUUID();
  const materialB = randomUUID();
  const vendorA = randomUUID();
  const vendorB = randomUUID();

  const sql = testClient();
  await sql`insert into procurement.vendor_details (vendor_id, vendor_name, status) values (${vendorA}, 'Vendor A', 'ACTIVE')`;
  await sql`insert into procurement.vendor_details (vendor_id, vendor_name, status) values (${vendorB}, 'Vendor B', 'ACTIVE')`;
  await sql`insert into procurement.vendor_rm_mapping (vendor_id, material_id, is_preferred, status) values (${vendorA}, ${materialA}, true, 'ACTIVE')`;
  await sql`insert into procurement.vendor_rm_mapping (vendor_id, material_id, is_preferred, status) values (${vendorB}, ${materialB}, true, 'ACTIVE')`;

  await addIngredient(orderId, materialA, 50);
  await addIngredient(orderId, materialB, 50);
  // both fully short — no stock at all

  await applyOne(orderId);

  const prCount = await sql`select count(distinct i.purchase_request_id)::int as c
    from procurement.purchase_request_items i
    where i.material_id in (${materialA}, ${materialB})`;
  assert.equal(prCount[0]?.c, 2, 'two vendors → two separate DRAFT purchase requests');
});

test('a material with no vendor mapping still gets a draft PR (actionable, not dropped)', async () => {
  const orderId = await freshOrder();
  const materialId = randomUUID();
  await addIngredient(orderId, materialId, 30);
  // no stock, no vendor mapping at all

  await applyOne(orderId);

  const sql = testClient();
  const items = await sql`select pr.status as pr_status from procurement.purchase_request_items i
    join procurement.purchase_request pr on pr.purchase_request_id = i.purchase_request_id
    where i.material_id = ${materialId}`;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.pr_status, 'DRAFT');
});

test('duplicate delivery of the same production_order.created event drafts nothing twice', async () => {
  const orderId = await freshOrder();
  const materialId = randomUUID();
  await addIngredient(orderId, materialId, 100);
  // no stock — fully short

  await applyOne(orderId);
  await applyOne(orderId); // redelivery
  await applyOne(orderId);

  const sql = testClient();
  const reqs = await sql`select count(*)::int as c from procurement.stock_requirement where material_id = ${materialId}`;
  assert.equal(reqs[0]?.c, 1, 'exactly one stock requirement despite 3 delivery attempts');

  const items = await sql`select count(*)::int as c from procurement.purchase_request_items where material_id = ${materialId}`;
  assert.equal(items[0]?.c, 1, 'exactly one purchase-request line despite 3 delivery attempts');
});
