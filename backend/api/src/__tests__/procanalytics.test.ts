/**
 * RP-PROC-007 — traces every dead-looking procurement UI call in web/app.js (vendor-rate-history,
 * negotiation, vendor performance, dispatch, QC-rejected-GRN) through to ProcAnalyticsService
 * (backend/api/src/procanalytics/procanalytics.service.ts) and settles each one:
 *
 *   REAL (kept, tested here) — vendor-rate-history, vendor-performance, qc-rejected-grns. All
 *   three compute from dictionary tables that genuinely exist in @ra/data-procurement/@ra/data-
 *   inventory/@ra/data-quality — no fake data, no missing tables.
 *
 *   NOT AVAILABLE (disabled honestly, not faked) — vendor-negotiations and vendor-dispatches.
 *   Both used to query/insert procurement.vendor_negotiation / procurement.vendor_dispatch,
 *   tables that exist in NEITHER @ra/data-procurement (db:push's only source for the
 *   `procurement` schema) NOR the Phase-1A Data Dictionary — so on any real/dev database they
 *   would 500 with "relation does not exist". They now throw NotImplementedException with an
 *   honest message instead.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NotImplementedException } from '@nestjs/common';
import { ProcAnalyticsService } from '../procanalytics/procanalytics.service.js';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let svc: ProcAnalyticsService;

before(async () => {
  await ensureSchema();
  svc = new ProcAnalyticsService(testClient() as never);
});

after(async () => {
  await closeTestClient();
});

test('vendor-rate-history: REAL — computed from quotation + PO lines, not fabricated', async () => {
  const sql = testClient();
  const vendorId = crypto.randomUUID();
  const materialId = crypto.randomUUID();
  await sql`insert into procurement.vendor_details (vendor_id, vendor_code, vendor_name, status)
    values (${vendorId}, ${'V-' + vendorId.slice(0, 8)}, 'Rate Vendor', 'ACTIVE')`;
  const rfq = await sql`insert into procurement.rfq_master (rfq_id, rfq_number, status) values (${crypto.randomUUID()}, ${'RFQ-' + Date.now()}, 'ACTIVE') returning rfq_id`;
  const q = await sql`insert into procurement.quotations (quotation_id, rfq_id, vendor_id, quotation_number, quotation_date, status)
    values (${crypto.randomUUID()}, ${rfq[0]!.rfq_id}, ${vendorId}, ${'Q-' + Date.now()}, '2026-01-01', 'ACTIVE') returning quotation_id`;
  await sql`insert into procurement.quotation_items (quotation_item_id, quotation_id, material_id, quoted_qty, quoted_rate, status)
    values (${crypto.randomUUID()}, ${q[0]!.quotation_id}, ${materialId}, 10, 275, 'ACTIVE')`;

  const { items } = await svc.rateHistory(materialId, vendorId, 50);
  assert.ok(items.length >= 1);
  const row = items.find((r: Record<string, unknown>) => (r as { source: string }).source === 'QUOTATION') as { rate: string; vendorId: string } | undefined;
  assert.ok(row, 'the real quotation line must appear in rate history');
  assert.equal(Number(row!.rate), 275);
  assert.equal(row!.vendorId, vendorId);
});

test('vendor-performance: REAL — PO/GRN/QC counts computed from real rows, not fabricated', async () => {
  const sql = testClient();
  const vendorId = crypto.randomUUID();
  await sql`insert into procurement.vendor_details (vendor_id, vendor_code, vendor_name, status)
    values (${vendorId}, ${'V-' + vendorId.slice(0, 8)}, 'Perf Vendor', 'ACTIVE')`;
  await sql`insert into procurement.purchase_order (purchase_order_id, po_number, vendor_id, total_amount, status)
    values (${crypto.randomUUID()}, ${'PO-' + Date.now()}, ${vendorId}, 1000, 'DRAFT')`;

  const { items } = await svc.vendorPerformance(500);
  const row = items.find((r: Record<string, unknown>) => (r as { vendorId: string }).vendorId === vendorId) as unknown as { poCount: number } | undefined;
  assert.ok(row, 'the real vendor must appear in the performance scorecard');
  assert.equal(row!.poCount, 1);
});

test('qc-rejected-grns: REAL — surfaces GRNs with a real QC REJECT, not fabricated', async () => {
  const sql = testClient();
  const vendorId = crypto.randomUUID();
  const grnId = crypto.randomUUID();
  const grnItemId = crypto.randomUUID();
  const rmBatchId = crypto.randomUUID();
  await sql`insert into procurement.vendor_details (vendor_id, vendor_code, vendor_name, status)
    values (${vendorId}, ${'V-' + vendorId.slice(0, 8)}, 'Reject Vendor', 'ACTIVE')`;
  await sql`insert into inventory.grn_master (grn_id, grn_number, vendor_id, status) values (${grnId}, ${'GRN-' + Date.now()}, ${vendorId}, 'ACTIVE')`;
  await sql`insert into inventory.grn_items (grn_item_id, grn_id, status) values (${grnItemId}, ${grnId}, 'ACTIVE')`;
  await sql`insert into inventory.rm_batch_master (rm_batch_id, grn_item_id, batch_number, status) values (${rmBatchId}, ${grnItemId}, ${'B-' + Date.now()}, 'ACTIVE')`;
  await sql`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result, status) values (${crypto.randomUUID()}, ${rmBatchId}, 'REJECT', 'ACTIVE')`;

  const { items } = await svc.qcRejectedGrns(500);
  const row = items.find((r: Record<string, unknown>) => (r as { grnId: string }).grnId === grnId);
  assert.ok(row, 'a GRN with a real QC REJECT must appear');
});

test('vendor-negotiations (RP-PROC-007): honest "not available", not a crash or fake data', async () => {
  await assert.rejects(() => svc.listNegotiations(200), NotImplementedException);
  await assert.rejects(
    () => svc.createNegotiation({ quotationId: crypto.randomUUID() }, principal({ permissions: ['procurement:quotation_items:write'] })),
    NotImplementedException,
  );
});

test('vendor-dispatches (RP-PROC-007): honest "not available", not a crash or fake data', async () => {
  await assert.rejects(() => svc.listVendorDispatches(200), NotImplementedException);
  await assert.rejects(
    () => svc.createVendorDispatch({ purchaseOrderId: crypto.randomUUID() }, principal({ permissions: ['procurement:purchase_order:read'] })),
    NotImplementedException,
  );
});
