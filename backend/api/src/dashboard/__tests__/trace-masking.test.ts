/**
 * Security review S1, item 3 — DashboardService.traceFinishedGood. Real Postgres
 * (backend/test-support pattern; the extra masterdata.rm_alias / packaging.product_master /
 * sales.customer_master / sales.sales_order tables the query left-joins were added to
 * backend/test-support/schema.sql for this lane).
 *
 * Before this fix, `GET /v1/trace/finished-good/:id` was fully edge-UNGUARDED (no
 * `@Permissions` at all) — ANY authenticated caller, `platform_super_admin` included, could
 * run a trace. Now:
 *   1. `platform_super_admin` is refused outright (defense-in-depth; it also doesn't hold the
 *      new edge permission `packaging:finished_good_batch_master:read`).
 *   2. without `masterdata:material:reveal`, the response omits vendor identity AND the
 *      per-material detail list entirely — replaced by a masked `materialCount` — because the
 *      vendor+batch/GRN combination correlates "which supplier fed which finished good" even
 *      when the material name itself is alias-masked.
 *   3. WITH reveal, the full detail (material, batch, GRN, vendor) still comes through exactly
 *      as before.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { DashboardService } from '../dashboard.service.js';
import { ensureSchema, testClient, productionDb, productionSchema, principal, closeTestClient } from '../../../../test-support/db.js';
// traceFinishedGood's raw SQL left-joins formula.formula_master (the product's recipe name) —
// that schema lives on its own connection in production (FORMULA_DATABASE_URL) but this lane's
// test DB shares ONE Postgres for everything, same as backend/cluster-formula/src/__tests__/
// db.ts is pointed at via FORMULA_TEST_DATABASE_URL for this lane. Ensure it exists
// independent of test file run order (this file never needs to WRITE to it).
import { ensureSchema as ensureFormulaSchema, closeTestClient as closeFormulaTestClient } from '../../../../cluster-formula/src/__tests__/db.js';

const { productionOrder } = productionSchema;

let sql: ReturnType<typeof testClient>;
let dashboard: DashboardService;
const sid = () => randomUUID().slice(0, 8);

before(async () => {
  await ensureSchema();
  await ensureFormulaSchema();
  sql = testClient();
  dashboard = new DashboardService(sql as any);
});

afterAll(async () => {
  await closeTestClient();
  // The formula-schema connection pool is separate from the main test-support one — must be
  // closed too, or the process never exits (an open postgres.js pool keeps the event loop
  // alive indefinitely).
  await closeFormulaTestClient();
});

/** Seeds one full finished-good -> package_order -> oil_batch -> production_order ->
 * ingredient -> material/alias -> rm_batch -> grn -> vendor chain, plus a customer/dispatch. */
async function seedTraceChain(): Promise<string> {
  const fgId = randomUUID();
  const packageOrderId = randomUUID();
  const productSkuId = randomUUID();
  const productId = randomUUID();
  const oilBatchId = randomUUID();
  const db = productionDb();
  const prodOrderId = (
    await db
      .insert(productionOrder)
      .values({ productionOrderId: randomUUID(), orderQty: '10', status: 'INPROGRESS', createdBy: 'test', updatedBy: 'test' })
      .returning({ id: productionOrder.productionOrderId })
  )[0]!.id;
  const materialId = randomUUID();
  const grnId = randomUUID();
  const grnItemId = randomUUID();
  const vendorId = randomUUID();
  const customerId = randomUUID();
  const salesOrderId = randomUUID();
  const dispatchId = randomUUID();

  await sql`insert into masterdata.material (material_id, material_code, material_name, status) values (${materialId}, ${`MAT-${sid()}`}, 'Bergamot Oil', 'ACTIVE')`;
  await sql`insert into masterdata.rm_alias (rm_alias_id, material_id, alias_name, status) values (${randomUUID()}, ${materialId}, ${`ING-${sid()}`}, 'ACTIVE')`;
  await sql`insert into procurement.vendor_details (vendor_id, vendor_code, vendor_name, status) values (${vendorId}, ${`VEN-${sid()}`}, 'Acme Aromatics', 'ACTIVE')`;
  await sql`insert into inventory.grn_master (grn_id, grn_number, vendor_id, status) values (${grnId}, ${`GRN-${sid()}`}, ${vendorId}, 'ACTIVE')`;
  await sql`insert into inventory.grn_items (grn_item_id, grn_id, material_id, status) values (${grnItemId}, ${grnId}, ${materialId}, 'ACTIVE')`;
  await sql`insert into inventory.rm_batch_master (rm_batch_id, grn_item_id, material_id, batch_number, status) values (${randomUUID()}, ${grnItemId}, ${materialId}, ${`RMB-${sid()}`}, 'ACTIVE')`;
  await sql`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, status) values (${randomUUID()}, ${prodOrderId}, ${materialId}, '5', 'ACTIVE')`;
  await sql`insert into production.oil_batch_master (oil_batch_id, production_order_id, batch_number, produced_qty, status) values (${oilBatchId}, ${prodOrderId}, ${`OIL-${sid()}`}, '5', 'ACTIVE')`;
  await sql`insert into packaging.product_master (product_id, product_code, product_name, status) values (${productId}, ${`PRD-${sid()}`}, 'Signature Eau de Parfum', 'ACTIVE')`;
  await sql`insert into packaging.product_sku (product_sku_id, product_id, sku_code, status) values (${productSkuId}, ${productId}, ${`SKU-${sid()}`}, 'ACTIVE')`;
  await sql`insert into packaging.package_order (package_order_id, product_sku_id, oil_batch_id, status) values (${packageOrderId}, ${productSkuId}, ${oilBatchId}, 'ACTIVE')`;
  await sql`insert into packaging.finished_good_batch_master (finished_good_batch_id, package_order_id, product_sku_id, batch_number, status) values (${fgId}, ${packageOrderId}, ${productSkuId}, ${`FG-${sid()}`}, 'ACTIVE')`;
  await sql`insert into sales.customer_master (customer_id, customer_code, customer_name, status) values (${customerId}, ${`CUS-${sid()}`}, 'Test Customer', 'ACTIVE')`;
  await sql`insert into sales.sales_order (sales_order_id, so_number, customer_id, status) values (${salesOrderId}, ${`SO-${sid()}`}, ${customerId}, 'ACTIVE')`;
  await sql`insert into sales.dispatch_master (dispatch_id, sales_order_id, customer_id, status) values (${dispatchId}, ${salesOrderId}, ${customerId}, 'ACTIVE')`;
  await sql`insert into sales.dispatch_items (dispatch_item_id, dispatch_id, finished_good_batch_id, status) values (${randomUUID()}, ${dispatchId}, ${fgId}, 'ACTIVE')`;

  return fgId;
}

test('item 3: platform_super_admin is refused outright, regardless of permissions', async () => {
  const fgId = await seedTraceChain();
  const p = principal({
    roles: ['platform_super_admin'],
    permissions: ['masterdata:material:reveal', 'formula:actual:read'],
  });
  await assert.rejects(
    () => dashboard.traceFinishedGood(fgId, p),
    (err: unknown) => {
      assert.ok(err instanceof ForbiddenException);
      return true;
    },
  );
});

test('item 3: without masterdata:material:reveal, vendor identity + the per-material list are OMITTED (masked count only)', async () => {
  const fgId = await seedTraceChain();
  const p = principal({ roles: ['admin'], permissions: [] });
  const trace: any = await dashboard.traceFinishedGood(fgId, p);
  assert.ok(trace);
  assert.equal(trace.reveal.material, false);
  assert.deepEqual(trace.materials, [], 'no per-material detail without reveal');
  assert.equal(trace.materialCount, 1, 'a masked count is still returned');
});

test('item 3: WITH masterdata:material:reveal, full material/vendor/batch detail comes through', async () => {
  const fgId = await seedTraceChain();
  const p = principal({ roles: ['qc'], permissions: ['masterdata:material:reveal'] });
  const trace: any = await dashboard.traceFinishedGood(fgId, p);
  assert.ok(trace);
  assert.equal(trace.reveal.material, true);
  assert.equal(trace.materials.length, 1);
  assert.equal(trace.materials[0].vendor, 'Acme Aromatics');
  // the query prefers material_code over material_name when both are present.
  assert.match(trace.materials[0].material, /^MAT-/);
  assert.equal(trace.materialCount, 1);
});
