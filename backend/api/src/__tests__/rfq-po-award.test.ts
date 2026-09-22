/**
 * RP-PROC — RFQ → PO "select winning quotation" step (RfqService.selectQuotation +
 * PoService.createPurchaseOrder, backend/cluster-procurement/src/{rfq,po}/*.service.ts).
 *
 * Before this lane's change, createPurchaseOrder accepted ANY quotationId with zero checks: no
 * verification that the quoting vendor actually submitted to the RFQ, that the quotation had
 * been chosen as the winner, or that the PO's lines/prices matched what was actually quoted — a
 * PO could be raised off a quote nobody selected, at different prices than what was quoted, or
 * even in a different vendor's name than the one who quoted.
 *
 * Now: POST /v1/quotations/:id/select is the formal award step (exactly one quotation per RFQ
 * may hold status 'SELECTED'), and createPurchaseOrder enforces, for a quotation-backed PO:
 *   - the quotation exists and its vendor matches any vendorId also supplied (vendor mismatch)
 *   - the quotation's vendor was actually mapped/invited to that RFQ
 *   - the quotation is the RFQ's SELECTED/awarded winner (not merely submitted)
 *   - the PO's vendorId + line items/prices are BOUND from the quotation, not client input
 *
 * Covers: happy path (select then create — vendor + lines bound from the quote), vendor
 * mismatch, an unselected quotation, and a double award (two quotations for one RFQ).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { RfqService } from '../../../cluster-procurement/src/rfq/rfq.service.js';
import { PoService } from '../../../cluster-procurement/src/po/po.service.js';
import { ensureSchema, procurementDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let rfqs: RfqService;
let pos: PoService;

before(async () => {
  await ensureSchema();
  rfqs = new RfqService(procurementDb());
  pos = new PoService(procurementDb());
});

after(async () => {
  await closeTestClient();
});

/** A fresh RFQ with two invited/mapped vendors, each with a quotation + one line item. */
async function freshRfqWithTwoQuotations(rate = 100) {
  const sql = testClient();
  const rfq = await rfqs.createRfqMaster(
    { purchaseRequestId: crypto.randomUUID(), rfqDate: '2026-01-01' },
    principal(),
  );
  const rfqId = rfq.rfqId;

  const vendorA = crypto.randomUUID();
  const vendorB = crypto.randomUUID();
  await sql`insert into procurement.vendor_details (vendor_id, vendor_code, vendor_name, status)
    values (${vendorA}, ${'V-A-' + vendorA.slice(0, 8)}, 'Vendor A', 'ACTIVE')`;
  await sql`insert into procurement.vendor_details (vendor_id, vendor_code, vendor_name, status)
    values (${vendorB}, ${'V-B-' + vendorB.slice(0, 8)}, 'Vendor B', 'ACTIVE')`;

  await rfqs.createRfqVendorMapping({ rfqId, vendorId: vendorA, isSelectedVendor: false }, principal());
  await rfqs.createRfqVendorMapping({ rfqId, vendorId: vendorB, isSelectedVendor: false }, principal());

  const materialId = crypto.randomUUID();
  const qA = await rfqs.createQuotation({ rfqId, vendorId: vendorA, quotationNumber: 'Q-A-' + Date.now() }, principal());
  await rfqs.createQuotationItem({ quotationId: qA.quotationId, materialId, quotedQty: 10, quotedRate: rate }, principal());

  const qB = await rfqs.createQuotation({ rfqId, vendorId: vendorB, quotationNumber: 'Q-B-' + Date.now() }, principal());
  await rfqs.createQuotationItem({ quotationId: qB.quotationId, materialId, quotedQty: 12, quotedRate: rate + 5 }, principal());

  return { rfqId, vendorA, vendorB, quotationA: qA.quotationId, quotationB: qB.quotationId, materialId };
}

test('RFQ->PO award: happy path — select the winning quotation, then create a PO bound to its vendor/lines/prices', async () => {
  const { vendorA, quotationA, materialId } = await freshRfqWithTwoQuotations(150);
  const awarded = await rfqs.selectQuotation(quotationA, {}, principal());
  assert.equal(awarded.status, 'SELECTED');

  const { purchaseOrder, items } = await pos.createPurchaseOrder(
    { quotationId: quotationA, items: [] }, // client items are ignored — bound from the quotation
    principal(),
  );
  assert.equal(purchaseOrder.vendorId, vendorA);
  assert.equal(purchaseOrder.quotationId, quotationA);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.materialId, materialId);
  assert.equal(Number(items[0]!.orderedQty), 10);
  assert.equal(Number(items[0]!.rate), 150);
  assert.equal(Number(purchaseOrder.totalAmount), 1500);
});

test('RFQ->PO award: vendor mismatch is refused', async () => {
  const { vendorB, quotationA } = await freshRfqWithTwoQuotations();
  await rfqs.selectQuotation(quotationA, {}, principal());
  await assert.rejects(
    () => pos.createPurchaseOrder({ quotationId: quotationA, vendorId: vendorB, items: [] }, principal()),
    ForbiddenException,
  );
});

test('RFQ->PO award: an unselected quotation cannot back a purchase order', async () => {
  const { quotationA } = await freshRfqWithTwoQuotations();
  // Never selected/awarded — still just a submitted quotation.
  await assert.rejects(
    () => pos.createPurchaseOrder({ quotationId: quotationA, items: [] }, principal()),
    ConflictException,
  );
});

test('RFQ->PO award: a double award (two winners for one RFQ) is refused at the select step', async () => {
  const { quotationA, quotationB } = await freshRfqWithTwoQuotations();
  await rfqs.selectQuotation(quotationA, {}, principal());
  await assert.rejects(() => rfqs.selectQuotation(quotationB, {}, principal()), ConflictException);

  // The RFQ still has exactly one true winner — createPurchaseOrder off the never-awarded
  // quotation is refused too (defense in depth, same as "unselected quotation").
  await assert.rejects(
    () => pos.createPurchaseOrder({ quotationId: quotationB, items: [] }, principal()),
    ConflictException,
  );
});

test('RFQ->PO award: a quotation from a vendor never mapped to the RFQ cannot be selected', async () => {
  const sql = testClient();
  const rfq = await rfqs.createRfqMaster({ purchaseRequestId: crypto.randomUUID(), rfqDate: '2026-01-01' }, principal());
  const strangerVendor = crypto.randomUUID();
  await sql`insert into procurement.vendor_details (vendor_id, vendor_code, vendor_name, status)
    values (${strangerVendor}, ${'V-S-' + strangerVendor.slice(0, 8)}, 'Stranger', 'ACTIVE')`;
  // No rfq_vendor_mappings row for strangerVendor on this RFQ.
  const q = await rfqs.createQuotation({ rfqId: rfq.rfqId, vendorId: strangerVendor, quotationNumber: 'Q-S-' + Date.now() }, principal());
  await assert.rejects(() => rfqs.selectQuotation(q.quotationId, {}, principal()), ForbiddenException);
});

/* ── security review R1 #1: selectQuotation double-award TOCTOU ─────────── */

test('RFQ->PO award: concurrent selectQuotation on two DIFFERENT quotations of the same RFQ — only one may win', async () => {
  // Before the fix, selectQuotation read the "does this RFQ already have a winner" check with
  // no lock on the RFQ, so two concurrent awards for the same RFQ (different quotations) could
  // both pass the check before either had committed its UPDATE, and both would end up
  // status='SELECTED' — a double award. Repro (see the lane's throwaway race harness): out of
  // 20 trials of this exact race against the unfixed code, one trial produced two SELECTED
  // quotations for the same RFQ, and most of the rest hit a raw Postgres deadlock error instead
  // of a clean ConflictException (the two transactions' rfq_vendor_mappings updates lock-order
  // against each other once both existing-winner checks pass).
  //
  // The fix locks the rfq_master row FIRST (SELECT ... FOR UPDATE) so the second request blocks
  // until the first commits, then its existing-winner check always sees the first's committed
  // result — this also happens to eliminate the deadlock, since the lock forces one consistent
  // order instead of two transactions racing to lock each other's rows. Run the race many times
  // (a single trial only reproduces the bug ~1-in-20) and require it to be clean every time.
  for (let i = 0; i < 15; i++) {
    const { quotationA, quotationB } = await freshRfqWithTwoQuotations();
    const results = await Promise.allSettled([
      rfqs.selectQuotation(quotationA, {}, principal()),
      rfqs.selectQuotation(quotationB, {}, principal()),
    ]);
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    assert.equal(succeeded.length, 1, `trial ${i}: exactly one of two concurrent awards for the same RFQ may win`);
    for (const r of results) {
      if (r.status === 'rejected') {
        assert.ok(
          r.reason instanceof ConflictException,
          `trial ${i}: a losing concurrent award must fail cleanly with ConflictException, not ${(r.reason as Error)?.constructor?.name} (${(r.reason as Error)?.message})`,
        );
      }
    }

    const sql = testClient();
    const winners = await sql`select quotation_id from procurement.quotations
                                where quotation_id in (${quotationA}, ${quotationB}) and status = 'SELECTED'`;
    assert.equal(winners.length, 1, `trial ${i}: the RFQ must end up with exactly one SELECTED quotation, never two`);
  }
});

/* ── security review R1 #2: createPurchaseOrder double-PO TOCTOU ────────── */

test('PO award: concurrent createPurchaseOrder off the SAME selected quotation — only one PO may be created', async () => {
  // Before the fix, createPurchaseOrder re-read the quotation with no lock, so two concurrent
  // calls off the same already-SELECTED quotation could both pass every check and both insert a
  // purchase_order row — two POs backed by one quotation. The fix locks the quotation row and
  // checks for an existing PO under that lock, so the second concurrent call always sees the
  // first's (already-committed) purchase_order row and is refused.
  const { quotationA } = await freshRfqWithTwoQuotations();
  await rfqs.selectQuotation(quotationA, {}, principal());

  const results = await Promise.allSettled([
    pos.createPurchaseOrder({ quotationId: quotationA, items: [] }, principal()),
    pos.createPurchaseOrder({ quotationId: quotationA, items: [] }, principal()),
  ]);
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  assert.equal(succeeded.length, 1, 'exactly one of two concurrent POs off the same quotation may be created');
  for (const r of results) {
    if (r.status === 'rejected') assert.ok(r.reason instanceof ConflictException);
  }

  const sql = testClient();
  const posForQuotation = await sql`select purchase_order_id from procurement.purchase_order
                                       where quotation_id = ${quotationA}`;
  assert.equal(posForQuotation.length, 1, 'a quotation may back exactly one purchase order, never two');
});

test('RFQ->PO award: selecting an unknown quotation 404s', async () => {
  await assert.rejects(() => rfqs.selectQuotation(crypto.randomUUID(), {}, principal()), NotFoundException);
});

test('RFQ->PO award: creating a PO off an unknown quotation 404s', async () => {
  await assert.rejects(
    () => pos.createPurchaseOrder({ quotationId: crypto.randomUUID(), items: [] }, principal()),
    NotFoundException,
  );
});

test('RFQ->PO award: with no quotationId, direct/emergency PO creation is unchanged (items come straight from the body)', async () => {
  const { purchaseOrder, items } = await pos.createPurchaseOrder(
    { items: [{ materialId: crypto.randomUUID(), orderedQty: 5, rate: 20 }] },
    principal(),
  );
  assert.equal(items.length, 1);
  assert.equal(Number(purchaseOrder.totalAmount), 100);
});
