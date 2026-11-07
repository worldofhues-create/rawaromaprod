/**
 * STOCK2-1, STOCK2-2, STOCK2-4: what the stock ledger takes for a pick line. On a real Postgres.
 *
 *   STOCK2-1  the ledger ends on the verifier's weight: leftover under the pick stays on the lot, and
 *             a reading over the pick is held until a supervisor records why;
 *   STOCK2-2  the debit follows the pick line, so one material on two lines debits each line once;
 *   STOCK2-4  a refused debit is an open alert with a next action, and it closes when the debit runs.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSchema, testClient, productionDb, principal, closeTestClient } from '../../../test-support/db.js';
import { PickingService, MixingService, BatchService } from '@ra/cluster-production';
import type { VaultPort } from '../../../cluster-formula/src/vault-port.js';
import { ConsumptionService } from '../consumption/consumption.service.js';
import { FloorCodeService } from '../floor/floor-code.service.js';
import { FloorStationService } from '../floor/floor-station.service.js';
import { LotSplitService } from '../floor/lot-split.service.js';
import { openAlerts } from '../floor-ops/floor-alerts.js';

const vault: VaultPort = { async resolveManufacturingInstruction() { return null; }, async resolvePickList() { return null; } };
const sql = () => testClient();
let codes: FloorCodeService, stations: FloorStationService, splits: LotSplitService, consumption: ConsumptionService, picking: PickingService, mixing: MixingService;

const admin = principal({ roles: ['admin'], userId: '00000000-0000-7000-8000-00000000f001' });
const proc = principal({ roles: ['procurement'], userId: '00000000-0000-7000-8000-00000000f002', permissions: ['masterdata:material:reveal'] });
const picker = principal({ roles: ['picker'], userId: '00000000-0000-7000-8000-00000000f003', permissions: [] });
const verifier = principal({ roles: ['verifier'], userId: '00000000-0000-7000-8000-00000000f004', permissions: [] });
const mixer = principal({ roles: ['mixer'], userId: '00000000-0000-7000-8000-00000000f005', permissions: [] });
const supervisor = principal({ roles: ['production'], userId: '00000000-0000-7000-8000-00000000f006', permissions: [] });

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
const drain = () => (consumption as unknown as { drain(): Promise<void> }).drain();

async function uom(code: string): Promise<string> {
  await sql()`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values (${uid()}, ${code}, ${code}, 'ACTIVE') on conflict do nothing`;
  return (await sql()`select uom_id::text from platform.uom_master where uom_code = ${code}`)[0]!.uom_id as string;
}
async function material() {
  const t = tag();
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const fam = `s2_${t.toLowerCase()}`;
  await codes.setFamily({ familyCode: fam, familyName: `Family ${t}`, colourName: `Tone${letters}`, colourHex: '#8B5A2B' }, admin);
  const id = uid();
  await sql()`insert into masterdata.material (material_id, material_code, material_name, status) values (${id}, ${'M-' + t}, 'Vetiver oil', 'ACTIVE')`;
  await codes.assignCode(id, fam, proc);
  return id;
}
async function bin() {
  const id = uid(), code = `S2-${tag()}`;
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
async function addLine(pl: string, materialId: string, qty: string, unit: string | null) {
  const id = uid(), u = unit ? await uom(unit) : null;
  await sql()`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, uom_id, status, created_dt) values (${id}, ${pl}, ${materialId}, ${qty}, ${u}, 'ACTIVE', clock_timestamp())`;
  return id;
}
async function order(materialId: string, qty: string, unit: string | null) {
  const u = unit ? await uom(unit) : null;
  const orderId = uid(), pl = uid();
  await sql()`insert into production.production_order (production_order_id, order_qty, status) values (${orderId}, 1, 'INPROGRESS')`;
  await sql()`insert into production.material_pick_list (material_pick_list_id, production_order_id, status) values (${pl}, ${orderId}, 'ACTIVE')`;
  await sql()`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, uom_id, status) values (${uid()}, ${orderId}, ${materialId}, ${qty}, false, ${u}, 'ACTIVE')`;
  const line = await addLine(pl, materialId, qty, unit);
  return { orderId, pl, line };
}
const onHand = async (id: string) => (await sql()`select quantity_on_hand::text as q from inventory.inventory_batch where inventory_batch_id = ${id}`)[0]!.q as string;
const events = (issueId: string) => sql()`select event_type, event_qty::text as q, remarks from inventory.inventory_event_history where reference_document_id = ${issueId} order by event_dt, created_dt`;
const issueOf = async (orderId: string) => (await sql()`select material_issue_id::text as id from production.material_issue where production_order_id = ${orderId}`)[0]!.id as string;

async function floorJob(lotQty = '1000.0000', lotUnit = 'g', pickQty = '125.5', pickUnit = 'g') {
  const m = await material();
  const l = await lot(m, lotQty, lotUnit);
  const o = await order(m, pickQty, pickUnit);
  return { m, l, o, job: await stations.createJob(o.orderId, { steps: [] }, admin) };
}
async function picked(s: Awaited<ReturnType<typeof floorJob>>) {
  const [line] = (await stations.pickView(s.job.floorJobId)).lines;
  await stations.pickLine(s.job.floorJobId, line!.floorLineId, { bin: s.l.bin.code, barcode: s.l.barcode }, picker);
  await stations.completePick(s.job.floorJobId, { tote: `T-${tag()}` }, picker);
  return line!.floorLineId;
}
const reading = (s: { job: { floorJobId: string } }, lineId: string, actualMg: number) => stations.verifyLine(s.job.floorJobId, lineId, { actualMg, source: 'scale' }, verifier);

/* ── STOCK2-1: the ledger ends on the verified weight ─────────────────────────────────────── */

test('STOCK2-1 under the pick: the leftover stays on the lot and the ledger says so', async () => {
  const s = await floorJob();
  const line = await picked(s);
  const issue = await issueOf(s.o.orderId);
  await apply(issue);
  assert.equal(await onHand(s.l.id), '874.5000');
  const r = await reading(s, line, 125_200);
  assert.equal(r.verified, true);
  assert.equal(await onHand(s.l.id), '874.8000', '125.2 g went in the pot, so 125.2 g left the lot');
  const ev = await events(issue);
  assert.deepEqual(ev.map((e) => [e.event_type, e.q]), [['PRODUCTION_ISSUE', '125.5000'], ['PRODUCTION_ISSUE_ADJUST', '-0.3000']]);
  assert.match(String(ev[1]!.remarks), /stays on the lot/);
});

test('STOCK2-1 verified before the poller ran: the one debit takes the verified weight, no adjustment', async () => {
  const s = await floorJob();
  const line = await picked(s);
  await reading(s, line, 125_200);
  const issue = await issueOf(s.o.orderId);
  await apply(issue);
  assert.equal(await onHand(s.l.id), '874.8000');
  assert.deepEqual((await events(issue)).map((e) => [e.event_type, e.q]), [['PRODUCTION_ISSUE', '125.2000']]);
});

test('STOCK2-1 the true-up lands once: a second reading on the line is refused and moves nothing', async () => {
  const s = await floorJob();
  const line = await picked(s);
  await apply(await issueOf(s.o.orderId));
  await reading(s, line, 125_200);
  await assert.rejects(() => reading(s, line, 125_300), /already verified/);
  assert.equal(await onHand(s.l.id), '874.8000');
});

test('STOCK2-1 over the pick, inside tolerance: refused, the reading is held, the lot does not move', async () => {
  const s = await floorJob();
  const line = await picked(s);
  await apply(await issueOf(s.o.orderId));
  const r = await reading(s, line, 125_700);
  assert.equal(r.verified, false);
  assert.equal((r as { overPick?: boolean }).overPick, true);
  assert.match(String((r as { message?: string }).message), /supervisor/i);
  assert.equal(await onHand(s.l.id), '874.5000');
  const v = (await stations.verifyView(s.job.floorJobId)).lines[0]!;
  assert.equal(v.verified, false);
  assert.equal((v as { heldOverMg?: number | null }).heldOverMg, 125_700);
  assert.ok((await openAlerts(sql())).some((a) => a.kind === 'STOCK_OVER_PICK' && a.subjectId === line));
  await assert.rejects(() => stations.completeVerify(s.job.floorJobId, verifier), /not weighed/);
});

test('STOCK2-1 a supervisor records why: the reading stands, the ledger takes it, the reason is on file', async () => {
  const s = await floorJob();
  const line = await picked(s);
  const issue = await issueOf(s.o.orderId);
  await apply(issue);
  await reading(s, line, 125_700);
  await assert.rejects(() => stations.approveOverPick(line, { reason: '  ' }, supervisor), /why/i);
  await assert.rejects(() => stations.approveOverPick(line, { reason: 'x' }, picker), /picked/);
  await assert.rejects(() => stations.approveOverPick(line, { reason: 'x' }, verifier), /took this reading/);
  const out = await stations.approveOverPick(line, { reason: 'Drum neck dripped into the tote' }, supervisor);
  assert.equal(out.verified, true);
  assert.equal(await onHand(s.l.id), '874.3000');
  assert.deepEqual((await events(issue)).map((e) => [e.event_type, e.q]), [['PRODUCTION_ISSUE', '125.5000'], ['PRODUCTION_ISSUE_ADJUST', '0.2000']]);
  const [row] = await sql()`select actual_mg::text, verified_by, over_reason, over_by from production.floor_line where floor_line_id = ${line}`;
  assert.deepEqual([row!.actual_mg, row!.verified_by, row!.over_reason, row!.over_by], ['125700', verifier.userId, 'Drum neck dripped into the tote', supervisor.userId]);
  assert.ok(!(await openAlerts(sql())).some((a) => a.subjectId === line), 'the alert closes');
  assert.equal((await stations.completeVerify(s.job.floorJobId, verifier)).stage, 'MIX');
  for (const st of (await stations.mixView(s.job.floorJobId)).steps) await stations.doStep(s.job.floorJobId, st.seq, mixer);
  assert.equal((await stations.completeMix(s.job.floorJobId, mixer)).stage, 'DONE');
});

test('STOCK2-1 a re-weigh at or under the pick clears a held reading without a supervisor', async () => {
  const s = await floorJob();
  const line = await picked(s);
  await apply(await issueOf(s.o.orderId));
  await reading(s, line, 125_700);
  const r = await reading(s, line, 125_500);
  assert.equal(r.verified, true);
  assert.ok(!(await openAlerts(sql())).some((a) => a.subjectId === line));
  await assert.rejects(() => stations.approveOverPick(line, { reason: 'late' }, supervisor), /no reading/i);
});

test('STOCK2-1 a second reading over the pick replaces the figure the supervisor reads and approves', async () => {
  const s = await floorJob();
  const line = await picked(s);
  await apply(await issueOf(s.o.orderId));
  await reading(s, line, 125_700);
  await reading(s, line, 125_600);
  const open = (await openAlerts(sql())).filter((a) => a.subjectId === line);
  assert.equal(open.length, 1);
  assert.match(String(open[0]!.body), /125\.6 g against/);
  await stations.approveOverPick(line, { reason: 'Re-weighed' }, supervisor);
  assert.equal(await onHand(s.l.id), '874.4000');
});

test('STOCK2-1 outside tolerance stays refused, over or under, and a supervisor cannot wave it through', async () => {
  const s = await floorJob();
  const line = await picked(s);
  await apply(await issueOf(s.o.orderId));
  assert.equal((await reading(s, line, 130_000)).withinTolerance, false);
  assert.equal(await onHand(s.l.id), '874.5000');
  await assert.rejects(() => stations.approveOverPick(line, { reason: 'x' }, supervisor), /no reading/i);
});

test('STOCK2-1 a reading the lot cannot book exactly is refused, kept on file, and nothing moves', async () => {
  const s = await floorJob('1.0000', 'kg');
  const line = await picked(s);
  await apply(await issueOf(s.o.orderId));
  const r = await reading(s, line, 125_460);
  assert.equal(r.verified, false);
  assert.match(String((r as { message?: string }).message), /0\.1 g/);
  assert.equal(await onHand(s.l.id), '0.8745');
  const [w] = await sql()`select status, net_qty::text from production.weighing_record where production_order_id = ${s.o.orderId} order by created_dt desc limit 1`;
  assert.equal(w!.status, 'NOT_BOOKABLE');
  assert.equal((await reading(s, line, 125_400)).verified, true, 'a reading on the lot\'s step goes through');
  assert.equal(await onHand(s.l.id), '0.8746');
});

test('STOCK2-1 the leftover cap reads the verified weight, pending or debited', async () => {
  const s = await floorJob();
  const line = await picked(s);
  await reading(s, line, 125_200);
  assert.equal((await splits.leftoverOptions(s.l.barcode, verifier)).returnableMg, 874_800, 'the debit will take 125.2 g, not 125.5 g');
  await apply(await issueOf(s.o.orderId));
  assert.equal((await splits.leftoverOptions(s.l.barcode, verifier)).returnableMg, 874_800);
});

test('STOCK2-1 an abort after a true-up credits back the net of what left', async () => {
  const s = await floorJob();
  const line = await picked(s);
  await apply(await issueOf(s.o.orderId));
  await reading(s, line, 125_200);
  const [j] = await sql()`select mixing_session_id::text as id from production.floor_job where floor_job_id = ${s.job.floorJobId}`;
  await mixing.abortSession(j!.id as string, { reason: 'test' } as never, admin);
  assert.equal(await onHand(s.l.id), '1000.0000');
});

/* ── STOCK2-2: by pick line ───────────────────────────────────────────────────────────────── */

async function twoLines(a: string, b: string) {
  const m = await material();
  const l = await lot(m, '1000.0000', 'g');
  const o = await order(m, a, 'g');
  const second = await addLine(o.pl, m, b, 'g');
  return { m, l, o, second };
}

test('STOCK2-2 one material on two lines, one lot: each line debits its own quantity once', async () => {
  const t = await twoLines('100', '30');
  const out = await picking.issueMaterials({ productionOrderId: t.o.orderId, materialPickListId: t.o.pl, items: [
    { materialPickListItemId: t.o.line, inventoryBatchId: t.l.id }, { materialPickListItemId: t.second, inventoryBatchId: t.l.id }] } as never, admin);
  await apply((out as { issue: { materialIssueId: string } }).issue.materialIssueId);
  assert.equal(await onHand(t.l.id), '870.0000');
});

test('STOCK2-2 one material on two lines, two lots: each lot takes its own line', async () => {
  const t = await twoLines('100', '30');
  const l2 = await lot(t.m, '500.0000', 'g');
  const out = await picking.issueMaterials({ productionOrderId: t.o.orderId, materialPickListId: t.o.pl, items: [
    { materialPickListItemId: t.o.line, inventoryBatchId: t.l.id }, { materialPickListItemId: t.second, inventoryBatchId: l2.id }] } as never, admin);
  await apply((out as { issue: { materialIssueId: string } }).issue.materialIssueId);
  assert.equal(await onHand(t.l.id), '900.0000');
  assert.equal(await onHand(l2.id), '470.0000');
});

test('STOCK2-2 naming only the material is refused when two lines carry it', async () => {
  const t = await twoLines('100', '30');
  await assert.rejects(() => picking.issueMaterials({ productionOrderId: t.o.orderId, materialPickListId: t.o.pl, items: [{ materialId: t.m, inventoryBatchId: t.l.id }] } as never, admin), /2 lines/);
});

test('STOCK2-2 one line cannot be issued twice in one issue', async () => {
  const t = await twoLines('100', '30');
  await assert.rejects(() => picking.issueMaterials({ productionOrderId: t.o.orderId, materialPickListId: t.o.pl, items: [
    { materialPickListItemId: t.o.line, inventoryBatchId: t.l.id }, { materialPickListItemId: t.o.line, inventoryBatchId: t.l.id }] } as never, admin), /twice/);
});

test('STOCK2-2 an old issue with no line named: one matching line debits, two refuse rather than guess', async () => {
  const t = await twoLines('100', '30');
  const issueId = uid();
  await sql()`insert into production.material_issue (material_issue_id, production_order_id, material_pick_list_id, status) values (${issueId}, ${t.o.orderId}, ${t.o.pl}, 'ACTIVE')`;
  await sql()`insert into production.material_issue_item (material_issue_item_id, material_issue_id, material_id, inventory_batch_id, issued_qty, status) values (${uid()}, ${issueId}, ${t.m}, ${t.l.id}, true, 'ACTIVE')`;
  await apply(issueId);
  assert.equal(await onHand(t.l.id), '1000.0000');
  assert.match(String((await events(issueId))[0]!.remarks), /two lines|2 lines/i);
});

test('STOCK2-2 floor: two lines of one material on one lot debit and verify line by line', async () => {
  const t = await twoLines('100', '30');
  const job = await stations.createJob(t.o.orderId, { steps: [] }, admin);
  const lines = (await stations.pickView(job.floorJobId)).lines;
  for (const l of lines) await stations.pickLine(job.floorJobId, l.floorLineId, { bin: t.l.bin.code, barcode: t.l.barcode }, picker);
  await stations.completePick(job.floorJobId, { tote: `T-${tag()}` }, picker);
  assert.equal((await splits.leftoverOptions(t.l.barcode, verifier)).returnableMg, 870_000, 'the cap counts each line once');
  const issue = await issueOf(t.o.orderId);
  await apply(issue);
  assert.equal(await onHand(t.l.id), '870.0000');
  await stations.verifyLine(job.floorJobId, lines[1]!.floorLineId, { actualMg: 29_900 }, verifier);
  assert.equal(await onHand(t.l.id), '870.1000', 'only line 2 moved');
});

test('STOCK2-2 floor: a lot cannot be picked past what it holds across two lines of one job', async () => {
  const m = await material();
  const l = await lot(m, '100.0000', 'g');
  const o = await order(m, '60', 'g');
  await addLine(o.pl, m, '60', 'g');
  const job = await stations.createJob(o.orderId, { steps: [] }, admin);
  const lines = (await stations.pickView(job.floorJobId)).lines;
  await stations.pickLine(job.floorJobId, lines[0]!.floorLineId, { bin: l.bin.code, barcode: l.barcode }, picker);
  assert.equal((await stations.pickView(job.floorJobId)).lines[1]!.takeLot, null);
  await assert.rejects(() => stations.pickLine(job.floorJobId, lines[1]!.floorLineId, { bin: l.bin.code, barcode: l.barcode }, picker), /does not hold enough/);
});

/* ── STOCK2-4: a refusal reaches a person ─────────────────────────────────────────────────── */

async function refused() {
  const m = await material();
  const l = await lot(m, '10.0000', 'kg');
  const o = await order(m, '2', 'litre');
  const issueId = uid();
  await sql()`insert into production.material_issue (material_issue_id, production_order_id, material_pick_list_id, status) values (${issueId}, ${o.orderId}, ${o.pl}, 'ACTIVE')`;
  await sql()`insert into production.material_issue_item (material_issue_item_id, material_issue_id, material_id, inventory_batch_id, issued_qty, status) values (${uid()}, ${issueId}, ${m}, ${l.id}, true, 'ACTIVE')`;
  return { m, l, o, issueId };
}
const alertFor = async (id: string) => (await openAlerts(sql())).filter((a) => a.kind === 'STOCK_DEBIT_REFUSED' && a.subjectId === id);

test('STOCK2-4 a refused debit opens one alert with the reason and the next action', async () => {
  const r = await refused();
  await apply(r.issueId);
  await apply(r.issueId);
  const a = await alertFor(r.issueId);
  assert.equal(a.length, 1);
  assert.match(a[0]!.title, /not been taken off stock/i);
  assert.match(String(a[0]!.body), /density/);
  assert.match(String(a[0]!.body), /Next:/);
  assert.doesNotMatch(`${a[0]!.title} ${a[0]!.body}`, /Vetiver/, 'alerts go to every station: never a material name');
});

test('STOCK2-4 the alert names the floor job when the issue has one', async () => {
  const s = await floorJob();
  await picked(s);
  const issue = await issueOf(s.o.orderId);
  await sql()`update production.material_pick_list_items set uom_id = ${await uom('litre')} where material_pick_list_id = ${s.o.pl}`;
  await apply(issue);
  assert.ok((await alertFor(issue))[0]!.title.includes(s.job.jobNo));
});

test('STOCK2-4 the alert closes once the unit is put right and the debit runs', async () => {
  const r = await refused();
  await apply(r.issueId);
  await sql()`update production.material_pick_list_items set uom_id = ${await uom('g')} where material_pick_list_id = ${r.o.pl}`;
  await apply(r.issueId);
  await drain();
  assert.equal(await onHand(r.l.id), '9.9980');
  assert.equal((await alertFor(r.issueId)).length, 0);
});

test('STOCK2-4 the alert closes when an abort voids the issue', async () => {
  const r = await refused();
  await apply(r.issueId);
  const s = await mixing.startSession({ productionOrderId: r.o.orderId } as never, admin);
  await mixing.abortSession((s as { secureMixingSessionId: string }).secureMixingSessionId, { reason: 'test' } as never, admin);
  await drain();
  assert.equal((await alertFor(r.issueId)).length, 0);
});
