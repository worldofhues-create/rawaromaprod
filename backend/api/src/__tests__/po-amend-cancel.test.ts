/**
 * G2/V4 §113 (ledger PB-08 lane) — non-DRAFT purchase orders can no longer have items/fields
 * edited directly (409); amend (new DRAFT revision linked to the original, re-approval per the
 * existing thresholds) and cancel (reason, audit, vendor-notification event, refused once a
 * goods receipt exists) are the real paths for that change now
 * (backend/cluster-procurement/src/po/po.service.ts + backend/api/src/edit/edit.service.ts).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PoService } from '../../../cluster-procurement/src/po/po.service.js';
import { EditService } from '../edit/edit.service.js';
import { ensureSchema, procurementDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let svc: PoService;
let editSvc: EditService;

before(async () => {
  await ensureSchema();
  svc = new PoService(procurementDb());
  editSvc = new EditService(testClient());
});

after(async () => {
  await closeTestClient();
});

const CREATOR = '00000000-0000-7000-8000-0000000000b1';
const APPROVER = '00000000-0000-7000-8000-0000000000b2';

async function freshPo() {
  const created = await svc.createPurchaseOrder(
    { items: [{ materialId: randomUUID(), orderedQty: 10, rate: 100, amount: 1000 }] },
    principal({ userId: CREATOR }),
  );
  return created.purchaseOrder.purchaseOrderId;
}

async function freshApprovedPo() {
  const id = await freshPo();
  await svc.approvePurchaseOrder(id, {}, principal({ userId: APPROVER }));
  return id;
}

/* ── createPurchaseOrderItem: 409 once beyond DRAFT ─────────────────────── */

test('adding an item to a DRAFT PO still works', async () => {
  const id = await freshPo();
  const row = await svc.createPurchaseOrderItem(
    { purchaseOrderId: id, materialId: randomUUID(), orderedQty: 1, rate: 1, amount: 1 },
    principal({ userId: CREATOR }),
  );
  assert.equal(row.purchaseOrderId, id);
});

test('adding an item to a non-DRAFT (APPROVED) PO is refused with 409', async () => {
  const id = await freshApprovedPo();
  await assert.rejects(
    () =>
      svc.createPurchaseOrderItem(
        { purchaseOrderId: id, materialId: randomUUID(), orderedQty: 1, rate: 1, amount: 1 },
        principal({ userId: CREATOR }),
      ),
    ConflictException,
  );
});

/* ── EditService: header-field edit refused (409) once beyond DRAFT ─────── */

test('editing a DRAFT PO header field via the generic editor still works', async () => {
  const id = await freshPo();
  const p = principal({ userId: CREATOR, permissions: ['procurement:purchase_order:write'] });
  const updated = await editSvc.update('purchase-orders', id, { orderDate: '2026-01-01' }, p);
  assert.ok(updated, 'editor returned no row');
  assert.equal(String(updated.order_date).slice(0, 10), '2026-01-01');
});

test('editing a non-DRAFT (APPROVED) PO header field via the generic editor is refused with 409', async () => {
  const id = await freshApprovedPo();
  const p = principal({ userId: CREATOR, permissions: ['procurement:purchase_order:write'] });
  await assert.rejects(
    () => editSvc.update('purchase-orders', id, { orderDate: '2026-01-01' }, p),
    ConflictException,
  );
});

test('L2: statusGuard is atomic — an edit racing a concurrent DRAFT->APPROVED commit gets 409 and writes nothing', async () => {
  const id = await freshPo();
  const sql = testClient();
  const p = principal({ userId: CREATOR, permissions: ['procurement:purchase_order:write'] });
  const before = (await sql`select order_date from procurement.purchase_order where purchase_order_id = ${id}`)[0]!;

  let editPromise!: Promise<unknown>;
  await sql.begin(async (tx) => {
    // Second caller (the approver) holds the row lock and moves it beyond DRAFT...
    await tx`update procurement.purchase_order set status = 'APPROVED' where purchase_order_id = ${id}`;
    // ...while the editor's request starts (it saw DRAFT under the old check-then-write).
    editPromise = editSvc.update('purchase-orders', id, { orderDate: '2030-12-31' }, p).then(
      () => 'ok', (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 150));
  });
  const outcome = await editPromise;
  assert.ok(outcome instanceof ConflictException, `expected 409, got ${String(outcome)}`);
  const after = (await sql`select status, order_date from procurement.purchase_order where purchase_order_id = ${id}`)[0]!;
  assert.equal(after.status, 'APPROVED');
  assert.equal(String(after.order_date), String(before.order_date));
});

test('L2: two sequential callers — first edit on DRAFT succeeds, edit after approval is 409; unknown id is 404', async () => {
  const id = await freshPo();
  const p = principal({ userId: CREATOR, permissions: ['procurement:purchase_order:write'] });
  assert.ok(await editSvc.update('purchase-orders', id, { orderDate: '2026-02-02' }, p));
  await svc.approvePurchaseOrder(id, {}, principal({ userId: APPROVER }));
  await assert.rejects(() => editSvc.update('purchase-orders', id, { orderDate: '2026-03-03' }, p), ConflictException);
  await assert.rejects(() => editSvc.update('purchase-orders', randomUUID(), { orderDate: '2026-03-03' }, p), NotFoundException);
});

/* ── amendPurchaseOrder ──────────────────────────────────────────────────── */

test('amend refuses a DRAFT PO (edit it directly instead)', async () => {
  const id = await freshPo();
  await assert.rejects(
    () => svc.amendPurchaseOrder(id, { reason: 'too early' }, principal({ userId: CREATOR })),
    ConflictException,
  );
});

test('amend refuses an unknown PO', async () => {
  await assert.rejects(
    () => svc.amendPurchaseOrder(randomUUID(), { reason: 'x' }, principal({ userId: CREATOR })),
    NotFoundException,
  );
});

test('amend on an APPROVED PO creates a new DRAFT revision linked to the original, and freezes the original to AMENDED', async () => {
  const id = await freshApprovedPo();
  const result = await svc.amendPurchaseOrder(
    id,
    { reason: 'vendor renegotiated the rate' },
    principal({ userId: CREATOR }),
  );
  assert.equal(result.purchaseOrder.status, 'DRAFT');
  assert.equal(result.requiresReapproval, true);
  assert.notEqual(result.purchaseOrder.purchaseOrderId, id);
  assert.equal(result.items.length, 1, 'the original line item is carried forward');

  const sql = testClient();
  const revision = await sql`select replacement_of_po_id, total_amount from procurement.purchase_order where purchase_order_id = ${result.purchaseOrder.purchaseOrderId}`;
  assert.equal(revision[0]!.replacement_of_po_id, id);
  assert.equal(Number(revision[0]!.total_amount), 1000);

  const original = await sql`select status from procurement.purchase_order where purchase_order_id = ${id}`;
  assert.equal(original[0]!.status, 'AMENDED');

  const events = await sql`select payload from procurement.outbox where type = 'procurement.po.amended' and aggregate_id = ${result.purchaseOrder.purchaseOrderId}`;
  assert.equal(events.length, 1);
  assert.equal((events[0]!.payload as { replacesPurchaseOrderId: string }).replacesPurchaseOrderId, id);
});

test('amend supports overriding the line items instead of carrying the original forward', async () => {
  const id = await freshApprovedPo();
  const newMaterial = randomUUID();
  const result = await svc.amendPurchaseOrder(
    id,
    { reason: 'vendor swapped material', items: [{ materialId: newMaterial, orderedQty: 5, rate: 20, amount: 100 }] },
    principal({ userId: CREATOR }),
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.materialId, newMaterial);
  assert.equal(Number(result.purchaseOrder.totalAmount), 100);
});

test('the amended revision goes through the ordinary approve flow again (re-approval per existing thresholds)', async () => {
  const id = await freshApprovedPo();
  const { purchaseOrder: revision } = await svc.amendPurchaseOrder(id, { reason: 'reapproval check' }, principal({ userId: CREATOR }));
  // Same segregation-of-duties + threshold logic as any other PO — the creator still can't
  // approve their own revision, and a real approver reaches APPROVED exactly as before.
  const { purchaseOrder: approved } = await svc.approvePurchaseOrder(
    revision.purchaseOrderId,
    {},
    principal({ userId: APPROVER }),
  );
  assert.equal(approved.status, 'APPROVED');
});

test('amend refuses a PO that is already AMENDED (act on the current revision instead)', async () => {
  const id = await freshApprovedPo();
  await svc.amendPurchaseOrder(id, { reason: 'first amendment' }, principal({ userId: CREATOR }));
  await assert.rejects(
    () => svc.amendPurchaseOrder(id, { reason: 'second amendment on the stale original' }, principal({ userId: CREATOR })),
    ConflictException,
  );
});

test('amend refuses a CANCELLED PO', async () => {
  const id = await freshApprovedPo();
  await svc.cancelPurchaseOrder(id, { reason: 'no longer needed' }, principal({ userId: CREATOR }));
  await assert.rejects(
    () => svc.amendPurchaseOrder(id, { reason: 'x' }, principal({ userId: CREATOR })),
    ConflictException,
  );
});

/* ── cancelPurchaseOrder ─────────────────────────────────────────────────── */

test('cancel refuses an unknown PO', async () => {
  await assert.rejects(
    () => svc.cancelPurchaseOrder(randomUUID(), { reason: 'x' }, principal({ userId: CREATOR })),
    NotFoundException,
  );
});

test('cancel on a DRAFT PO: stamps the reason, flips to CANCELLED, and emits the vendor-notification event', async () => {
  const id = await freshPo();
  const cancelled = await svc.cancelPurchaseOrder(id, { reason: 'customer withdrew the order' }, principal({ userId: CREATOR }));
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.cancellationReason, 'customer withdrew the order');

  const sql = testClient();
  const events = await sql`select payload from procurement.outbox where type = 'procurement.po.cancelled' and aggregate_id = ${id}`;
  assert.equal(events.length, 1);
  assert.equal((events[0]!.payload as { reason: string }).reason, 'customer withdrew the order');
});

test('cancel refuses a PO already CANCELLED', async () => {
  const id = await freshPo();
  await svc.cancelPurchaseOrder(id, { reason: 'first cancel' }, principal({ userId: CREATOR }));
  await assert.rejects(
    () => svc.cancelPurchaseOrder(id, { reason: 'second cancel' }, principal({ userId: CREATOR })),
    ConflictException,
  );
});

test('cancel refuses an AMENDED (superseded) PO — act on the current revision instead', async () => {
  const id = await freshApprovedPo();
  await svc.amendPurchaseOrder(id, { reason: 'amend first' }, principal({ userId: CREATOR }));
  await assert.rejects(
    () => svc.cancelPurchaseOrder(id, { reason: 'x' }, principal({ userId: CREATOR })),
    ConflictException,
  );
});

test('cancel refuses (409) once a goods receipt already exists against the PO — releases nothing that has already been received', async () => {
  const id = await freshApprovedPo();
  const sql = testClient();
  await sql`insert into inventory.grn_master (grn_id, purchase_order_id, status, created_by, updated_by)
            values (${randomUUID()}, ${id}, 'ACTIVE', ${CREATOR}, ${CREATOR})`;
  await assert.rejects(
    () => svc.cancelPurchaseOrder(id, { reason: 'too late, goods already received' }, principal({ userId: CREATOR })),
    ConflictException,
  );
});
