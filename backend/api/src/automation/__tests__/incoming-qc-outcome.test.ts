/**
 * G3 rule: QC PASS on incoming → batch released to available; FAIL → rejected + vendor credit
 * note draft (backend/api/src/automation/incoming-qc-outcome.service.ts).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSchema, testClient, closeTestClient } from '../../../../test-support/db.js';
import { IncomingQcOutcomeService } from '../incoming-qc-outcome.service.js';

let svc: IncomingQcOutcomeService;

before(async () => {
  await ensureSchema();
  svc = new IncomingQcOutcomeService(testClient() as never);
});
after(async () => {
  await closeTestClient();
});

function applyOne(qcInspectionId: string, type: string, payload: unknown): Promise<void> {
  return (svc as unknown as { applyOne(id: string, type: string, payload: unknown): Promise<void> }).applyOne(
    qcInspectionId,
    type,
    payload,
  );
}

async function quarantinedBatch(opts: { withGrnVendor?: boolean; poRate?: number } = {}): Promise<{ rmBatchId: string; vendorId?: string }> {
  const sql = testClient();
  const materialId = randomUUID();
  const rmBatchId = randomUUID();
  let vendorId: string | undefined;
  let grnItemId: string | null = null;

  if (opts.withGrnVendor) {
    vendorId = randomUUID();
    await sql`insert into procurement.vendor_details (vendor_id, vendor_name, status) values (${vendorId}, 'Test Vendor', 'ACTIVE')`;
    const grnId = randomUUID();
    await sql`insert into inventory.grn_master (grn_id, grn_number, vendor_id, status) values (${grnId}, ${'GRN-' + grnId.slice(0, 8)}, ${vendorId}, 'RECEIVED')`;
    grnItemId = randomUUID();
    // lane/j2: optionally priced through a PO line, so the draft credit note can carry an amount.
    let poItemId: string | null = null;
    if (opts.poRate !== undefined) {
      const poId = randomUUID();
      poItemId = randomUUID();
      await sql`insert into procurement.purchase_order (purchase_order_id, po_number, vendor_id, status) values (${poId}, ${'PO-' + poId.slice(0, 8)}, ${vendorId}, 'ACKNOWLEDGED')`;
      await sql`insert into procurement.purchase_order_items (purchase_order_item_id, purchase_order_id, material_id, ordered_qty, rate) values (${poItemId}, ${poId}, ${materialId}, 50, ${opts.poRate})`;
    }
    await sql`insert into inventory.grn_items (grn_item_id, grn_id, purchase_order_item_id, material_id, received_qty, status) values (${grnItemId}, ${grnId}, ${poItemId}, ${materialId}, 50, 'ACTIVE')`;
  }

  await sql`insert into inventory.rm_batch_master (rm_batch_id, grn_item_id, material_id, batch_number, received_qty, status)
    values (${rmBatchId}, ${grnItemId}, ${materialId}, ${'RMB-' + rmBatchId.slice(0, 8)}, 50, 'QUARANTINE')`;

  return { rmBatchId, vendorId };
}

test('QC PASS releases the quarantined RM batch to available inventory', async () => {
  const { rmBatchId } = await quarantinedBatch();
  const qcInspectionId = randomUUID();

  await applyOne(qcInspectionId, 'quality.qc.passed', { rmBatchId });

  const sql = testClient();
  const batch = await sql`select status from inventory.rm_batch_master where rm_batch_id = ${rmBatchId}`;
  assert.equal(batch[0]?.status, 'RELEASED');

  const inv = await sql`select quantity_on_hand, status from inventory.inventory_batch where rm_batch_id = ${rmBatchId}`;
  assert.equal(inv.length, 1);
  assert.equal(Number(inv[0]?.quantity_on_hand), 50);
  assert.equal(inv[0]?.status, 'ACTIVE');

  const history = await sql`select event_type from inventory.inventory_event_history where reference_document_id = ${rmBatchId}`;
  assert.equal(history[0]?.event_type, 'RECEIVE');
});

test('duplicate PASS delivery for the same inspection does not create a second inventory batch', async () => {
  const { rmBatchId } = await quarantinedBatch();
  const qcInspectionId = randomUUID();

  await applyOne(qcInspectionId, 'quality.qc.passed', { rmBatchId });
  await applyOne(qcInspectionId, 'quality.qc.passed', { rmBatchId }); // redelivery
  await applyOne(qcInspectionId, 'quality.qc.passed', { rmBatchId });

  const sql = testClient();
  const inv = await sql`select count(*)::int as c from inventory.inventory_batch where rm_batch_id = ${rmBatchId}`;
  assert.equal(inv[0]?.c, 1, 'exactly one inventory_batch despite 3 delivery attempts');
});

test('QC FAIL rejects the batch and drafts a vendor credit note when a GRN/vendor is linked', async () => {
  const { rmBatchId, vendorId } = await quarantinedBatch({ withGrnVendor: true });
  const qcInspectionId = randomUUID();

  await applyOne(qcInspectionId, 'quality.qc.failed', { rmBatchId });

  const sql = testClient();
  const batch = await sql`select status from inventory.rm_batch_master where rm_batch_id = ${rmBatchId}`;
  assert.equal(batch[0]?.status, 'REJECTED');

  const notes = await sql`select status, vendor_id from procurement.vendor_credit_note where vendor_id = ${vendorId!}`;
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.status, 'DRAFT');
  assert.equal(notes[0]?.vendor_id, vendorId);
});

test('QC FAIL with no GRN link still rejects the batch but drafts no credit note', async () => {
  const { rmBatchId } = await quarantinedBatch(); // no GRN/vendor
  const qcInspectionId = randomUUID();

  await applyOne(qcInspectionId, 'quality.qc.failed', { rmBatchId });

  const sql = testClient();
  const batch = await sql`select status from inventory.rm_batch_master where rm_batch_id = ${rmBatchId}`;
  assert.equal(batch[0]?.status, 'REJECTED');

  const log = (await sql`select outputs from automation.decision_log where dedupe_key = ${qcInspectionId}`) as unknown as Array<{
    outputs: { creditNoteId: string | null };
  }>;
  assert.equal(log[0]?.outputs?.creditNoteId ?? null, null);
});

test('duplicate FAIL delivery does not draft a second credit note', async () => {
  const { rmBatchId, vendorId } = await quarantinedBatch({ withGrnVendor: true });
  const qcInspectionId = randomUUID();

  await applyOne(qcInspectionId, 'quality.qc.failed', { rmBatchId });
  await applyOne(qcInspectionId, 'quality.qc.failed', { rmBatchId });

  const sql = testClient();
  const notes = await sql`select count(*)::int as c from procurement.vendor_credit_note where vendor_id = ${vendorId!}`;
  assert.equal(notes[0]?.c, 1, 'exactly one credit note despite 2 delivery attempts');
});

/* lane/j2 — the draft credit note is priced: rejected batch quantity x the PO line rate. */
test('QC FAIL prices the draft credit note from the PO line (received qty x rate); unpriced stays NULL', async () => {
  const sql = testClient();
  const priced = await quarantinedBatch({ withGrnVendor: true, poRate: 12000 });
  await applyOne(randomUUID(), 'quality.qc.failed', { rmBatchId: priced.rmBatchId });
  const [p] = await sql`select amount, status from procurement.vendor_credit_note where vendor_id = ${priced.vendorId!}`;
  assert.equal(Number(p?.amount), 50 * 12000);
  assert.equal(p?.status, 'DRAFT', 'still a draft for a human to finalise');

  const unpriced = await quarantinedBatch({ withGrnVendor: true });
  await applyOne(randomUUID(), 'quality.qc.failed', { rmBatchId: unpriced.rmBatchId });
  const [u] = await sql`select amount from procurement.vendor_credit_note where vendor_id = ${unpriced.vendorId!}`;
  assert.equal(u?.amount, null, 'no PO rate -> no invented amount');
});
