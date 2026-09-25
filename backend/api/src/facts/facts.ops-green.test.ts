/**
 * OPS-GREEN §16 (lane ARIA) — the four fact kinds ARIA needed for "which material blocks
 * production", "which PO is late", "what is the factory status" and "why is this batch
 * quarantined". Real Postgres (same harness as facts.service.test.ts), never a mock: each
 * answer is a join across production/procurement/quality and a mock cannot lie about whether
 * the join resolves.
 *
 * The shared test DB is not wiped between runs, so factory-wide assertions filter to this
 * run's own tagged rows (or assert "at least") rather than exact global counts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ensureSchema, testClient, bridgeDb, closeTestClient } from "../../../test-support/db.js";
import { FactsService, quarantineReason } from "./facts.service.js";
import { FACT_KINDS, FACT_KIND_PERMISSION, isNeverResolvable } from "./facts.contract.js";

let facts: FactsService;
before(async () => {
  await ensureSchema();
  facts = new FactsService(testClient(), bridgeDb());
});
after(async () => { await closeTestClient(); });

const tag = () => randomUUID().slice(0, 8).toUpperCase();

test("contract: the four ops kinds are published, permissioned, and not formula-shaped", () => {
  for (const k of ["production_blockers", "po_late", "factory_status", "batch_quarantine"] as const) {
    assert.ok((FACT_KINDS as readonly string[]).includes(k), k);
    assert.match(FACT_KIND_PERMISSION[k], /^[a-z_]+:[a-z_]+:read$/);
    assert.equal(isNeverResolvable(k), false);
  }
});

test("production_blockers: names the blocking documents for an order, never the material", async () => {
  const sql = testClient();
  const t = tag();
  const productionOrderId = randomUUID();
  const materialId = randomUUID();
  const orderRef = `RAC-OG-${t}`;
  await sql`insert into production.production_order (production_order_id, status) values (${productionOrderId}, 'RELEASED')`;
  await sql`
    insert into production.production_order_ingredients (production_order_id, material_id, required_qty, issued_qty)
    values (${productionOrderId}, ${materialId}, 3, false)`;
  await sql`
    insert into inventory.rm_batch_master (material_id, batch_number, received_qty, status)
    values (${materialId}, ${`RMB-OG-${t}`}, 3, 'QUARANTINE')`;
  await sql`
    insert into bridge.production_requirement
      (alembic_requirement_id, org_id, correlation_id, order_ref, mapped_sku, qty, uom, needed_by, production_order_id)
    values (${randomUUID()}, ${randomUUID()}, ${randomUUID()}, ${orderRef}, 'FSKU-OG', 1, 'kg', now() + interval '3 days', ${productionOrderId})`;

  const one = await facts.resolve("production_blockers", { orderRef });
  assert.ok(one);
  assert.equal(one!.scope, "order");
  const blocked = one!.blocked as Array<Record<string, unknown>>;
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.productionOrder, orderRef);
  assert.equal(blocked[0]!.unissuedLines, 1);
  assert.deepEqual(blocked[0]!.quarantinedBatches, [`RMB-OG-${t}`]);
  assert.doesNotMatch(JSON.stringify(one), new RegExp(materialId), "no material identity crosses");
  assert.doesNotMatch(JSON.stringify(one), /formula/i);

  const all = await facts.resolve("production_blockers", {});
  assert.equal(all!.scope, "factory");
  assert.ok(Array.isArray(all!.blocked));

  assert.equal(await facts.resolve("production_blockers", { orderRef: `RAC-NOPE-${t}` }), null,
    "an unknown order is NOT_FOUND, not an empty factory");
});

test("po_late: delivery-late past the vendor's accepted date with no GRN; approval-late past the G3 threshold", async () => {
  const sql = testClient();
  const t = tag();
  const [late] = await sql`
    insert into procurement.purchase_order (po_number, status) values (${`PO-LATE-${t}`}, 'ACKNOWLEDGED')
    returning purchase_order_id`;
  await sql`
    insert into procurement.vendor_po_ack (purchase_order_id, acknowledged_dt, accepted_delivery_date)
    values (${late!.purchase_order_id}, now() - interval '10 days', current_date - 4)`;
  const [onTime] = await sql`
    insert into procurement.purchase_order (po_number, status) values (${`PO-ONTIME-${t}`}, 'ACKNOWLEDGED')
    returning purchase_order_id`;
  await sql`
    insert into procurement.vendor_po_ack (purchase_order_id, acknowledged_dt, accepted_delivery_date)
    values (${onTime!.purchase_order_id}, now(), current_date + 5)`;
  const [received] = await sql`
    insert into procurement.purchase_order (po_number, status) values (${`PO-RCVD-${t}`}, 'ACKNOWLEDGED')
    returning purchase_order_id`;
  await sql`
    insert into procurement.vendor_po_ack (purchase_order_id, acknowledged_dt, accepted_delivery_date)
    values (${received!.purchase_order_id}, now() - interval '10 days', current_date - 4)`;
  await sql`
    insert into inventory.grn_master (grn_number, purchase_order_id, status)
    values (${`GRN-OG-${t}`}, ${received!.purchase_order_id}, 'RECEIVED')`;
  await sql`
    insert into procurement.purchase_order (po_number, status, updated_dt)
    values (${`PO-STALE-${t}`}, 'PENDING_APPROVAL', now() - interval '30 days')`;

  const all = await facts.resolve("po_late", {});
  const lateNos = (all!.deliveryLate as Array<{ poNumber: string }>).map((p) => p.poNumber);
  const approvalNos = (all!.approvalLate as Array<{ poNumber: string }>).map((p) => p.poNumber);
  // The list is capped at ten oldest; this run's rows are asserted through the narrowed form.
  const one = await facts.resolve("po_late", { poNumber: `PO-LATE-${t}` });
  const d = one!.deliveryLate as Array<{ poNumber: string; daysLate: number; vendorCommitted: boolean }>;
  assert.equal(d.length, 1);
  assert.equal(d[0]!.daysLate, 4);
  assert.equal(d[0]!.vendorCommitted, true);
  assert.equal(((await facts.resolve("po_late", { poNumber: `PO-ONTIME-${t}` }))!.deliveryLate as unknown[]).length, 0);
  assert.equal(((await facts.resolve("po_late", { poNumber: `PO-RCVD-${t}` }))!.deliveryLate as unknown[]).length, 0,
    "a PO with a GRN has arrived and is not late");
  const stale = await facts.resolve("po_late", { poNumber: `PO-STALE-${t}` });
  assert.equal((stale!.approvalLate as unknown[]).length, 1);
  assert.ok(lateNos.length <= 10 && approvalNos.length <= 10);
  assert.equal(await facts.resolve("po_late", { poNumber: `PO-NOPE-${t}` }), null);
});

test("factory_status: counts from the owning tables, no identities", async () => {
  const sql = testClient();
  const t = tag();
  await sql`
    insert into inventory.rm_batch_master (material_id, batch_number, received_qty, status)
    values (${randomUUID()}, ${`RMB-FS-${t}`}, 1, 'QUARANTINE')`;
  const data = await facts.resolve("factory_status", {});
  assert.ok(data);
  assert.ok(Number(data!.quarantinedBatches) >= 1);
  for (const k of ["blockedOrders", "qcHolds", "productionQcHolds", "posAwaitingApproval", "posOpen",
    "prApprovalsPending", "requirementsAwaitingPlan"]) {
    assert.equal(typeof data![k], "number", k);
  }
  assert.ok(Array.isArray(data!.productionOrdersByStatus));
  assert.doesNotMatch(JSON.stringify(data), /formula|material_id|materialName/i);
});

test("batch_quarantine: reason from the facts — awaiting QC, QC hold, QC fail; unknown batch is null", async () => {
  const sql = testClient();
  const t = tag();
  const [grnPo] = await sql`
    insert into procurement.purchase_order (po_number, status) values (${`PO-BQ-${t}`}, 'ACKNOWLEDGED')
    returning purchase_order_id`;
  const [grn] = await sql`
    insert into inventory.grn_master (grn_number, purchase_order_id, status)
    values (${`GRN-BQ-${t}`}, ${grnPo!.purchase_order_id}, 'RECEIVED') returning grn_id`;
  const [gi] = await sql`
    insert into inventory.grn_items (grn_id, material_id, received_qty) values (${grn!.grn_id}, ${randomUUID()}, 5)
    returning grn_item_id`;
  const [b] = await sql`
    insert into inventory.rm_batch_master (grn_item_id, material_id, batch_number, received_qty, status)
    values (${gi!.grn_item_id}, ${randomUUID()}, ${`RMB-BQ-${t}`}, 5, 'QUARANTINE') returning rm_batch_id`;

  let data = await facts.resolve("batch_quarantine", { batchNumber: `RMB-BQ-${t}` });
  assert.equal(data!.grnNumber, `GRN-BQ-${t}`);
  assert.equal(data!.poNumber, `PO-BQ-${t}`);
  assert.equal((data!.reason as { code: string }).code, "awaiting_incoming_qc");
  assert.equal(data!.id, undefined, "internal ids stay inside RawProd");

  await sql`
    insert into quality.qc_inspections (rm_batch_id, overall_result, status, inspection_dt)
    values (${b!.rm_batch_id}, 'HOLD', 'ACTIVE', now())`;
  data = await facts.resolve("batch_quarantine", { batchNumber: `RMB-BQ-${t}` });
  assert.equal((data!.reason as { code: string }).code, "qc_hold");

  await sql`
    insert into quality.qc_inspections (rm_batch_id, overall_result, status, inspection_dt)
    values (${b!.rm_batch_id}, 'FAIL', 'DONE', now() + interval '1 minute')`;
  data = await facts.resolve("batch_quarantine", { batchNumber: `RMB-BQ-${t}` });
  assert.equal((data!.reason as { code: string }).code, "qc_failed");
  assert.doesNotMatch(JSON.stringify(data), /formula|material_id|materialId/i);

  assert.equal(await facts.resolve("batch_quarantine", { batchNumber: `NOPE-${t}` }), null);
});

test("quarantineReason: a released batch is reported as not held", () => {
  assert.deepEqual(quarantineReason("RELEASED", "PASS", null).quarantined, false);
  assert.equal(quarantineReason("RELEASED", null, new Date(Date.now() - 86_400_000)).code, "expired");
});
