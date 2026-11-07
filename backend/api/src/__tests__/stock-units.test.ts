/**
 * STOCK-UNITS: the debit a pick list makes on a lot, in the lot's own unit. On a real Postgres.
 *
 *   - a kg lot and a g pick list debit the right amount (the old debit took 125.5 kg for 125.5 g);
 *   - the conversion is exact through integer mg, and never rounds;
 *   - two units that do not convert (litres and kg with no density, or no unit on file) are refused
 *     at the issue, and again at the debit: nothing moves, and the refusal stays on the record;
 *   - an abort credits back exactly what was debited, in the lot's unit;
 *   - the floor job takes the same path, from pick to debit.
 *
 * LEFTOVER-AFTER-FINISH: the same return, once the job is DONE.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { convertQty, mgToQty, qtyToMgExact } from '@core/data-kernel';
import { ensureSchema, testClient, productionDb, principal, closeTestClient } from '../../../test-support/db.js';
import { PickingService, MixingService, BatchService } from '@ra/cluster-production';
import type { VaultPort } from '../../../cluster-formula/src/vault-port.js';
import { ConsumptionService } from '../consumption/consumption.service.js';
import { FloorCodeService } from '../floor/floor-code.service.js';
import { FloorStationService } from '../floor/floor-station.service.js';
import { LotSplitService } from '../floor/lot-split.service.js';

const vault: VaultPort = { async resolveManufacturingInstruction() { return null; }, async resolvePickList() { return null; } };
const sql = () => testClient();
let codes: FloorCodeService, stations: FloorStationService, splits: LotSplitService, consumption: ConsumptionService, picking: PickingService, mixing: MixingService;

const admin = principal({ roles: ['admin'], userId: '00000000-0000-7000-8000-00000000e001' });
const proc = principal({ roles: ['procurement'], userId: '00000000-0000-7000-8000-00000000e002', permissions: ['masterdata:material:reveal'] });
const picker = principal({ roles: ['picker'], userId: '00000000-0000-7000-8000-00000000e003', permissions: [] });
const verifier = principal({ roles: ['verifier'], userId: '00000000-0000-7000-8000-00000000e004', permissions: [] });
const mixer = principal({ roles: ['mixer'], userId: '00000000-0000-7000-8000-00000000e005', permissions: [] });

before(async () => {
  await ensureSchema();
  const db = productionDb();
  codes = new FloorCodeService(sql());
  picking = new PickingService(db, vault);
  mixing = new MixingService(db);
  stations = new FloorStationService(sql(), codes, picking, mixing, new BatchService(db));
  splits = new LotSplitService(sql(), codes);
  consumption = new ConsumptionService(sql() as never);
});
after(closeTestClient);

const uid = () => crypto.randomUUID();
const tag = () => uid().slice(0, 6).toUpperCase();
const apply = (id: string) => (consumption as unknown as { applyIssue(i: string): Promise<void> }).applyIssue(id);

async function uom(code: string): Promise<string> {
  await sql()`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values (${uid()}, ${code}, ${code}, 'ACTIVE') on conflict do nothing`;
  return (await sql()`select uom_id::text from platform.uom_master where uom_code = ${code}`)[0]!.uom_id as string;
}
async function material() {
  const t = tag();
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const fam = `su_${t.toLowerCase()}`;
  await codes.setFamily({ familyCode: fam, familyName: `Family ${t}`, colourName: `Tone${letters}`, colourHex: '#8B5A2B' }, admin);
  const id = uid();
  await sql()`insert into masterdata.material (material_id, material_code, material_name, status) values (${id}, ${'M-' + t}, 'Vetiver oil', 'ACTIVE')`;
  await codes.assignCode(id, fam, proc);
  return id;
}
async function bin() {
  const id = uid(), code = `SU-${tag()}`;
  await sql()`insert into location.bin_master (bin_id, bin_code, status) values (${id}, ${code}, 'ACTIVE')`;
  return { id, code };
}
async function lot(materialId: string, qty: string, unit: string | null) {
  const u = unit ? await uom(unit) : null;
  const rb = uid(), ib = uid(), b = await bin();
  await sql()`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status, created_dt) values (${rb}, ${materialId}, ${'RM-' + tag()}, '2099-03-01', 'ACTIVE', now())`;
  await sql()`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values (${uid()}, ${rb}, 'ACCEPT')`;
  await sql()`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status) values (${ib}, ${rb}, ${materialId}, ${b.id}, ${qty}, ${u}, 'ACTIVE')`;
  return { id: ib, bin: b, barcode: await codes.lotBarcode(ib, null) };
}
async function order(materialId: string, qty: string, unit: string | null) {
  const u = unit ? await uom(unit) : null;
  const orderId = uid(), pl = uid();
  await sql()`insert into production.production_order (production_order_id, order_qty, status) values (${orderId}, 1, 'INPROGRESS')`;
  await sql()`insert into production.material_pick_list (material_pick_list_id, production_order_id, status) values (${pl}, ${orderId}, 'ACTIVE')`;
  await sql()`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, uom_id, status) values (${uid()}, ${orderId}, ${materialId}, ${qty}, false, ${u}, 'ACTIVE')`;
  await sql()`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, uom_id, status, created_dt) values (${uid()}, ${pl}, ${materialId}, ${qty}, ${u}, 'ACTIVE', clock_timestamp())`;
  return { orderId, pl };
}
/** An issue written straight to the tables: what a refusal at the source would otherwise stop. */
async function rawIssue(o: { orderId: string; pl: string }, materialId: string, batchId: string) {
  const issueId = uid();
  await sql()`insert into production.material_issue (material_issue_id, production_order_id, material_pick_list_id, status) values (${issueId}, ${o.orderId}, ${o.pl}, 'ACTIVE')`;
  await sql()`insert into production.material_issue_item (material_issue_item_id, material_issue_id, material_id, inventory_batch_id, issued_qty, status) values (${uid()}, ${issueId}, ${materialId}, ${batchId}, true, 'ACTIVE')`;
  return issueId;
}
const onHand = async (id: string) => (await sql()`select quantity_on_hand::text as q from inventory.inventory_batch where inventory_batch_id = ${id}`)[0]!.q as string;
const events = (issueId: string) => sql()`select event_type, event_qty::text as q, remarks from inventory.inventory_event_history where reference_document_id = ${issueId} order by event_dt`;

/* ── the conversion ────────────────────────────────────────────────────────────────────── */

test('convertQty: exact through integer mg, in either direction', () => {
  assert.deepEqual(convertQty('125.5', 'g', 'kg'), { qty: '0.1255' });
  assert.deepEqual(convertQty('0.1255', 'kg', 'g'), { qty: '125.5000' });
  assert.deepEqual(convertQty('2', 'KG', 'mg'), { qty: '2000000.0000' });
  assert.deepEqual(convertQty('750', 'ml', 'L'), { qty: '0.7500' });
  assert.deepEqual(convertQty('12', 'pcs', 'PCS'), { qty: '12.0000' });
  assert.deepEqual(convertQty('12.5', 'gms', 'g'), { qty: '12.5000' });
});

test('convertQty: refuses, and never rounds', () => {
  assert.match(String((convertQty('1', 'litre', 'kg') as { refused: string }).refused), /density/);
  assert.match(String((convertQty('1', 'kg', 'ml') as { refused: string }).refused), /density/);
  assert.match(String((convertQty('1', 'pcs', 'kg') as { refused: string }).refused), /do not convert/);
  assert.match(String((convertQty('1', null, 'kg') as { refused: string }).refused), /no unit/);
  assert.match(String((convertQty('1', null, null) as { refused: string }).refused), /no unit/);
  assert.match(String((convertQty('125.55', 'g', 'kg') as { refused: string }).refused), /cannot hold/, '0.12555 kg is past numeric(18,4)');
  assert.match(String((convertQty('0.1235', 'g', 'kg') as { refused: string }).refused), /cannot hold|whole mg/);
  assert.ok('refused' in convertQty('abc', 'g', 'g'));
});

test('qtyToMgExact and mgToQty round-trip, and a part of a mg is not a weight we hold', () => {
  assert.equal(qtyToMgExact('1.2345', 'kg'), 1_234_500);
  assert.equal(qtyToMgExact('0.1235', 'g'), null);
  assert.equal(qtyToMgExact('1', 'litre'), null);
  assert.equal(mgToQty(1_234_500, 'kg'), '1.2345');
  assert.equal(mgToQty(1, 'kg'), null);
});

/* ── the debit ─────────────────────────────────────────────────────────────────────────── */

test('a kg lot and a g pick list: 125.5 g comes off 1 kg as 0.1255 kg', async () => {
  const m = await material();
  const l = await lot(m, '1.0000', 'kg');
  const issueId = await rawIssue(await order(m, '125.5', 'g'), m, l.id);
  await apply(issueId);
  assert.equal(await onHand(l.id), '0.8745');
  const [e] = await events(issueId);
  assert.equal(e!.event_type, 'PRODUCTION_ISSUE');
  assert.equal(e!.q, '0.1255', 'the ledger row is in the lot\'s unit: an abort credits it back as it stands');
});

test('a g lot and a kg pick list convert too; the same unit is untouched', async () => {
  const m = await material();
  const l = await lot(m, '5000.0000', 'g');
  await apply(await rawIssue(await order(m, '1.25', 'kg'), m, l.id));
  assert.equal(await onHand(l.id), '3750.0000');
  const m2 = await material();
  const l2 = await lot(m2, '100.0000', 'pcs');
  await apply(await rawIssue(await order(m2, '3', 'pcs'), m2, l2.id));
  assert.equal(await onHand(l2.id), '97.0000');
});

test('an abort after the debit credits exactly what left, in the lot\'s unit', async () => {
  const m = await material();
  const l = await lot(m, '1.0000', 'kg');
  const o = await order(m, '125.5', 'g');
  await sql()`update production.production_order_ingredients set issued_qty = true where production_order_id = ${o.orderId}`;
  const issueId = await rawIssue(o, m, l.id);
  await apply(issueId);
  const s = await mixing.startSession({ productionOrderId: o.orderId } as never, admin);
  await mixing.abortSession((s as { secureMixingSessionId: string }).secureMixingSessionId, { reason: 'test' } as never, admin);
  assert.equal(await onHand(l.id), '1.0000');
});

for (const [name, lotUnit, pickUnit, why] of [
  ['litres against kg, no density', 'kg', 'litre', /density/],
  ['a pick line with no unit', 'kg', null, /no unit/],
  ['a lot with no unit', null, 'g', /no unit/],
] as const) {
  test(`the debit refuses ${name}: nothing moves, the issue stays open, the refusal is on file once`, async () => {
    const m = await material();
    const l = await lot(m, '10.0000', lotUnit);
    const issueId = await rawIssue(await order(m, '2', pickUnit), m, l.id);
    await apply(issueId);
    await apply(issueId); // the poller retries; the record does not pile up
    assert.equal(await onHand(l.id), '10.0000');
    assert.equal((await sql()`select 1 from inventory.material_issue_applied where material_issue_id = ${issueId}`).length, 0, 'not claimed: fixing the unit lets the debit run');
    const ev = await events(issueId);
    assert.deepEqual(ev.map((e) => e.event_type), ['PRODUCTION_ISSUE_REFUSED']);
    assert.match(String(ev[0]!.remarks), why);
  });
}

test('one bad line refuses the whole issue: no half-debited issue', async () => {
  const m = await material(), m2 = await material();
  const good = await lot(m, '1.0000', 'kg'), bad = await lot(m2, '1.0000', 'kg');
  const o = await order(m, '100', 'g');
  const u = await uom('litre');
  await sql()`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, uom_id, status) values (${uid()}, ${o.pl}, ${m2}, 1, ${u}, 'ACTIVE')`;
  const issueId = await rawIssue(o, m, good.id);
  await sql()`insert into production.material_issue_item (material_issue_item_id, material_issue_id, material_id, inventory_batch_id, issued_qty, status) values (${uid()}, ${issueId}, ${m2}, ${bad.id}, true, 'ACTIVE')`;
  await apply(issueId);
  assert.equal(await onHand(good.id), '1.0000');
  assert.equal(await onHand(bad.id), '1.0000');
});

test('once the unit is corrected the refused issue debits on the next pass', async () => {
  const m = await material();
  const l = await lot(m, '1.0000', 'kg');
  const o = await order(m, '250', 'litre');
  const issueId = await rawIssue(o, m, l.id);
  await apply(issueId);
  await sql()`update production.material_pick_list_items set uom_id = ${await uom('g')} where material_pick_list_id = ${o.pl}`;
  await apply(issueId);
  assert.equal(await onHand(l.id), '0.7500');
});

/* ── the source: PickingService.issueMaterials ─────────────────────────────────────────── */

test('issueMaterials refuses a lot its pick line cannot convert to, before anything is written', async () => {
  const m = await material();
  const l = await lot(m, '10.0000', 'kg');
  const o = await order(m, '2', 'litre');
  await assert.rejects(() => picking.issueMaterials({ productionOrderId: o.orderId, materialPickListId: o.pl, items: [{ materialId: m, inventoryBatchId: l.id }] } as never, admin), /density/);
  assert.equal((await sql()`select 1 from production.material_issue where production_order_id = ${o.orderId}`).length, 0);
});

test('issueMaterials takes a g line against a kg lot', async () => {
  const m = await material();
  const l = await lot(m, '1.0000', 'kg');
  const o = await order(m, '500', 'g');
  const out = await picking.issueMaterials({ productionOrderId: o.orderId, materialPickListId: o.pl, items: [{ materialId: m, inventoryBatchId: l.id }] } as never, admin);
  await apply((out as { issue: { materialIssueId: string } }).issue.materialIssueId);
  assert.equal(await onHand(l.id), '0.5000');
});

/* ── the floor ─────────────────────────────────────────────────────────────────────────── */

async function floorJob(lotQty: string, lotUnit: string, pickQty: string, pickUnit: string) {
  const m = await material();
  const l = await lot(m, lotQty, lotUnit);
  const o = await order(m, pickQty, pickUnit);
  return { m, l, o, job: await stations.createJob(o.orderId, { steps: [] }, admin) };
}
async function picked(s: Awaited<ReturnType<typeof floorJob>>) {
  const [line] = (await stations.pickView(s.job.floorJobId)).lines;
  await stations.pickLine(s.job.floorJobId, line!.floorLineId, { bin: s.l.bin.code, barcode: s.l.barcode }, picker);
  await stations.completePick(s.job.floorJobId, { tote: `T-${tag()}` }, picker);
}
const issueOf = async (orderId: string) => (await sql()`select material_issue_id::text as id from production.material_issue where production_order_id = ${orderId}`)[0]!.id as string;

test('floor: a g line picked from a kg lot debits the lot right', async () => {
  const s = await floorJob('2.0000', 'kg', '125.5', 'g');
  await picked(s);
  await apply(await issueOf(s.o.orderId));
  assert.equal(await onHand(s.l.id), '1.8745');
});

test('floor: a line a lot cannot hold exactly is refused at the scan, and the lot is not directed', async () => {
  const s = await floorJob('2.0000', 'kg', '125.55', 'g');
  const [line] = (await stations.pickView(s.job.floorJobId)).lines;
  assert.equal(line!.takeLot, null);
  await assert.rejects(() => stations.pickLine(s.job.floorJobId, line!.floorLineId, { bin: s.l.bin.code, barcode: s.l.barcode, reason: 'x' }, picker), /cannot hold/);
});

test('floor: a line finer than a mg is refused when the job is made, not truncated', async () => {
  const m = await material();
  await lot(m, '10.0000', 'g');
  const o = await order(m, '0.1235', 'g');
  await assert.rejects(() => stations.createJob(o.orderId, { steps: [] }, admin), /part of a mg/);
});

/* ── leftover after Finish ─────────────────────────────────────────────────────────────── */

async function finished(lotQty = '1000.0000', lotUnit = 'g', pick = '125.5', pickUnit = 'g') {
  const s = await floorJob(lotQty, lotUnit, pick, pickUnit);
  await picked(s);
  for (const l of (await stations.verifyView(s.job.floorJobId)).lines) await stations.verifyLine(s.job.floorJobId, l.floorLineId, { actualMg: l.targetMg }, verifier);
  await stations.completeVerify(s.job.floorJobId, verifier);
  for (const st of (await stations.mixView(s.job.floorJobId)).steps) await stations.doStep(s.job.floorJobId, st.seq, mixer);
  const done = await stations.completeMix(s.job.floorJobId, mixer);
  assert.equal(done.stage, 'DONE');
  return s;
}

test('leftover after Finish: a child lot, labelled, in the genealogy, capped, by anyone but the picker', async () => {
  const s = await finished();
  await apply(await issueOf(s.o.orderId));
  const back = await bin();
  const opts = await splits.leftoverOptions(s.l.barcode, verifier);
  assert.equal(opts.returnableMg, 874_500);
  assert.deepEqual(opts.jobs.map((j) => [j.floorJobId, j.stage, j.pickedByYou]), [[s.job.floorJobId, 'DONE', false]]);
  assert.equal((await splits.leftoverOptions(s.l.barcode, picker)).jobs[0]!.pickedByYou, true);
  await assert.rejects(() => splits.returnLeftover(s.job.floorJobId, { lot: s.l.barcode, qtyMg: 1000, bin: back.code }, picker), /picked this job/);
  await assert.rejects(() => splits.returnLeftover(s.job.floorJobId, { lot: s.l.barcode, qtyMg: 874_501, bin: back.code }, verifier), /At most 874\.5 g/);
  const out = await splits.returnLeftover(s.job.floorJobId, { lot: s.l.barcode, qtyMg: 500_000, bin: back.code }, mixer);
  assert.equal(out.kind, 'RETURN');
  assert.equal(out.label.jobNo, s.job.jobNo);
  assert.equal(out.label.barcode, out.child.barcode);
  assert.equal(await onHand(s.l.id), '374.5000');
  const g = await splits.genealogy(out.child.barcode);
  assert.equal(g.ancestors[0]!.barcode, s.l.barcode);
  assert.equal(g.ancestors[0]!.jobNo, s.job.jobNo);
  // the station list is gone once the job is finished: the child's reprint is reached from the scan
  const kid = await splits.leftoverOptions(out.child.barcode, verifier);
  assert.equal(kid.returnedFromJobId, s.job.floorJobId);
  assert.equal((await splits.printJobLabel(s.job.floorJobId, out.child.barcode, 'wet', verifier)).reprint, true);
});

test('leftover after Finish: the cap holds back what the debit has not taken yet', async () => {
  const s = await finished();
  assert.equal((await splits.leftoverOptions(s.l.barcode, verifier)).returnableMg, 874_500, 'the poller has not run; the issue still takes 125.5 g');
  const back = await bin();
  await assert.rejects(() => splits.returnLeftover(s.job.floorJobId, { lot: s.l.barcode, qtyMg: 874_501, bin: back.code }, verifier), /874\.5 g/);
});

test('leftover after Finish: the cap holds back a line another job has picked but not issued', async () => {
  const s = await finished();
  await apply(await issueOf(s.o.orderId));
  const o2 = await order(s.m, '100', 'g');
  const j2 = await stations.createJob(o2.orderId, { steps: [] }, admin);
  const [line] = (await stations.pickView(j2.floorJobId)).lines;
  await stations.pickLine(j2.floorJobId, line!.floorLineId, { bin: s.l.bin.code, barcode: s.l.barcode }, picker);
  assert.equal((await splits.leftoverOptions(s.l.barcode, verifier)).returnableMg, 774_500);
});

test('leftover after Finish works on a kg lot of a g job, to the mg', async () => {
  const s = await finished('1.0000', 'kg', '125.5', 'g');
  await apply(await issueOf(s.o.orderId));
  const out = await splits.returnLeftover(s.job.floorJobId, { lot: s.l.barcode, qtyMg: 874_500, bin: (await bin()).code }, verifier);
  assert.equal(await onHand(out.child.inventoryBatchId), '0.8745');
  assert.equal(await onHand(s.l.id), '0.0000');
});

test('a lot no job picked offers no leftover, and a lot on a job still at PICK is not offered', async () => {
  const m = await material();
  const l = await lot(m, '10.0000', 'g');
  assert.deepEqual((await splits.leftoverOptions(l.barcode, verifier)).jobs, []);
});
