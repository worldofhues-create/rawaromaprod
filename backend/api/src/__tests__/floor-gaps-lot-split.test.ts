/**
 * FLOOR-1 (R8, production-floor plan §6, §13): a lot splits across two bins, and a partial lot that
 * comes back from the verifier becomes a new child lot with its genealogy kept. On a real Postgres.
 *
 *   - each split or return makes ONE child lot: its own inventory_batch row and its own L- code;
 *   - the stock ledger balances exactly in mg: parent before = parent after + child, and the two
 *     ledger rows sum to zero; a quantity the lot's unit cannot hold exactly is refused, never rounded;
 *   - the child keeps the parent's RM batch, so its QC release, hold and expiry (FEFO) are the parent's;
 *   - the child prints its own label (both codes), and a second print is a REPRINT with a reason;
 *   - the genealogy names the parent from the child and the children from the parent;
 *   - a return from the verifier names its job, only a lot picked on that job comes back, and it
 *     cannot return what the job's material issue is still due to debit.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSchema, testClient, productionDb, principal, closeTestClient } from '../../../test-support/db.js';
import { PickingService, MixingService, BatchService } from '@ra/cluster-production';
import type { VaultPort } from '../../../cluster-formula/src/vault-port.js';
import { FloorCodeService, LOT_BARCODE_RE, qtyToMg } from '../floor/floor-code.service.js';
import { FloorStationService } from '../floor/floor-station.service.js';
import { LotSplitService, mgToQty } from '../floor/lot-split.service.js';
import { label } from '../floor-ops/label-render.js';

const vault: VaultPort = { async resolveManufacturingInstruction() { return null; }, async resolvePickList() { return null; } };
let codes: FloorCodeService;
let stations: FloorStationService;
let splits: LotSplitService;
const sql = () => testClient();

const admin = principal({ roles: ['admin'], userId: '00000000-0000-7000-8000-00000000f001' });
const proc = principal({ roles: ['procurement'], userId: '00000000-0000-7000-8000-00000000f002', permissions: ['masterdata:material:reveal'] });
const store = principal({ roles: ['warehouse'], userId: '00000000-0000-7000-8000-00000000f003', permissions: ['inventory:lot_split:write'] });
const picker = principal({ roles: ['picker'], userId: '00000000-0000-7000-8000-00000000f004', permissions: [] });
const verifier = principal({ roles: ['verifier'], userId: '00000000-0000-7000-8000-00000000f005', permissions: [] });

before(async () => {
  await ensureSchema();
  codes = new FloorCodeService(sql());
  const db = productionDb();
  stations = new FloorStationService(sql(), codes, new PickingService(db, vault), new MixingService(db), new BatchService(db));
  splits = new LotSplitService(sql(), codes);
  await sql()`insert into iam.user_master (user_id, user_name, email, status) values (${store.userId}, 'Stores Sunita', 'sunita@rawaroma.local', 'ACTIVE') on conflict do nothing`;
});
after(closeTestClient);

const uid = () => crypto.randomUUID();
const tag = () => uid().slice(0, 6).toUpperCase();

async function uom(code: string): Promise<string> {
  await sql()`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values (${uid()}, ${code}, ${code}, 'ACTIVE') on conflict do nothing`;
  const [r] = await sql()`select uom_id::text from platform.uom_master where uom_code = ${code}`;
  return r!.uom_id as string;
}
async function family(): Promise<string> {
  const t = tag();
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const code = `fg_${t.toLowerCase()}`;
  await codes.setFamily({ familyCode: code, familyName: `Family ${t}`, colourName: `Tone${letters}`, colourHex: '#8B5A2B' }, admin);
  return code;
}
async function material(fam: string) {
  const id = uid();
  await sql()`insert into masterdata.material (material_id, material_code, material_name, status) values (${id}, ${'M-' + tag()}, 'Vetiver oil', 'ACTIVE')`;
  const fc = await codes.assignCode(id, fam, proc);
  return { id, code: fc.code };
}
let binSeq = 0;
async function bin(): Promise<{ id: string; code: string }> {
  const id = uid();
  const code = `FG8-${tag()}-${++binSeq}`;
  await sql()`insert into location.bin_master (bin_id, bin_code, status) values (${id}, ${code}, 'ACTIVE')`;
  return { id, code };
}
async function lot(materialId: string, qty: string, opts: { uom?: string; expiry?: string; result?: string } = {}) {
  const u = await uom(opts.uom ?? 'g');
  const rb = uid(), ib = uid(), b = await bin();
  const batchNo = `RM-${tag()}`;
  await sql()`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status, created_dt)
    values (${rb}, ${materialId}, ${batchNo}, ${opts.expiry ?? '2099-03-01'}, 'ACTIVE', now())`;
  await sql()`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values (${uid()}, ${rb}, ${opts.result ?? 'ACCEPT'})`;
  await sql()`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status)
    values (${ib}, ${rb}, ${materialId}, ${b.id}, ${qty}, ${u}, 'ACTIVE')`;
  const barcode = await codes.lotBarcode(ib, null);
  return { inventoryBatchId: ib, rmBatchId: rb, barcode, bin: b, batchNo };
}
async function onHandMg(inventoryBatchId: string): Promise<number> {
  const [r] = await sql()`select ib.quantity_on_hand::text as q, u.uom_code from inventory.inventory_batch ib left join platform.uom_master u on u.uom_id = ib.uom_id where ib.inventory_batch_id = ${inventoryBatchId}`;
  return qtyToMg(r!.q as string, r!.uom_code as string)!;
}

/* ── units ─────────────────────────────────────────────────────────────────────────────── */

test('mgToQty: exact in the lot\'s own unit, or null (never rounded)', () => {
  assert.equal(mgToQty(250_500, 'g'), '250.5000');
  assert.equal(mgToQty(100, 'kg'), '0.0001');
  assert.equal(mgToQty(1, 'kg'), null, '1 mg is below what numeric(18,4) kg holds');
  assert.equal(mgToQty(1, 'g'), '0.0010');
  assert.equal(mgToQty(7, 'mg'), '7.0000');
  assert.equal(mgToQty(5, 'litre'), null);
  for (const [mg, u] of [[250_500, 'g'], [1_234_500, 'kg'], [3, 'mg']] as const) assert.equal(qtyToMg(mgToQty(mg, u), u), mg);
});

/* ── split ─────────────────────────────────────────────────────────────────────────────── */

test('split: a child lot with its own L- code in another bin; the ledger balances to the mg', async () => {
  const m = await material(await family());
  const p = await lot(m.id, '1000.0000');
  const to = await bin();
  const out = await splits.split(p.barcode, { qtyMg: 250_500, bin: to.code }, store);
  assert.equal(out.kind, 'SPLIT');
  assert.match(out.child.barcode, LOT_BARCODE_RE);
  assert.notEqual(out.child.barcode, p.barcode);
  assert.equal(out.child.bin, to.code);
  assert.equal(out.child.qtyMg, 250_500);
  assert.equal(out.parent.qtyMg, 749_500);
  assert.equal(await onHandMg(p.inventoryBatchId), 749_500);
  assert.equal(await onHandMg(out.child.inventoryBatchId), 250_500);
  assert.equal((await onHandMg(p.inventoryBatchId)) + (await onHandMg(out.child.inventoryBatchId)), 1_000_000);
  // the ledger: one row per side, referencing the split, summing to zero in mg
  const led = await sql()`select t.inventory_batch_id::text as b, t.transaction_qty::text as q, u.uom_code, t.from_location_id::text as f, t.to_location_id::text as t
    from inventory.inventory_transaction t left join platform.uom_master u on u.uom_id = t.uom_id where t.reference_document_id = ${out.lotSplitId} order by t.transaction_qty`;
  assert.equal(led.length, 2);
  assert.deepEqual(led.map((r) => [r.b, qtyToMg(r.q as string, r.uom_code as string)]), [[p.inventoryBatchId, -250_500], [out.child.inventoryBatchId, 250_500]]);
  assert.equal(led.reduce((a, r) => a + qtyToMg(r.q as string, r.uom_code as string)!, 0), 0);
  assert.ok(led.every((r) => r.f === p.bin.id && r.t === to.id), 'from the parent bin to the new bin');
  const ev = await sql()`select event_type, event_qty::text as q from inventory.inventory_event_history where reference_document_id = ${out.lotSplitId} order by event_type`;
  assert.deepEqual(ev.map((e) => e.event_type), ['LOT_SPLIT_IN', 'LOT_SPLIT_OUT']);
  const [row] = await sql()`select qty_mg::int, parent_before_mg::int, kind, created_by from inventory.lot_split where lot_split_id = ${out.lotSplitId}`;
  assert.deepEqual([row!.qty_mg, row!.parent_before_mg, row!.kind, row!.created_by], [250_500, 1_000_000, 'SPLIT', store.userId]);
});

test('split: the child keeps the parent\'s RM batch, lot number, expiry and QC release (FEFO keeps the parent\'s date)', async () => {
  const m = await material(await family());
  const soon = await lot(m.id, '500.0000', { expiry: '2098-02-01' });
  const late = await lot(m.id, '500.0000', { expiry: '2099-09-01' });
  const out = await splits.split(late.barcode, { qtyMg: 100_000, bin: (await bin()).code }, store);
  const [c] = await sql()`select rm_batch_id::text, material_id::text from inventory.inventory_batch where inventory_batch_id = ${out.child.inventoryBatchId}`;
  assert.equal(c!.rm_batch_id, late.rmBatchId);
  assert.equal(c!.material_id, m.id);
  const r = await codes.resolve(out.child.barcode, store);
  assert.equal(r.expiry, '2099-09-01');
  assert.equal(r.lot, late.batchNo);
  assert.equal(r.status, 'RELEASED');
  assert.equal(r.pickable, true);
  assert.equal(r.floorCode, m.code);
  assert.equal(out.child.expiry, '2099-09-01');
  // FEFO across the family: the earlier-expiring parent still comes first; the child sorts with its parent's date.
  const order = await sql()`select ib.inventory_batch_id::text as id from inventory.inventory_batch ib join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
    where ib.material_id = ${m.id} and ib.quantity_on_hand > 0 order by rb.expiry_date asc, rb.created_dt asc`;
  assert.equal(order[0]!.id, soon.inventoryBatchId);
  assert.ok(order.slice(1).some((x) => x.id === out.child.inventoryBatchId));
});

test('split: refused for the whole lot, zero, a fraction of a mg, an unknown bin or lot, the same bin, a held lot, an inexact unit', async () => {
  const m = await material(await family());
  const p = await lot(m.id, '10.0000');
  const to = (await bin()).code;
  await assert.rejects(() => splits.split(p.barcode, { qtyMg: 10_000, bin: to }, store), /whole lot/);
  await assert.rejects(() => splits.split(p.barcode, { qtyMg: 20_000, bin: to }, store), /holds only/);
  await assert.rejects(() => splits.split(p.barcode, { qtyMg: 0, bin: to }, store), /how much/i);
  await assert.rejects(() => splits.split(p.barcode, { qtyMg: 1.5, bin: to }, store), /how much/i);
  await assert.rejects(() => splits.split(p.barcode, { qtyMg: 1000, bin: 'NO-SUCH-BIN' }, store), /No bin NO-SUCH-BIN/);
  await assert.rejects(() => splits.split(p.barcode, { qtyMg: 1000, bin: '' }, store), /Scan the bin/);
  await assert.rejects(() => splits.split(p.barcode, { qtyMg: 1000, bin: p.bin.code }, store), /already in/);
  await assert.rejects(() => splits.split('L-0000000', { qtyMg: 1000, bin: to }, store), /not known/);
  await assert.rejects(() => splits.split('RM-NOPE', { qtyMg: 1000, bin: to }, store), /lot label/);
  const kg = await lot(m.id, '2.0000', { uom: 'kg' });
  await assert.rejects(() => splits.split(kg.barcode, { qtyMg: 150, bin: to }, store), /0\.1 g/);
  const ok = await splits.split(kg.barcode, { qtyMg: 500_100, bin: to }, store);
  assert.equal(await onHandMg(kg.inventoryBatchId), 1_499_900);
  assert.equal(ok.child.qtyMg, 500_100);
  await sql()`insert into inventory.lot_hold (subject_type, subject_id, reason, source, held_by) values ('RM_LOT', ${p.rmBatchId}, 'odour off', 'MANUAL', 'qc')`;
  await assert.rejects(() => splits.split(p.barcode, { qtyMg: 1000, bin: to }, store), /on hold/);
  // nothing moved on any refusal
  assert.equal(await onHandMg(p.inventoryBatchId), 10_000);
});

test('split: two stations splitting the same lot at once cannot overdraw it', async () => {
  const m = await material(await family());
  const p = await lot(m.id, '1000.0000');
  const tries = await Promise.allSettled([1, 2].map(async () => splits.split(p.barcode, { qtyMg: 600_000, bin: (await bin()).code }, store)));
  assert.equal(tries.filter((t) => t.status === 'fulfilled').length, 1);
  assert.match(String((tries.find((t) => t.status === 'rejected') as PromiseRejectedResult).reason), /holds only/);
  assert.equal(await onHandMg(p.inventoryBatchId), 400_000);
});

/* ── genealogy ─────────────────────────────────────────────────────────────────────────── */

test('genealogy: the child names its parent; the parent lists its children; a recall row is kept for the RM lot', async () => {
  const m = await material(await family());
  const p = await lot(m.id, '900.0000');
  const a = await splits.split(p.barcode, { qtyMg: 100_000, bin: (await bin()).code }, store);
  const b = await splits.split(a.child.barcode, { qtyMg: 40_000, bin: (await bin()).code }, store);
  const g = await splits.genealogy(b.child.barcode);
  assert.equal(g.lot.barcode, b.child.barcode);
  assert.deepEqual(g.ancestors.map((x) => x.barcode), [a.child.barcode, p.barcode], 'grand-child -> child -> original');
  assert.equal(g.ancestors[0]!.kind, 'SPLIT');
  assert.equal(g.ancestors[0]!.qtyMg, 40_000);
  const root = await splits.genealogy(p.barcode);
  assert.equal(root.ancestors.length, 0);
  assert.deepEqual(root.children.map((x) => [x.barcode, x.qtyMg, x.kind]), [[a.child.barcode, 100_000, 'SPLIT']]);
  assert.equal(root.children[0]!.by, 'Stores Sunita');
  const gen = await sql()`select relationship_type from inventory.batch_genealogy_history where rm_batch_id = ${p.rmBatchId} order by created_dt`;
  assert.deepEqual(gen.map((x) => x.relationship_type), ['LOT_SPLIT', 'LOT_SPLIT']);
  // scan-resolve carries the split line too
  const r = await codes.resolve(a.child.barcode, store);
  assert.equal(r.splitFrom, p.barcode);
});

/* ── the child's label ─────────────────────────────────────────────────────────────────── */

test('label: the child prints its own label with both codes; a second print is a REPRINT with a reason and the person', async () => {
  const m = await material(await family());
  const p = await lot(m.id, '300.0000');
  const out = await splits.split(p.barcode, { qtyMg: 50_000, bin: (await bin()).code }, store);
  assert.equal(out.label.reprint, false, 'the split prints the first label');
  assert.equal(out.label.barcode, out.child.barcode);
  assert.equal(out.label.splitFrom, p.barcode);
  assert.equal(out.label.lot, p.batchNo);
  assert.equal(out.label.expiry, '2099-03-01');
  assert.equal(out.label.floorCode, m.code);
  assert.ok(out.label.colourName && out.label.initial, 'the colour name and initial print with the colour');
  assert.equal(out.label.hazard, 'Classification pending: handle as hazardous');
  assert.equal(out.label.person, 'Stores Sunita');
  assert.ok(!/vetiver/i.test(JSON.stringify(out.label)), 'no material name on a floor label');
  const t = label().build({ title: 'RAW LOT (SPLIT)', code: out.label.barcode, lines: [] }, '100x50');
  assert.ok(t.elements.some((e) => e.t === 'code128' && e.d === out.child.barcode));
  assert.ok(t.elements.some((e) => e.t === 'qr' && e.d === out.child.barcode));
  await assert.rejects(() => splits.printLabel(out.child.barcode, null, store), /needs a reason/);
  const again = await splits.printLabel(out.child.barcode, 'smudged by solvent', store);
  assert.equal(again.reprint, true);
  assert.equal(again.reason, 'smudged by solvent');
  const log = await sql()`select reprint, reason, printed_by from inventory.lot_label where inventory_batch_id = ${out.child.inventoryBatchId} order by printed_dt`;
  assert.deepEqual(log.map((x) => [x.reprint, x.reason, x.printed_by]), [[false, null, store.userId], [true, 'smudged by solvent', store.userId]]);
});

/* ── partial return from the verifier ──────────────────────────────────────────────────── */

async function pickedJob() {
  const m = await material(await family());
  const p = await lot(m.id, '1000.0000');
  const g = await uom('g');
  const orderId = uid(), pl = uid();
  await sql()`insert into production.production_order (production_order_id, order_qty, uom_id, status) values (${orderId}, 1, ${g}, 'INPROGRESS')`;
  await sql()`insert into production.material_pick_list (material_pick_list_id, production_order_id, status) values (${pl}, ${orderId}, 'ACTIVE')`;
  await sql()`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, uom_id, status)
    values (${uid()}, ${orderId}, ${m.id}, 125.5, false, ${g}, 'ACTIVE')`;
  await sql()`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, uom_id, status, created_dt)
    values (${uid()}, ${pl}, ${m.id}, 125.5, ${g}, 'ACTIVE', clock_timestamp())`;
  const job = await stations.createJob(orderId, { steps: [] }, admin);
  return { m, p, job, orderId };
}

test('return: refused before the pick, for a lot not on the job, and past what the issue is still due to take', async () => {
  const s = await pickedJob();
  const back = (await bin()).code;
  await assert.rejects(() => splits.returnLeftover(s.job.floorJobId, { lot: s.p.barcode, qtyMg: 1000, bin: back }, verifier), /not been picked/);
  const [l] = (await stations.pickView(s.job.floorJobId)).lines;
  await stations.pickLine(s.job.floorJobId, l!.floorLineId, { bin: s.p.bin.code, barcode: s.p.barcode }, picker);
  await stations.completePick(s.job.floorJobId, { tote: `T-${tag()}` }, picker);
  const other = await lot(s.m.id, '50.0000');
  await assert.rejects(() => splits.returnLeftover(s.job.floorJobId, { lot: other.barcode, qtyMg: 1000, bin: back }, verifier), /not picked on this job/);
  await assert.rejects(() => splits.returnLeftover(s.job.floorJobId, { lot: s.p.barcode, qtyMg: 1000, bin: back }, picker), /picked this job/);
  // 1000 g on the book, 125.5 g still to be debited by the job's issue: at most 874.5 g can come back.
  await assert.rejects(() => splits.returnLeftover(s.job.floorJobId, { lot: s.p.barcode, qtyMg: 874_501, bin: back }, verifier), /874\.5 g/);
  assert.equal(await onHandMg(s.p.inventoryBatchId), 1_000_000);
});

test('return: the leftover becomes a child lot tied to the job, printed, in the genealogy, with the parent\'s expiry', async () => {
  const s = await pickedJob();
  const [l] = (await stations.pickView(s.job.floorJobId)).lines;
  await stations.pickLine(s.job.floorJobId, l!.floorLineId, { bin: s.p.bin.code, barcode: s.p.barcode }, picker);
  await stations.completePick(s.job.floorJobId, { tote: `T-${tag()}` }, picker);
  const back = await bin();
  const out = await splits.returnLeftover(s.job.floorJobId, { lot: `]C0${s.p.barcode}\r`, qtyMg: 874_500, bin: back.code }, verifier);
  assert.equal(out.kind, 'RETURN');
  assert.equal(out.child.qtyMg, 874_500);
  assert.equal(out.parent.qtyMg, 125_500, 'what the issue still takes stays on the parent');
  assert.equal(out.child.expiry, '2099-03-01');
  assert.equal(out.label.kind, 'RETURN');
  assert.equal(out.label.jobNo, s.job.jobNo);
  const [row] = await sql()`select floor_job_id::text, kind from inventory.lot_split where lot_split_id = ${out.lotSplitId}`;
  assert.deepEqual([row!.floor_job_id, row!.kind], [s.job.floorJobId, 'RETURN']);
  const g = await splits.genealogy(out.child.barcode);
  assert.equal(g.ancestors[0]!.barcode, s.p.barcode);
  assert.equal(g.ancestors[0]!.jobNo, s.job.jobNo);
  const [gen] = await sql()`select relationship_type from inventory.batch_genealogy_history where rm_batch_id = ${s.p.rmBatchId}`;
  assert.equal(gen!.relationship_type, 'LOT_RETURN');
  // the verifier's leftover list for the job
  const list = await splits.jobReturns(s.job.floorJobId);
  assert.deepEqual(list.map((x) => x.barcode), [out.child.barcode]);
  // a reprint from the station goes through the job, and only for its own returns
  const rp = await splits.printJobLabel(s.job.floorJobId, out.child.barcode, 'dropped', verifier);
  assert.equal(rp.reprint, true);
  const stray = await splits.split((await lot(s.m.id, '20.0000')).barcode, { qtyMg: 1000, bin: (await bin()).code }, store);
  await assert.rejects(() => splits.printJobLabel(s.job.floorJobId, stray.child.barcode, 'x', verifier), /not a return from this job/);
});
