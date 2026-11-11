/**
 * PROD-B-8 — the P2 services against real Postgres: gate hold, receiving audit -> GRN + debit note,
 * cumulative deliveries, payment release maker-checker / UTR / overpayment, checkpoint versioning,
 * QC rounds + rework, lot hold blocking issue, recall review, putaway label.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSchema, testClient, inventoryDb, principal, closeTestClient } from '../../../test-support/db.js';
import { GateService } from '../../../cluster-inventory/src/gate/gate.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { ReceivingService } from '../prodfloor/receiving.service.js';
import { PaymentReleaseService } from '../prodfloor/payment-release.service.js';
import { QcFloorService } from '../prodfloor/qc-floor.service.js';
import { LotTraceService, resolveRmLot } from '../prodfloor/lot-trace.service.js';
import { FloorCodeService } from '../floor/floor-code.service.js';

const sql = () => testClient();
let gate: GateService, recv: ReceivingService, pay: PaymentReleaseService, qc: QcFloorService, lots: LotTraceService;
let kg: string;
const BUYER = '00000000-0000-7000-8000-0000000000c1';
const FIN1 = '00000000-0000-7000-8000-0000000000c2';
const FIN2 = '00000000-0000-7000-8000-0000000000c3';
const QC1 = '00000000-0000-7000-8000-0000000000c4';
const QC2 = '00000000-0000-7000-8000-0000000000c5';
const KG = 1_000_000;
const OK = { countWeight: { ok: true }, sealIntact: { ok: true }, labelMatches: { ok: true }, coaPresent: { ok: true }, expiryOk: { ok: true }, noDamage: { ok: true } };

before(async () => {
  await ensureSchema();
  const s = sql();
  kg = String((await s`insert into platform.uom_master (uom_code, uom_name, status) values ('KG', 'Kilogram', 'ACTIVE')
                       on conflict (uom_code) do update set uom_name = excluded.uom_name returning uom_id`)[0]!.uom_id);
  const policy = new PolicyService(s);
  gate = new GateService(inventoryDb());
  recv = new ReceivingService(s, policy);
  pay = new PaymentReleaseService(s, policy);
  qc = new QcFloorService(s, policy);
  lots = new LotTraceService(s, new FloorCodeService(s)); // SCAN-5: the label mints the lot's opaque code
});
after(async () => { await closeTestClient(); });

async function po(lines: Array<{ qty: number; rate: number }>, status = 'ISSUED') {
  const s = sql();
  const poId = randomUUID(), vendor = randomUUID();
  await s`insert into procurement.purchase_order (purchase_order_id, po_number, vendor_id, status, created_by) values (${poId}, ${'PO-' + poId.slice(0, 6)}, ${vendor}, ${status}, ${BUYER})`;
  const items: string[] = [];
  for (const l of lines) {
    const id = randomUUID(); items.push(id);
    await s`insert into procurement.purchase_order_items (purchase_order_item_id, purchase_order_id, material_id, ordered_qty, uom_id, rate, amount, status)
            values (${id}, ${poId}, ${randomUUID()}, ${l.qty}, ${kg}, ${l.rate}, ${l.qty * l.rate}, 'ACTIVE')`;
  }
  return { poId, vendor, items };
}
async function truck(poId: string | null, vendor: string) {
  return (await gate.createGateEntry({ purchaseOrderId: poId, vendorId: vendor, documents: [] } as never, principal({ userId: BUYER }))).gateEntry;
}
const receiver = principal({ userId: '00000000-0000-7000-8000-0000000000c9', roles: ['receiving'] });

test('gate: no PO, a draft PO or the wrong vendor is held; the audit refuses a held truck', async () => {
  const g = await truck(null, randomUUID());
  assert.equal(g.status, 'HELD');
  assert.match(String(g.holdReason), /No purchase order/);
  const d = await po([{ qty: 1, rate: 1 }], 'DRAFT');
  assert.equal((await truck(d.poId, d.vendor)).status, 'HELD');
  const ok = await po([{ qty: 1, rate: 1 }]);
  assert.equal((await truck(ok.poId, randomUUID())).status, 'HELD');
  await assert.rejects(() => recv.submit({ gateEntryId: g.gateEntryId, lines: [{ poItemId: ok.items[0], receivedBase: 1, checks: OK }] }, receiver), /held at the gate/);
  // resolve by naming the PO (vendor recorded on the truck must match)
  const g2 = await truck(null, ok.vendor);
  const r = await recv.resolveHold(g2.gateEntryId, { purchaseOrderId: ok.poId, reason: 'PO found' }, principal({ userId: BUYER }));
  assert.equal(r.status, 'ACTIVE');
});

test('receiving: PO preview shows the rule; a 30%-short close rejects the short line, writes the GRN and a debit note', async () => {
  const p = await po([{ qty: 10, rate: 1000 }, { qty: 10, rate: 500 }]);
  const pv = await recv.preview(p.poId);
  assert.equal(pv.rule.scope, 'PO');
  assert.equal(pv.rule.shortRejectBps, 2000);
  assert.equal(pv.lines[0]!.orderedBase, 10 * KG);
  const g = await truck(p.poId, p.vendor);
  const r = await recv.submit({ gateEntryId: g.gateEntryId, finalDelivery: true, lines: [
    { poItemId: p.items[0], receivedBase: 4 * KG, checks: OK },
    { poItemId: p.items[1], receivedBase: 10 * KG, checks: OK },
  ] }, receiver);
  assert.equal(r.lines[0]!.decision, 'REJECT_LINE');
  assert.equal(r.lines[1]!.decision, 'ACCEPT');
  assert.ok(r.grnId);
  // 4 kg rejected + 6 kg short = 10 kg x Rs 1000 = Rs 10,000
  assert.equal(r.debitNote!.amountPaise, '1000000');
  const gi = await sql()`select accepted_qty::float8 as a, rejected_qty::float8 as r from inventory.grn_items where grn_id = ${r.grnId} order by received_qty`;
  assert.deepEqual(gi.map((x) => [x.a, x.r]), [[0, 4], [10, 0]]);
  await assert.rejects(() => recv.submit({ gateEntryId: g.gateEntryId, lines: [{ poItemId: p.items[1], receivedBase: 1, checks: OK }] }, receiver), /already been audited/);
});

test('receiving: two deliveries are judged cumulatively at PO close; an override is admin/owner only', async () => {
  const p = await po([{ qty: 10, rate: 100 }]);
  const a = await recv.submit({ gateEntryId: (await truck(p.poId, p.vendor)).gateEntryId, lines: [{ poItemId: p.items[0], receivedBase: 5 * KG, checks: OK }] }, receiver);
  assert.equal(a.lines[0]!.decision, 'PENDING_BALANCE');
  assert.equal(a.debitNote, null);
  const b = await recv.submit({ gateEntryId: (await truck(p.poId, p.vendor)).gateEntryId, finalDelivery: true, lines: [{ poItemId: p.items[0], receivedBase: 4 * KG, checks: OK }] }, receiver);
  assert.equal(b.deliveryNo, 2);
  assert.equal(b.lines[0]!.decision, 'ACCEPT_SHORT');
  assert.equal(b.debitNote!.amountPaise, '10000'); // 1 kg short x Rs 100
  const g = await truck(p.poId, p.vendor);
  await assert.rejects(() => recv.submit({ gateEntryId: g.gateEntryId, lines: [{ poItemId: p.items[0], receivedBase: 2, checks: OK, override: { acceptedBase: 1, rejectedBase: 1, reason: 'x' } }] }, receiver), /admin or the owner/);
});

test('payment: terms hold until a rule exists; maker-checker, UTR and overpayment are enforced', async () => {
  const p = await po([{ qty: 10, rate: 1000 }]);
  const fin1 = principal({ userId: FIN1 }), fin2 = principal({ userId: FIN2 });
  const s0 = await pay.summary(p.poId);
  if (!s0.terms) {
    assert.match(String(s0.hold), /hold/i);
    await assert.rejects(() => pay.request({ purchaseOrderId: p.poId, kind: 'ADVANCE', amountPaise: 1 }, fin1), /hold/i);
  }
  // Scoped to this PO (a one-record override), so the global "payment terms hold" default stays as seeded.
  await sql()`insert into platform.policy_override (policy_key, record_type, record_id, value, reason, created_by, created_dt)
    values ('procurement.payment_terms', 'purchase_order', ${p.poId}, ${JSON.stringify({ mode: 'ADVANCE_BALANCE', advanceBps: 3000 })}::jsonb, 'test', 'test', now() - interval '1 second')`;
  const s = await pay.summary(p.poId);
  assert.equal(s.releasablePaise.ADVANCE, 300000); // 30% of Rs 10,000
  await assert.rejects(() => pay.request({ purchaseOrderId: p.poId, kind: 'ADVANCE', amountPaise: 300001 }, fin1), /more than is due/);
  const r = await pay.request({ purchaseOrderId: p.poId, kind: 'ADVANCE', amountPaise: 300000 }, fin1);
  await assert.rejects(() => pay.approve(String(r!.releaseId), fin1), /requested/);
  await assert.rejects(() => pay.approve(String(r!.releaseId), principal({ userId: BUYER })), /raised/);
  await assert.rejects(() => pay.release(String(r!.releaseId), { utr: 'UTR1' }, fin2), /Approve/);
  await pay.approve(String(r!.releaseId), fin2);
  await assert.rejects(() => pay.release(String(r!.releaseId), { utr: ' ' }, fin2), /UTR/);
  const utr = 'UTR' + randomUUID().slice(0, 8);
  const rel = await pay.release(String(r!.releaseId), { utr }, fin2);
  assert.equal(rel.status, 'RELEASED');
  // no GRN yet: no balance is payable, and no more advance
  await assert.rejects(() => pay.request({ purchaseOrderId: p.poId, kind: 'BALANCE', amountPaise: 1 }, fin1), /more than is due/);
  await assert.rejects(() => pay.request({ purchaseOrderId: p.poId, kind: 'ADVANCE', amountPaise: 1 }, fin1), /more than is due/);
  // accept 9 kg (10% short) -> Rs 9,000 accepted, Rs 3,000 paid: balance up to Rs 6,000
  await recv.submit({ gateEntryId: (await truck(p.poId, p.vendor)).gateEntryId, finalDelivery: true, lines: [{ poItemId: p.items[0], receivedBase: 9 * KG, checks: OK }] }, receiver);
  assert.equal((await pay.summary(p.poId)).releasablePaise.BALANCE, 600000);
  const b = await pay.request({ purchaseOrderId: p.poId, kind: 'BALANCE', amountPaise: 600000 }, fin1);
  await pay.approve(String(b!.releaseId), fin2);
  await assert.rejects(() => pay.release(String(b!.releaseId), { utr }, fin2), /already recorded/);
});

async function productAndBatch() {
  const s = sql();
  const productId = randomUUID(), oil = randomUUID();
  await s`insert into packaging.product_master (product_id, product_code, product_name, status) values (${productId}, ${'P-' + productId.slice(0, 6)}, 'Test product', 'ACTIVE')`;
  await s`insert into production.oil_batch_master (oil_batch_id, batch_number, produced_qty, uom_id, status) values (${oil}, ${'OB-' + oil.slice(0, 6)}, 100, ${kg}, 'ACTIVE')`;
  return { productId, oil };
}
const CPS = [
  { name: 'Odour profile', checkType: 'REFERENCE', critical: true },
  { name: 'Strength', checkType: 'RANGE', min: 9.5, max: 10.5 },
];

test('checkpoints are versioned: an old batch keeps the set it was first tested on', async () => {
  const { productId, oil } = await productAndBatch();
  await assert.rejects(() => qc.publish(productId, { checkpoints: CPS }, principal()), /why/);
  const v1 = await qc.publish(productId, { reason: 'first', checkpoints: CPS }, principal());
  const set1 = await qc.checkpoints(productId);
  const [c1, c2] = set1.checkpoints;
  const r = await qc.recordRound(oil, { productId, results: [{ checkpointId: c1!.id, pass: true }, { checkpointId: c2!.id, value: 9 }], defectType: 'STRENGTH' }, principal({ userId: QC1 }));
  assert.equal(r.decision, 'REWORK');
  const v2 = await qc.publish(productId, { reason: 'tighter', checkpoints: [...CPS, { name: 'Clarity', checkType: 'PASS_FAIL' }] }, principal());
  assert.equal(v2.version, v1.version + 1);
  const b = await qc.batch(oil);
  assert.equal(b.checkpoints!.length, 2, 'the batch still sees version 1');
  // re-QC refused until the rework is recorded; envelope 5% of 100 kg = 5 kg
  await assert.rejects(() => qc.recordRound(oil, { results: [] }, principal({ userId: QC1 })), /Record the rework/);
  await assert.rejects(() => qc.recordRework(oil, { adjustmentMg: 6 * KG, note: 'add' }, principal()), /envelope/);
  // WALK2-RP-13: the raw lot added is named by its lot number; an unknown one is refused before anything is written.
  const addRm = randomUUID(), addNo = 'RMA-' + addRm.slice(0, 8);
  await sql()`insert into inventory.rm_batch_master (rm_batch_id, batch_number, received_qty, uom_id, status) values (${addRm}, ${addNo}, 5, ${kg}, 'ACTIVE')`;
  await assert.rejects(() => qc.recordRework(oil, { adjustmentMg: 1 * KG, note: 'raised strength', rmBatchId: 'NO-SUCH-LOT' }, principal()), /No raw lot/);
  await qc.recordRework(oil, { adjustmentMg: 1 * KG, note: 'raised strength', rmBatchId: addNo.toLowerCase() }, principal());
  assert.equal((await sql()`select rm_batch_id::text as id from quality.batch_rework where oil_batch_id = ${oil}`)[0]!.id, addRm);
  await assert.rejects(() => qc.recordRound(oil, { results: [{ checkpointId: c2!.id, value: 10 }] }, principal({ userId: QC1 })), /Odour profile/);
  // same checkpoint fails again -> hold + CAPA, batch frozen
  const r2 = await qc.recordRound(oil, { results: [{ checkpointId: c1!.id, pass: true }, { checkpointId: c2!.id, value: 9.2 }], defectType: 'STRENGTH' }, principal({ userId: QC1 }));
  assert.equal(r2.decision, 'HOLD_CAPA');
  assert.ok(r2.capaId);
  assert.ok((await qc.batch(oil)).hold);
  await assert.rejects(() => qc.recordRound(oil, { results: [] }, principal({ userId: QC2 })), /HOLD_CAPA/);
});

test('instrument doubt holds for a retest by a different person', async () => {
  const { productId, oil } = await productAndBatch();
  await qc.publish(productId, { reason: 'v', checkpoints: CPS }, principal());
  const [c1, c2] = (await qc.checkpoints(productId)).checkpoints;
  const res = [{ checkpointId: c1!.id, pass: true }, { checkpointId: c2!.id, value: 9 }];
  assert.equal((await qc.recordRound(oil, { productId, results: res, defectType: 'STRENGTH', instrumentDoubt: true }, principal({ userId: QC1 }))).decision, 'HOLD_RETEST');
  await assert.rejects(() => qc.recordRound(oil, { results: res, defectType: 'STRENGTH' }, principal({ userId: QC1 })), /different QC person/);
  assert.equal((await qc.recordRound(oil, { results: res, defectType: 'STRENGTH' }, principal({ userId: QC2 }))).decision, 'REJECT');
});

test('lot hold: a faulty raw lot is frozen, recall lists its batches and shipped orders, no label is printed', async () => {
  const s = sql();
  const rm = randomUUID(), ib = randomUUID(), order = randomUUID(), oil = randomUUID(), fg = randomUUID(), pko = randomUUID(), so = randomUUID(), disp = randomUUID(), mi = randomUUID();
  await s`insert into inventory.rm_batch_master (rm_batch_id, batch_number, received_qty, uom_id, status, expiry_date) values (${rm}, ${'RMB-' + rm.slice(0, 8)}, 5, ${kg}, 'ACTIVE', '2099-01-01')`;
  await s`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values (${randomUUID()}, ${rm}, 'ACCEPT')`; // FLOOR-QC-IN-1: QC released it
  await s`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, quantity_on_hand, status) values (${ib}, ${rm}, 5, 'ACTIVE')`;
  await s`insert into production.production_order (production_order_id, status) values (${order}, 'ACTIVE')`;
  await s`insert into production.material_issue (material_issue_id, production_order_id, status) values (${mi}, ${order}, 'ACTIVE')`;
  await s`insert into production.material_issue_item (material_issue_id, inventory_batch_id, status) values (${mi}, ${ib}, 'ACTIVE')`;
  await s`insert into production.oil_batch_master (oil_batch_id, production_order_id, batch_number, status) values (${oil}, ${order}, ${'OB-' + oil.slice(0, 6)}, 'ACTIVE')`;
  await s`insert into packaging.package_order (package_order_id, oil_batch_id, status) values (${pko}, ${oil}, 'ACTIVE')`;
  await s`insert into packaging.finished_good_batch_master (finished_good_batch_id, package_order_id, batch_number, status) values (${fg}, ${pko}, ${'FG-' + fg.slice(0, 6)}, 'ACTIVE')`;
  await s`insert into sales.sales_order (sales_order_id, so_number, status) values (${so}, ${'SO-' + so.slice(0, 6)}, 'ACTIVE')`;
  await s`insert into sales.dispatch_master (dispatch_id, sales_order_id, status) values (${disp}, ${so}, 'DISPATCHED')`;
  await s`insert into sales.dispatch_items (dispatch_item_id, dispatch_id, finished_good_batch_id, dispatched_qty) values (${randomUUID()}, ${disp}, ${fg}, 1)`;

  // A real bin (WALK2-RP-11: an unknown bin id is refused, and the label prints the bin's code).
  const bin = randomUUID(), binCode = 'B-' + bin.slice(0, 6).toUpperCase();
  await s`insert into location.storage_location_master (storage_location_id, storage_location_code, status) values (${bin}, ${binCode}, 'ACTIVE')`;
  await assert.rejects(() => lots.putawayLabel(rm, { storageLocationId: randomUUID() }, principal()), /No bin/);
  const label = await lots.putawayLabel(rm, { storageLocationId: binCode }, principal());
  assert.equal(label.storageLocationId, bin);
  assert.equal(label.binCode, binCode);
  assert.equal(label.hazard, 'Classification pending: handle as hazardous');
  assert.equal(label.reprint, false);
  // SCAN-5: the raw-lot label carries the opaque L- code the picker scans, the same one scan-resolve
  // and pick know, and the hold / recall field resolves it back to this lot.
  assert.match(String(label.barcode), /^L-[0-9A-HJKMNP-TV-Z]{7}$/);
  assert.equal((await sql()`select inventory_batch_id::text as id from inventory.lot_barcode where barcode = ${label.barcode}`)[0]!.id, ib);
  assert.equal(await resolveRmLot(sql(), String(label.barcode)), rm);
  // SCAN-10: a second raw-lot label is a REPRINT and needs a reason (a duplicate lot label is a recall risk).
  await assert.rejects(() => lots.putawayLabel(rm, {}, principal()), /reprint needs a reason/i);
  const rp = await lots.putawayLabel(rm, { reprintReason: 'label smudged by solvent' }, principal());
  assert.equal(rp.reprint, true);
  assert.equal((await sql()`select payload->>'reprintReason' as r from inventory.raw_lot_label where rm_batch_id = ${rm} order by printed_dt desc limit 1`)[0]!.r, 'label smudged by solvent');

  await lots.hold({ subjectType: 'RM_LOT', subjectId: rm, reason: 'Batch failed, cause traced to this lot' }, principal());
  const rc = await lots.recall('rmb-' + rm.slice(0, 8)); // WALK2-RP-11: by the lot number on the label, any case
  await assert.rejects(() => lots.recall('NOT-A-LOT'), /No raw lot NOT-A-LOT/);
  assert.ok(rc.hold);
  assert.deepEqual(rc.batches.map((b) => b.oilBatchId), [oil]);
  assert.deepEqual(rc.finishedGoods.map((f) => f.finishedGoodBatchId), [fg]);
  assert.equal(rc.shippedOrders[0]!.salesOrderId, so);
  await assert.rejects(() => lots.putawayLabel(rm, {}, principal()), /on hold/);
  const h = (await lots.holds()).items.find((x) => (x as { subjectId: string }).subjectId === rm) as { lotHoldId: string };
  await assert.rejects(() => lots.release(h.lotHoldId, {}, principal()), /why/);
  await lots.release(h.lotHoldId, { reason: 'Retest passed, COA attached' }, principal());
});
