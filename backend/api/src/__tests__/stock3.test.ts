/**
 * STOCK3-1, STOCK3-2, STOCK3-3, STOCK3-5: the limits STOCK2 left open. On a real Postgres.
 *
 *   STOCK3-1  a pick debit never takes a lot below zero: refused to the person issuing, and refused
 *             with an alert if the stock went between the issue and the debit;
 *   STOCK3-2  production_order_ingredients carries the real quantity issued, and issued_qty is true
 *             only when the line is covered, so a partial issue leaves the rest open;
 *   STOCK3-3  a station's TV shows its own alerts and the general floor alerts, nobody else's;
 *   STOCK3-5  Ruh says which materials it cannot total, instead of leaving them out.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSchema, testClient, productionDb, principal, closeTestClient, bridgeDb } from '../../../test-support/db.js';
import { signedTyped } from '../../../test-support/typed-check-fixtures.js';
import { PickingService, MixingService, BatchService, ProduceQueueService } from '@ra/cluster-production';
import type { VaultPort } from '../../../cluster-formula/src/vault-port.js';
import { ConsumptionService } from '../consumption/consumption.service.js';
import { FactsService } from '../facts/facts.service.js';
import { FloorCodeService } from '../floor/floor-code.service.js';
import { FloorStationService } from '../floor/floor-station.service.js';
import { DisplayService } from '../floor-ops/display.service.js';
import { openAlerts, raiseAlert } from '../floor-ops/floor-alerts.js';
import { detectMaterials } from '../ruh/ruh-detectors.js';
import { RuhFactsService } from '../ruh/ruh-facts.service.js';
import { RUH_DEFAULTS } from '../ruh/ruh-settings.service.js';

const vault: VaultPort = { async resolveManufacturingInstruction() { return null; }, async resolvePickList() { return null; } };
const sql = () => testClient();
let codes: FloorCodeService, stations: FloorStationService, consumption: ConsumptionService, picking: PickingService, mixing: MixingService;

const admin = principal({ roles: ['admin'], userId: '00000000-0000-7000-8000-00000000f301' });
const proc = principal({ roles: ['procurement'], userId: '00000000-0000-7000-8000-00000000f302', permissions: ['masterdata:material:reveal'] });
const picker = principal({ roles: ['picker'], userId: '00000000-0000-7000-8000-00000000f303', permissions: [] });
const verifier = principal({ roles: ['verifier'], userId: '00000000-0000-7000-8000-00000000f304', permissions: [] });

before(async () => {
  await ensureSchema();
  const db = productionDb();
  codes = new FloorCodeService(sql());
  picking = new PickingService(db, vault);
  mixing = new MixingService(db);
  stations = new FloorStationService(sql(), codes, picking, mixing, new BatchService(db));
  consumption = new ConsumptionService(sql() as never);
});
after(closeTestClient);

const uid = () => crypto.randomUUID();
const tag = () => uid().slice(0, 6).toUpperCase();
const apply = (id: string) => (consumption as unknown as { applyIssue(i: string): Promise<void> }).applyIssue(id);
const drain = () => (consumption as unknown as { drain(): Promise<void> }).drain();

async function uom(code: string): Promise<string> {
  await sql()`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values (${uid()}, ${code}, ${code}, 'ACTIVE') on conflict do nothing`;
  return (await sql()`select uom_id::text from platform.uom_master where uom_code = ${code}`)[0]!.uom_id as string;
}
async function material() {
  const t = tag();
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const fam = `s3_${t.toLowerCase()}`;
  await codes.setFamily({ familyCode: fam, familyName: `Family ${t}`, colourName: `Tone${letters}`, colourHex: '#8B5A2B' }, admin);
  const id = uid();
  await sql()`insert into masterdata.material (material_id, material_code, material_name, status) values (${id}, ${'M-' + t}, 'Vetiver oil', 'ACTIVE')`;
  await codes.assignCode(id, fam, proc);
  return id;
}
async function lot(materialId: string, qty: string, unit: string | null) {
  const u = unit ? await uom(unit) : null;
  const rb = uid(), ib = uid(), bin = uid(), code = `S3-${tag()}`, number = `RM-${tag()}`;
  await sql()`insert into location.bin_master (bin_id, bin_code, status) values (${bin}, ${code}, 'ACTIVE')`;
  await sql()`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status, created_dt) values (${rb}, ${materialId}, ${number}, '2099-03-01', 'ACTIVE', now())`;
  await sql()`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values (${uid()}, ${rb}, 'ACCEPT')`;
  await sql()`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status) values (${ib}, ${rb}, ${materialId}, ${bin}, ${qty}, ${u}, 'ACTIVE')`;
  return { id: ib, number, bin: code, barcode: await codes.lotBarcode(ib, null) };
}
async function addLine(pl: string, materialId: string, qty: string, unit: string | null) {
  const id = uid(), u = unit ? await uom(unit) : null;
  await sql()`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, uom_id, status, created_dt) values (${id}, ${pl}, ${materialId}, ${qty}, ${u}, 'ACTIVE', clock_timestamp())`;
  return id;
}
async function addIngredient(orderId: string, materialId: string, qty: string, unit: string | null) {
  const u = unit ? await uom(unit) : null;
  await sql()`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, uom_id, status) values (${uid()}, ${orderId}, ${materialId}, ${qty}, false, ${u}, 'ACTIVE')`;
}
/** An order needing `need`, with one pick line for `pick`. */
async function order(materialId: string, need: string, pick = need, unit: string | null = 'g') {
  const orderId = uid(), pl = uid();
  await sql()`insert into production.production_order (production_order_id, order_qty, status) values (${orderId}, 1, 'INPROGRESS')`;
  await sql()`insert into production.material_pick_list (material_pick_list_id, production_order_id, status) values (${pl}, ${orderId}, 'ACTIVE')`;
  await addIngredient(orderId, materialId, need, unit);
  return { orderId, pl, line: await addLine(pl, materialId, pick, unit) };
}
const issue = (o: { orderId: string; pl: string }, items: Array<{ materialPickListItemId: string; inventoryBatchId: string }>) =>
  picking.issueMaterials({ productionOrderId: o.orderId, materialPickListId: o.pl, items } as never, admin);
const onHand = async (id: string) => (await sql()`select quantity_on_hand::text as q from inventory.inventory_batch where inventory_batch_id = ${id}`)[0]!.q as string;
const setLot = (id: string, qty: string) => sql()`update inventory.inventory_batch set quantity_on_hand = ${qty} where inventory_batch_id = ${id}`;
const claimed = async (id: string) => (await sql()`select 1 from inventory.material_issue_applied where material_issue_id = ${id}`).length === 1;
const events = (id: string) => sql()`select event_type, remarks from inventory.inventory_event_history where reference_document_id = ${id}`;
const debitAlerts = async (id: string) => (await openAlerts(sql() as never)).filter((a) => a.kind === 'STOCK_DEBIT_REFUSED' && a.subjectId === id);
const ingredients = (orderId: string) => sql()`select required_qty::text as need, issued_qty, issued_amount::float as amount from production.production_order_ingredients where production_order_id = ${orderId} order by required_qty desc`;

/* ── STOCK3-1: a pick debit never takes a lot below zero ──────────────────────────────────── */

test('STOCK3-1 the stock went before the debit: refused whole, the lot stands, an alert says what to do', async () => {
  const m = await material();
  const l = await lot(m, '200.0000', 'g');
  const o = await order(m, '125.5');
  const { issue: i } = await issue(o, [{ materialPickListItemId: o.line, inventoryBatchId: l.id }]);
  await setLot(l.id, '50.0000');
  await apply(i.materialIssueId);
  assert.equal(await onHand(l.id), '50.0000', 'the lot must never read below what it holds');
  assert.equal(await claimed(i.materialIssueId), false, 'left open, so it can still debit');
  assert.deepEqual((await events(i.materialIssueId)).map((e) => e.event_type), ['PRODUCTION_ISSUE_REFUSED']);
  const [a] = await debitAlerts(i.materialIssueId);
  assert.ok(a, 'a person has to hear about it');
  assert.match(String(a.body), new RegExp(`${l.number} holds 50\\.0000 g`));
  assert.match(String(a.body), /takes 125\.5000 g/);
  assert.match(String(a.body), /Next: count the lot/);
  assert.doesNotMatch(String(a.body), /corrects the unit/, 'the units are fine here: that advice sends someone the wrong way');
});

test('STOCK3-1 the count is put right: the debit runs by itself and the alert closes', async () => {
  const m = await material();
  const l = await lot(m, '200.0000', 'g');
  const o = await order(m, '125.5');
  const { issue: i } = await issue(o, [{ materialPickListItemId: o.line, inventoryBatchId: l.id }]);
  await setLot(l.id, '50.0000');
  await apply(i.materialIssueId);
  await setLot(l.id, '130.0000');
  await apply(i.materialIssueId);
  assert.equal(await onHand(l.id), '4.5000');
  await drain();
  assert.equal((await debitAlerts(i.materialIssueId)).length, 0);
});

test('STOCK3-1 one short lot refuses the whole issue: no line of it is debited', async () => {
  const m = await material(), n = await material();
  const a = await lot(m, '200.0000', 'g'), b = await lot(n, '200.0000', 'g');
  const o = await order(m, '100');
  await addIngredient(o.orderId, n, '100', 'g');
  const second = await addLine(o.pl, n, '100', 'g');
  const { issue: i } = await issue(o, [{ materialPickListItemId: o.line, inventoryBatchId: a.id }, { materialPickListItemId: second, inventoryBatchId: b.id }]);
  await setLot(b.id, '99.9999');
  await apply(i.materialIssueId);
  assert.deepEqual([await onHand(a.id), await onHand(b.id)], ['200.0000', '99.9999']);
});

test('STOCK3-1 a lot emptied to exactly zero is an ordinary debit', async () => {
  const m = await material();
  const l = await lot(m, '100.0000', 'g');
  const o = await order(m, '100');
  const { issue: i } = await issue(o, [{ materialPickListItemId: o.line, inventoryBatchId: l.id }]);
  await apply(i.materialIssueId);
  assert.equal(await onHand(l.id), '0.0000');
  assert.equal((await debitAlerts(i.materialIssueId)).length, 0);
});

test('STOCK3-1 the verified weight is what the guard reads', async () => {
  const m = await material();
  const l = await lot(m, '1000.0000', 'g');
  const o = await order(m, '125.5');
  const job = await stations.createJob(o.orderId, { steps: [] }, admin);
  const [line] = (await stations.pickView(job.floorJobId)).lines;
  await stations.pickLine(job.floorJobId, line!.floorLineId, { bin: l.bin, barcode: l.barcode }, picker);
  await stations.completePick(job.floorJobId, { tote: `T-${tag()}` }, picker);
  await stations.verifyLine(job.floorJobId, line!.floorLineId, { actualMg: 125_200, ...(await signedTyped(125_200, verifier)) }, verifier);
  await setLot(l.id, '125.2000'); // the pick figure would not fit; the weight that actually left does
  const i = (await sql()`select material_issue_id::text as id from production.material_issue where production_order_id = ${o.orderId}`)[0]!.id as string;
  await apply(i);
  assert.equal(await onHand(l.id), '0.0000');
});

test('STOCK3-1 issuing more than the lot holds is refused to the person, in the lot\'s unit, and nothing is raised', async () => {
  const m = await material();
  const l = await lot(m, '0.1000', 'kg');
  const o = await order(m, '125.5');
  await assert.rejects(issue(o, [{ materialPickListItemId: o.line, inventoryBatchId: l.id }]), (e: Error) => {
    assert.match(e.message, new RegExp(`Lot ${l.number} holds 0\\.1000 kg`));
    assert.match(e.message, /0\.1255 kg/);
    return true;
  });
  assert.equal((await sql()`select 1 from production.material_issue where production_order_id = ${o.orderId}`).length, 0);
});

test('STOCK3-1 two lines off one lot are refused on what they take together', async () => {
  const m = await material();
  const l = await lot(m, '200.0000', 'g');
  const o = await order(m, '120');
  await addIngredient(o.orderId, m, '120', 'g');
  const second = await addLine(o.pl, m, '120', 'g');
  await assert.rejects(issue(o, [{ materialPickListItemId: o.line, inventoryBatchId: l.id }, { materialPickListItemId: second, inventoryBatchId: l.id }]), /holds 200\.0000 g/);
});

/* ── STOCK3-2: the order carries the quantity that really went ────────────────────────────── */

test('STOCK3-2 a partial issue records the quantity and leaves the material open', async () => {
  const m = await material();
  const l = await lot(m, '500.0000', 'g');
  const o = await order(m, '100', '40');
  await issue(o, [{ materialPickListItemId: o.line, inventoryBatchId: l.id }]);
  const [r] = await ingredients(o.orderId);
  assert.equal(r!.issued_qty, false, '40 of 100 is not issued');
  assert.equal(r!.amount, 40);
});

test('STOCK3-2 the second issue completes it', async () => {
  const m = await material();
  const l = await lot(m, '500.0000', 'g');
  const o = await order(m, '100', '40');
  await issue(o, [{ materialPickListItemId: o.line, inventoryBatchId: l.id }]);
  const rest = await addLine(o.pl, m, '60', 'g');
  await issue(o, [{ materialPickListItemId: rest, inventoryBatchId: l.id }]);
  const [r] = await ingredients(o.orderId);
  assert.deepEqual([r!.issued_qty, r!.amount], [true, 100]);
});

test('STOCK3-2 quantities add across units: 0.04 kg on a line in g is 40 g', async () => {
  const m = await material();
  const l = await lot(m, '500.0000', 'g');
  const o = await order(m, '100', '0.04');
  await sql()`update production.material_pick_list_items set uom_id = ${await uom('kg')} where material_pick_list_item_id = ${o.line}`;
  await issue(o, [{ materialPickListItemId: o.line, inventoryBatchId: l.id }]);
  const [r] = await ingredients(o.orderId);
  assert.deepEqual([r!.issued_qty, r!.amount], [false, 40]);
});

test('STOCK3-2 one material on two ingredient rows: the first is filled before the second, not both flipped', async () => {
  const m = await material();
  const l = await lot(m, '500.0000', 'g');
  const o = await order(m, '100', '120');
  await addIngredient(o.orderId, m, '50', 'g');
  await issue(o, [{ materialPickListItemId: o.line, inventoryBatchId: l.id }]);
  const rows = await ingredients(o.orderId);
  assert.deepEqual(rows.map((r) => [r.need, r.issued_qty, r.amount]), [['100.0000', true, 100], ['50.0000', false, 20]]);
});

test('STOCK3-2 the verified weight is the real quantity; a reading in tolerance still closes the line', async () => {
  const m = await material();
  const l = await lot(m, '1000.0000', 'g');
  const o = await order(m, '125.5');
  const job = await stations.createJob(o.orderId, { steps: [] }, admin);
  const [line] = (await stations.pickView(job.floorJobId)).lines;
  await stations.pickLine(job.floorJobId, line!.floorLineId, { bin: l.bin, barcode: l.barcode }, picker);
  await stations.completePick(job.floorJobId, { tote: `T-${tag()}` }, picker);
  assert.equal((await ingredients(o.orderId))[0]!.amount, 125.5);
  await stations.verifyLine(job.floorJobId, line!.floorLineId, { actualMg: 125_200, ...(await signedTyped(125_200, verifier)) }, verifier);
  const [r] = await ingredients(o.orderId);
  assert.deepEqual([r!.issued_qty, r!.amount], [true, 125.2]);
});

test('STOCK3-2 an abort takes the quantity back to nothing', async () => {
  const m = await material();
  const l = await lot(m, '500.0000', 'g');
  const o = await order(m, '100');
  await issue(o, [{ materialPickListItemId: o.line, inventoryBatchId: l.id }]);
  const s = await mixing.startSession({ productionOrderId: o.orderId } as never, admin) as { secureMixingSessionId: string };
  await mixing.abortSession(s.secureMixingSessionId, { reason: 'spilled' } as never, admin);
  const [r] = await ingredients(o.orderId);
  assert.deepEqual([r!.issued_qty, r!.amount], [false, 0]);
});

test('STOCK3-2 the shelf check counts only what is still to issue', async () => {
  const m = await material();
  const l = await lot(m, '70.0000', 'g'); // 70 on the shelf, 100 needed, 40 of it already gone: 60 left to find
  const o = await order(m, '100', '40');
  await issue(o, [{ materialPickListItemId: o.line, inventoryBatchId: l.id }]);
  const where = await (new FactsService(sql() as never, bridgeDb()) as unknown as { unissuedMaterialWhereabouts(id: string): Promise<{ summary: string }> }).unissuedMaterialWhereabouts(o.orderId);
  assert.match(where.summary, /1 line\(s\) in stock/);
});

test('STOCK3-2 Ruh plans for what is still to issue, not the whole line', async () => {
  const m = await material();
  const l = await lot(m, '70.0000', 'g');
  const o = await order(m, '100', '40');
  await issue(o, [{ materialPickListItemId: o.line, inventoryBatchId: l.id }]);
  const facts = new RuhFactsService(sql() as never, {} as never, new ProduceQueueService(productionDb()));
  const f = (await facts.materials(RUH_DEFAULTS)).stock.find((x) => x.materialId === m)!;
  assert.equal(f.shortForPlannedRuns, false);
});

/* ── STOCK3-3: a station's screens carry its own alerts and the floor's ───────────────────── */

test('STOCK3-3 a named station reads its own alerts and the general floor alerts, not another station\'s', async () => {
  const t = tag(), here = `Verify ${t}`, there = `Pack ${t}`;
  const raise = (station: string | null, key: string) => raiseAlert(sql() as never, { kind: 'TEST', station, subjectType: null, subjectId: null, title: key, dedupeKey: key }, new Date());
  await raise(here, `own-${t}`);
  await raise('Floor', `floor-${t}`);
  await raise(null, `all-${t}`);
  await raise(there, `other-${t}`);
  const seen = (await openAlerts(sql() as never, here)).map((a) => a.title);
  assert.ok(seen.includes(`own-${t}`));
  assert.ok(seen.includes(`floor-${t}`), 'a stock alert is raised at Floor and has to reach a named station');
  assert.ok(seen.includes(`all-${t}`));
  assert.ok(!seen.includes(`other-${t}`));
  const board = await new DisplayService(sql() as never, { runs: async () => [] } as never).feed(here);
  assert.ok(board.alerts.some((a) => a.title === `floor-${t}`), 'the paired TV reads the same feed');
});

/* ── STOCK3-5: Ruh says what it could not total ───────────────────────────────────────────── */

test('STOCK3-5 a material in kg and L is named as not totalled, not left out', async () => {
  const m = await material();
  await lot(m, '1.0000', 'kg');
  await lot(m, '1.0000', 'L');
  const o = await order(m, '100');
  void o;
  const facts = new RuhFactsService(sql() as never, {} as never, new ProduceQueueService(productionDb()));
  const f = await facts.materials(RUH_DEFAULTS);
  assert.ok(!f.stock.some((x) => x.materialId === m), 'still no figure for it');
  const n = f.notTotalled.find((x) => x.materialId === m)!;
  assert.ok(n, 'but it is on the list');
  assert.match(n.reason, /kg and L/);
});

test('STOCK3-5 the insight says it cannot total the material and why, with no figure', () => {
  const drafts = detectMaterials({
    noFloorCode: { count: 0, sample: [] }, stock: [],
    notTotalled: [{ materialId: 'm1', code: 'M-1', name: 'Vetiver oil', reason: 'Held in kg and L, which do not add.' }],
  }, RUH_DEFAULTS, new Date());
  assert.equal(drafts.length, 1);
  const d = drafts[0]!;
  assert.equal(d.kind, 'inventory.not_totalled');
  assert.match(d.title, /M-1: stock cannot be totalled/);
  assert.match(d.body, /kg and L/);
  assert.match(d.body, /no run-out warning/i);
  assert.equal(d.prediction, null);
  assert.equal(d.dedupeKey, 'inventory.not_totalled:m1');
});
