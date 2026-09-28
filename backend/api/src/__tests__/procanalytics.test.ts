/**
 * RP-PROC-007 — traces every dead-looking procurement UI call in web/app.js (vendor-rate-history,
 * negotiation, vendor performance, dispatch, QC-rejected-GRN) through to ProcAnalyticsService
 * (backend/api/src/procanalytics/procanalytics.service.ts) and settles each one:
 *
 *   REAL (kept, tested here) — vendor-rate-history, vendor-performance, qc-rejected-grns. All
 *   three compute from dictionary tables that genuinely exist in @ra/data-procurement/@ra/data-
 *   inventory/@ra/data-quality — no fake data, no missing tables.
 *
 *   Negotiation, vendor dispatch, advance payments and the approval matrix were disabled by lanes
 *   RP-PROC-007/F5 while their tables had no migration; they are REAL again (lane platform-roles,
 *   2026-09-28) and tested below on a Drizzle-wrapped pool.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ProcAnalyticsService } from '../procanalytics/procanalytics.service.js';
import { ensureSchema, testClient, principal, closeTestClient, TEST_DATABASE_URL } from '../../../test-support/db.js';

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

/* ── Lane platform-roles (2026-09-28): negotiation / vendor dispatch / advance payment / approval
 * matrix are REAL again — their tables come from scripts/migrations/0014 (and 0001 for
 * approval_matrix) and exist on production. Exercised on a Drizzle-WRAPPED pool, exactly as the
 * running API's PG_CLIENT is (timestamps/dates come back as text and parameters are not
 * serialized — every value these services bind must already be a string). ── */

async function withWrapped<T>(fn: (svc: ProcAnalyticsService) => Promise<T>): Promise<T> {
  const wrapped = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, types: {}, onnotice: () => {} });
  drizzle(wrapped);
  try {
    return await fn(new ProcAnalyticsService(wrapped as never));
  } finally {
    await wrapped.end({ timeout: 1 });
  }
}

async function makePo(): Promise<{ purchaseOrderId: string; vendorId: string; poNumber: string }> {
  const sql = testClient();
  const vendorId = crypto.randomUUID();
  const purchaseOrderId = crypto.randomUUID();
  const poNumber = 'PO-PR-' + purchaseOrderId.slice(0, 8);
  await sql`insert into procurement.vendor_details (vendor_id, vendor_code, vendor_name, status)
    values (${vendorId}, ${'V-' + vendorId.slice(0, 8)}, 'Dispatch Vendor', 'ACTIVE')`;
  await sql`insert into procurement.purchase_order (purchase_order_id, po_number, vendor_id, total_amount, status)
    values (${purchaseOrderId}, ${poNumber}, ${vendorId}, 1000, 'APPROVED')`;
  return { purchaseOrderId, vendorId, poNumber };
}

test('vendor-dispatches: record against a real PO, then list it with PO number + vendor', async () => {
  const po = await makePo();
  await withWrapped(async (w) => {
    const created = (await w.createVendorDispatch(
      { purchaseOrderId: po.purchaseOrderId, dispatchDate: '2026-09-28', transporter: 'Blue Dart', docketNumber: 'LR-1', vehicleNumber: 'MH01AB1234' },
      principal({ permissions: ['procurement:purchase_order:read'] }),
    )) as { vendorDispatchId: string; status: string };
    assert.equal(created.status, 'DISPATCHED');
    const { items } = await w.listVendorDispatches(500);
    const row = items.find((r) => (r as { vendorDispatchId: string }).vendorDispatchId === created.vendorDispatchId) as Record<string, unknown> | undefined;
    assert.ok(row);
    assert.equal(row!.poNumber, po.poNumber);
    assert.equal(row!.vendorName, 'Dispatch Vendor');
    assert.equal(row!.dispatchDate, '2026-09-28');
  });
});

test('vendor-dispatches: bad input is a 400/404, never a Postgres 500; permission still first', async () => {
  const ok = principal({ permissions: ['procurement:purchase_order:read'] });
  await assert.rejects(() => svc.createVendorDispatch({ purchaseOrderId: 'nope', dispatchDate: '2026-09-28' }, ok), BadRequestException);
  await assert.rejects(() => svc.createVendorDispatch({ purchaseOrderId: crypto.randomUUID() }, ok), BadRequestException);
  await assert.rejects(() => svc.createVendorDispatch({ purchaseOrderId: crypto.randomUUID(), dispatchDate: '2026-09-28' }, ok), NotFoundException);
  await assert.rejects(() => svc.createVendorDispatch({ purchaseOrderId: crypto.randomUUID(), dispatchDate: '2026-09-28' }, principal({ permissions: [] })), ForbiddenException);
});

test('po-advance-payments: record against a real PO, then list it', async () => {
  const po = await makePo();
  await withWrapped(async (w) => {
    const created = (await w.createAdvancePayment(
      { purchaseOrderId: po.purchaseOrderId, amount: 2500.5, paymentDate: '2026-09-27', reference: 'UTR123' },
      principal({ permissions: ['procurement:purchase_order:write'] }),
    )) as { poAdvancePaymentId: string; amount: string; status: string };
    assert.equal(created.status, 'PAID');
    assert.equal(Number(created.amount), 2500.5);
    const { items } = await w.listAdvancePayments(500);
    const row = items.find((r) => (r as { poAdvancePaymentId: string }).poAdvancePaymentId === created.poAdvancePaymentId) as Record<string, unknown> | undefined;
    assert.ok(row);
    assert.equal(row!.poNumber, po.poNumber);
    assert.equal(row!.paymentDate, '2026-09-27');
  });
  const ok = principal({ permissions: ['procurement:purchase_order:write'] });
  await assert.rejects(() => svc.createAdvancePayment({ purchaseOrderId: po.purchaseOrderId, amount: 0, paymentDate: '2026-09-27' }, ok), BadRequestException);
  await assert.rejects(() => svc.createAdvancePayment({ purchaseOrderId: po.purchaseOrderId, amount: 'ten', paymentDate: '2026-09-27' }, ok), BadRequestException);
  await assert.rejects(() => svc.createAdvancePayment({ purchaseOrderId: po.purchaseOrderId, amount: 10, paymentDate: '2026-09-27' }, principal({ permissions: [] })), ForbiddenException);
});

test('vendor-negotiations: create then list; recommendation is validated', async () => {
  const po = await makePo();
  await withWrapped(async (w) => {
    const created = (await w.createNegotiation(
      { vendorId: po.vendorId, originalRate: '300', revisedRate: '275.5', recommendation: 'APPROVE', notes: 'volume discount' },
      principal({ permissions: ['procurement:quotation_items:write'] }),
    )) as { vendorNegotiationId: string; revisedRate: string; status: string };
    assert.equal(Number(created.revisedRate), 275.5);
    const { items } = await w.listNegotiations(500);
    const row = items.find((r) => (r as { vendorNegotiationId: string }).vendorNegotiationId === created.vendorNegotiationId) as Record<string, unknown> | undefined;
    assert.ok(row);
    assert.equal(row!.vendorName, 'Dispatch Vendor');
  });
  const ok = principal({ permissions: ['procurement:quotation_items:write'] });
  await assert.rejects(() => svc.createNegotiation({ vendorId: po.vendorId, recommendation: 'MAYBE' }, ok), BadRequestException);
  await assert.rejects(() => svc.createNegotiation({}, ok), BadRequestException);
  await assert.rejects(() => svc.createNegotiation({ vendorId: po.vendorId }, principal({ permissions: [] })), ForbiddenException);
});

test('approval-matrix: lists the configured per-organisation policies with the organisation name', async () => {
  const sql = testClient();
  const orgId = crypto.randomUUID();
  await sql`insert into iam.org_master (organization_id, organization_code, organization_name, status)
    values (${orgId}, ${'ORG-' + orgId.slice(0, 6)}, 'Matrix Org', 'ACTIVE')`;
  await sql`insert into iam.approval_matrix (organization_id, policy_type, threshold_amount, status)
    values (${orgId}, 'PO_APPROVAL_THRESHOLD', 500000, 'ACTIVE')`;
  await withWrapped(async (w) => {
    const { items } = await w.approvalMatrix(500);
    const row = items.find((r) => (r as { organizationId: string }).organizationId === orgId) as Record<string, unknown> | undefined;
    assert.ok(row);
    assert.equal(row!.organizationName, 'Matrix Org');
    assert.equal(row!.policyType, 'PO_APPROVAL_THRESHOLD');
    assert.equal(Number(row!.thresholdAmount), 500000);
  });
});
