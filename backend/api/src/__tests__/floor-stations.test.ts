/**
 * PROD-A-4/5 — floor codes, lot barcodes, scan-resolve and the Picker -> Verifier -> Mixer
 * checklists on a real Postgres (production-floor plan §3, §5, §6, §12.2, §12.5). The stations run
 * the EXISTING flow underneath: material issue, mixing session, weighing records, oil batch.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSchema, testClient, productionDb, principal, closeTestClient } from '../../../test-support/db.js';
import { PickingService, MixingService, BatchService } from '@ra/cluster-production';
import type { VaultPort } from '../../../cluster-formula/src/vault-port.js';
import { FloorCodeService, HAZARD_PENDING, qtyToMg } from '../floor/floor-code.service.js';
import { FloorStationService, withinToleranceMg, toleranceMg } from '../floor/floor-station.service.js';

const vault: VaultPort = { async resolveManufacturingInstruction() { return null; }, async resolvePickList() { return null; } };
let codes: FloorCodeService;
let stations: FloorStationService;
const sql = () => testClient();

const admin = principal({ roles: ['admin'], userId: '00000000-0000-7000-8000-00000000a001' });
const proc = principal({ roles: ['procurement'], userId: '00000000-0000-7000-8000-00000000a002', permissions: ['masterdata:material:reveal'] });
const picker = principal({ roles: ['picker'], userId: '00000000-0000-7000-8000-00000000a003', permissions: [] });
const verifier = principal({ roles: ['verifier'], userId: '00000000-0000-7000-8000-00000000a004', permissions: [] });
const mixer = principal({ roles: ['mixer'], userId: '00000000-0000-7000-8000-00000000a005', permissions: [] });

before(async () => {
  await ensureSchema();
  codes = new FloorCodeService(sql());
  const db = productionDb();
  stations = new FloorStationService(sql(), codes, new PickingService(db, vault), new MixingService(db), new BatchService(db));
});
after(closeTestClient);

const uid = () => crypto.randomUUID();
const tag = () => uid().slice(0, 6).toUpperCase();

async function gramUom(): Promise<string> {
  await sql()`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values (${uid()}, 'g', 'gram', 'ACTIVE') on conflict do nothing`;
  const [r] = await sql()`select uom_id::text from platform.uom_master where uom_code = 'g'`;
  return r!.uom_id as string;
}

/** A family with its own colour per call (colours are unique). */
async function family(): Promise<string> {
  const t = tag();
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const code = `fam_${t.toLowerCase()}`;
  await codes.setFamily({ familyCode: code, familyName: `Family ${t}`, colourName: `Tone${letters}`, colourHex: '#E8C547' }, admin);
  return code;
}

async function material(fam: string) {
  const id = uid();
  await sql()`insert into masterdata.material (material_id, material_code, material_name, status) values (${id}, ${'M-' + tag()}, 'Bergamot oil', 'ACTIVE')`;
  const fc = await codes.assignCode(id, fam, proc);
  return { id, code: fc.code };
}

let binSeq = 0;
async function bin(): Promise<{ id: string; code: string }> {
  const id = uid();
  const code = `PF-A-${tag()}-${++binSeq}`;
  await sql()`insert into location.bin_master (bin_id, bin_code, status) values (${id}, ${code}, 'ACTIVE')`;
  return { id, code };
}

/** A lot of `materialId` holding `grams`, QC `result`, expiring `expiry`. */
async function lot(materialId: string, grams: number, opts: { result?: string; expiry?: string | null; received?: string } = {}) {
  const g = await gramUom();
  const rb = uid(), ib = uid(), b = await bin();
  const batchNo = `RM-${tag()}`;
  await sql()`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status, created_dt)
    values (${rb}, ${materialId}, ${batchNo}, ${opts.expiry === undefined ? '2099-01-01' : opts.expiry}, 'ACTIVE', ${opts.received ?? new Date().toISOString()})`;
  if (opts.result !== 'NONE') await sql()`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values (${uid()}, ${rb}, ${opts.result ?? 'ACCEPT'})`;
  await sql()`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status)
    values (${ib}, ${rb}, ${materialId}, ${b.id}, ${grams}, ${g}, 'ACTIVE')`;
  const barcode = await codes.lotBarcode(ib, null);
  return { inventoryBatchId: ib, barcode, bin: b.code, batchNo };
}

/** A production order with a pick list of (material, grams) lines, like generatePickList writes. */
async function order(lines: Array<{ materialId: string; grams: number }>) {
  const g = await gramUom();
  const orderId = uid(), pl = uid();
  await sql()`insert into production.production_order (production_order_id, order_qty, uom_id, status) values (${orderId}, 1, ${g}, 'INPROGRESS')`;
  await sql()`insert into production.material_pick_list (material_pick_list_id, production_order_id, status) values (${pl}, ${orderId}, 'ACTIVE')`;
  for (const l of lines) {
    await sql()`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, uom_id, status)
      values (${uid()}, ${orderId}, ${l.materialId}, ${l.grams}, false, ${g}, 'ACTIVE')`;
    await sql()`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, uom_id, status, created_dt)
      values (${uid()}, ${pl}, ${l.materialId}, ${l.grams}, ${g}, 'ACTIVE', clock_timestamp())`;
  }
  return orderId;
}

/* ── units ─────────────────────────────────────────────────────────────────────────────── */

test('mg arithmetic is exact: units, tolerance on the stored value, window never wider than the check', () => {
  assert.equal(qtyToMg('125.5000', 'g'), 125500);
  assert.equal(qtyToMg('1.2500', 'kg'), 1250000);
  assert.equal(qtyToMg('3', 'litre'), null);
  assert.equal(withinToleranceMg(126750, 125500, 10000), true); // +1.25 g on 125.5 g at 1 %
  assert.equal(withinToleranceMg(126756, 125500, 10000), false);
  assert.equal(toleranceMg(125500, 10000), 1255);
});

/* ── colours, codes, barcodes, scan ───────────────────────────────────────────────────── */

test('family colours: a hex and a plain colour name; a printed colour cannot be changed', async () => {
  const fam = await family();
  await assert.rejects(() => codes.setFamily({ familyCode: 'x', familyName: 'X', colourName: 'Yel-low', colourHex: '#E8C547' }, admin), /plain name/);
  await assert.rejects(() => codes.setFamily({ familyCode: 'x', familyName: 'X', colourName: 'Teal', colourHex: 'teal' }, admin), /hex/);
  const m = await material(fam);
  const [f] = await sql()`select colour_name from masterdata.floor_family_colour where family_code = ${fam}`;
  await assert.rejects(() => codes.setFamily({ familyCode: fam, familyName: 'Renamed', colourName: 'Purple', colourHex: '#800080' }, admin), /already printed/);
  // the name can change, the colour cannot
  await codes.setFamily({ familyCode: fam, familyName: 'Renamed', colourName: f!.colour_name as string, colourHex: '#E8C547' }, admin);
  assert.ok(m.code.startsWith(String(f!.colour_name).toUpperCase() + '-'));
});

test('floor code: colour + a random number in the family; idempotent; never re-issued under another family', async () => {
  const fam = await family();
  const draws = [4242, 4242, 17];
  codes.drawNumber = () => draws.shift() ?? 99;
  try {
    const a = await material(fam);
    const b = await material(fam);
    assert.match(a.code, /-4242$/);
    assert.match(b.code, /-0017$/); // the collision on 4242 drew again
    const again = await codes.assignCode(a.id, fam, proc);
    assert.equal(again.code, a.code);
    const other = await family();
    await assert.rejects(() => codes.assignCode(a.id, other, proc), /never re-issued/);
  } finally {
    codes.drawNumber = new FloorCodeService(sql()).drawNumber;
  }
});

test('lot barcode is opaque (L- + 7 Crockford chars), minted once per lot', async () => {
  const fam = await family();
  const m = await material(fam);
  const l = await lot(m.id, 500);
  assert.match(l.barcode, /^L-[0-9A-HJKMNP-TV-Z]{7}$/);
  assert.equal(await codes.lotBarcode(l.inventoryBatchId, null), l.barcode);
  assert.ok(!l.barcode.includes(m.code) && !/bergamot/i.test(l.barcode));
});

test('scan-resolve: the floor sees code, colour, bin, lot, quantity, expiry, hazard pending; only reveal sees the material', async () => {
  const fam = await family();
  const m = await material(fam);
  const l = await lot(m.id, 250.5);
  const floor = await codes.resolve(l.barcode.toLowerCase(), picker);
  assert.equal(floor.floorCode, m.code);
  assert.equal(floor.bin, l.bin);
  assert.equal(floor.lot, l.batchNo);
  assert.equal(floor.quantityLeftMg, 250500);
  assert.equal(floor.hazard, HAZARD_PENDING);
  assert.equal(floor.pickable, true);
  assert.ok(floor.initial && floor.colourName);
  assert.equal(floor.materialId, undefined);
  assert.equal(floor.materialName, undefined);
  const revealed = await codes.resolve(l.barcode, proc);
  assert.equal(revealed.materialName, 'Bergamot oil');
  await assert.rejects(() => codes.resolve('BERGAMOT', picker), /not a lot label/);
  await assert.rejects(() => codes.resolve('L-ZZZZZZZ', picker), /not known/);
});

test('scan-resolve: a lot with no QC pass reads QUARANTINE and unpickable; an expired lot reads EXPIRED', async () => {
  const fam = await family();
  const m = await material(fam);
  const q = await codes.resolve((await lot(m.id, 100, { result: 'NONE' })).barcode, picker);
  assert.equal(q.status, 'QUARANTINE');
  assert.equal(q.pickable, false);
  const e = await codes.resolve((await lot(m.id, 100, { expiry: '2020-01-01' })).barcode, picker);
  assert.equal(e.status, 'EXPIRED');
  assert.equal(e.pickable, false);
});

/* ── the stations ─────────────────────────────────────────────────────────────────────── */

async function setup() {
  const fam = await family();
  const a = await material(fam), b = await material(fam);
  // a: two lots; the OLDER-expiring one is directed (FEFO), the other needs a reason.
  const aLate = await lot(a.id, 1000, { expiry: '2099-06-01' });
  const aSoon = await lot(a.id, 1000, { expiry: '2098-01-01' });
  const aSmall = await lot(a.id, 1, { expiry: '2097-01-01' }); // expires first but too small
  const bLot = await lot(b.id, 1000);
  const orderId = await order([{ materialId: a.id, grams: 125.5 }, { materialId: b.id, grams: 2.25 }]);
  const job = await stations.createJob(orderId, { steps: ['Stir 10 minutes'] }, admin);
  return { a, b, aLate, aSoon, aSmall, bLot, orderId, job };
}

test('job: refused without a pick list, without a floor code, twice for one order', async () => {
  const g = await gramUom();
  const o = uid();
  await sql()`insert into production.production_order (production_order_id, order_qty, uom_id, status) values (${o}, 1, ${g}, 'INPROGRESS')`;
  await assert.rejects(() => stations.createJob(o, {}, admin), /no pick list/);
  const uncoded = uid();
  await sql()`insert into masterdata.material (material_id, material_code, material_name) values (${uncoded}, ${'U-' + tag()}, 'x')`;
  const o2 = await order([{ materialId: uncoded, grams: 5 }]);
  await assert.rejects(() => stations.createJob(o2, {}, admin), /no floor code/);
  const s = await setup();
  await assert.rejects(() => stations.createJob(s.orderId, {}, admin), /already on the floor/);
});

test('picker: told the FEFO lot (skipping one too small), never shown grams', async () => {
  const s = await setup();
  const v = await stations.pickView(s.job.floorJobId);
  const l1 = v.lines[0]!;
  assert.equal(l1.takeLot!.barcode, s.aSoon.barcode);
  assert.equal(l1.takeLot!.bin, s.aSoon.bin);
  assert.ok(!JSON.stringify(v).match(/target|Mg"|125/), 'no grams reach the picker');
});

test('picker: wrong material, wrong bin, quarantined lot and off-FEFO without a reason are refused', async () => {
  const s = await setup();
  const [l1, l2] = (await stations.pickView(s.job.floorJobId)).lines;
  await assert.rejects(() => stations.pickLine(s.job.floorJobId, l1!.floorLineId, { bin: s.bLot.bin, barcode: s.bLot.barcode }, picker), /Wrong material/);
  await assert.rejects(() => stations.pickLine(s.job.floorJobId, l1!.floorLineId, { bin: 'NOPE', barcode: s.aSoon.barcode }, picker), /Wrong bin/);
  await assert.rejects(() => stations.pickLine(s.job.floorJobId, l1!.floorLineId, { bin: s.aLate.bin, barcode: s.aLate.barcode }, picker), /first \(it expires first/);
  const q = await lot(s.a.id, 1000, { result: 'REJECT' });
  await assert.rejects(() => stations.pickLine(s.job.floorJobId, l1!.floorLineId, { bin: q.bin, barcode: q.barcode }, picker), /cannot be picked/);
  await assert.rejects(() => stations.pickLine(s.job.floorJobId, l1!.floorLineId, { bin: s.aSmall.bin, barcode: s.aSmall.barcode }, picker), /does not hold enough/);
  // with a reason the off-FEFO lot is taken and the reason kept
  const r = await stations.pickLine(s.job.floorJobId, l1!.floorLineId, { bin: s.aLate.bin, barcode: s.aLate.barcode, reason: 'drum seal broken' }, picker);
  assert.equal(r.offFefo, true);
  await assert.rejects(() => stations.completePick(s.job.floorJobId, { tote: 'T-1' }, picker), /still open: 2/);
  await stations.pickLine(s.job.floorJobId, l2!.floorLineId, { bin: s.bLot.bin, barcode: s.bLot.barcode }, picker);
});

async function picked(s: Awaited<ReturnType<typeof setup>>, tote = `T-${tag()}`) {
  const [l1, l2] = (await stations.pickView(s.job.floorJobId)).lines;
  await stations.pickLine(s.job.floorJobId, l1!.floorLineId, { bin: s.aSoon.bin, barcode: s.aSoon.barcode }, picker);
  await stations.pickLine(s.job.floorJobId, l2!.floorLineId, { bin: s.bLot.bin, barcode: s.bLot.barcode }, picker);
  return stations.completePick(s.job.floorJobId, { tote }, picker);
}

test('pick complete: PICKED label, the ordinary material issue from the scanned lots, then the verifier\'s turn', async () => {
  const s = await setup();
  const tote = `T-${tag()}`;
  const done = await picked(s, tote);
  assert.equal(done.stage, 'VERIFY');
  assert.equal(done.label.kind, 'PICKED');
  assert.equal(done.label.tote, tote);
  assert.equal(done.label.reprint, false);
  const items = await sql()`select ii.inventory_batch_id::text from production.material_issue i join production.material_issue_item ii on ii.material_issue_id = i.material_issue_id
    where i.production_order_id = ${s.orderId}`;
  assert.deepEqual(items.map((r) => r.inventory_batch_id).sort(), [s.aSoon.inventoryBatchId, s.bLot.inventoryBatchId].sort());
  assert.deepEqual(await stations.findJob(tote), { floorJobId: s.job.floorJobId, jobNo: s.job.jobNo, stage: 'VERIFY' });
});

test('verifier: cannot verify own pick; out-of-tolerance kept on file and refused; exact-mg check; order of stations', async () => {
  const s = await setup();
  await assert.rejects(() => stations.verifyLine(s.job.floorJobId, uid(), { actualMg: 1 }, verifier), /not ready to verify/);
  await picked(s);
  const v = await stations.verifyView(s.job.floorJobId);
  const [l1, l2] = v.lines;
  assert.equal(l1!.targetMg, 125500);
  assert.equal(l1!.toleranceMg, 1255);
  await assert.rejects(() => stations.verifyLine(s.job.floorJobId, l1!.floorLineId, { actualMg: 125500 }, picker), /picked this job/);
  const out = await stations.verifyLine(s.job.floorJobId, l1!.floorLineId, { actualMg: 126756 }, verifier);
  assert.equal(out.verified, false);
  const kept = await sql()`select status from production.weighing_record w join production.floor_job j on j.mixing_session_id = w.secure_mixing_session_id where j.floor_job_id = ${s.job.floorJobId}`;
  assert.deepEqual(kept.map((r) => r.status), ['OUT_OF_TOLERANCE']);
  // STOCK2-1: the top of the window is still inside tolerance on the exact mg, but over the pick, so it
  // is held for a supervisor; the bottom of the window is what a verifier can tick alone.
  const top = await stations.verifyLine(s.job.floorJobId, l1!.floorLineId, { actualMg: 126755 }, verifier);
  assert.deepEqual([top.withinTolerance, top.verified], [true, false]);
  assert.equal((await stations.verifyLine(s.job.floorJobId, l1!.floorLineId, { actualMg: 124244 }, verifier)).withinTolerance, false);
  assert.equal((await stations.verifyLine(s.job.floorJobId, l1!.floorLineId, { actualMg: 124245 }, verifier)).verified, true);
  await assert.rejects(() => stations.completeVerify(s.job.floorJobId, verifier), /not weighed yet: 2/);
  await stations.verifyLine(s.job.floorJobId, l2!.floorLineId, { actualMg: 2250 }, verifier);
  const done = await stations.completeVerify(s.job.floorJobId, verifier);
  assert.equal(done.label.kind, 'VERIFIED');
});

test('mixer: cannot mix what they verified; steps in order; MIXED creates the oil batch with one consumption row per lot', async () => {
  const s = await setup();
  await picked(s);
  for (const l of (await stations.verifyView(s.job.floorJobId)).lines) await stations.verifyLine(s.job.floorJobId, l.floorLineId, { actualMg: l.targetMg }, verifier);
  await stations.completeVerify(s.job.floorJobId, verifier);
  const m = await stations.mixView(s.job.floorJobId);
  assert.equal(m.steps.length, 3); // add line 1, add line 2, the production note
  assert.match(m.steps[0]!.instruction, /^Add line 1: /);
  assert.ok(!/bergamot/i.test(JSON.stringify(m)));
  await assert.rejects(() => stations.doStep(s.job.floorJobId, 1, verifier), /verified this job/);
  await assert.rejects(() => stations.doStep(s.job.floorJobId, 2, mixer), /Do step 1 first/);
  await assert.rejects(() => stations.completeMix(s.job.floorJobId, mixer), /still open: 1, 2, 3/);
  for (const st of m.steps) await stations.doStep(s.job.floorJobId, st.seq, mixer);
  const done = await stations.completeMix(s.job.floorJobId, mixer);
  assert.equal(done.stage, 'DONE');
  assert.match(done.batchNo, /^B-\d{4}-\d{4,}$/);
  assert.equal(done.label.kind, 'MIXED');
  assert.equal(done.label.batchNo, done.batchNo);
  // SCAN-13: the MIXED label carries the batch number; scanning it finds the job, so MIXED can be reprinted.
  assert.equal((await stations.findJob(`]C0${done.batchNo}\r`)).floorJobId, s.job.floorJobId);
  const [ob] = await sql()`select produced_qty::text from production.oil_batch_master where oil_batch_id = ${done.oilBatchId}`;
  assert.equal(Number(ob!.produced_qty), 127.75);
  const cons = await sql()`select consumed_for_document_id::text as lot from production.oil_batch_consumption where oil_batch_id = ${done.oilBatchId}`;
  assert.deepEqual(cons.map((r) => r.lot).sort(), [s.aSoon.inventoryBatchId, s.bLot.inventoryBatchId].sort());
  const [sess] = await sql()`select status from production.secure_mixing_session s join production.floor_job j on j.mixing_session_id = s.secure_mixing_session_id where j.floor_job_id = ${s.job.floorJobId}`;
  assert.equal(sess!.status, 'COMPLETED');
});

test('labels: a reprint needs a reason and says REPRINT; a label for a stage not reached is refused', async () => {
  const s = await setup();
  await assert.rejects(() => stations.print(s.job.floorJobId, 'PICKED', null, picker), /not reached PICKED/);
  await picked(s);
  await assert.rejects(() => stations.print(s.job.floorJobId, 'PICKED', null, picker), /needs a reason/);
  const r = await stations.print(s.job.floorJobId, 'PICKED', 'label smudged', picker);
  assert.equal(r.reprint, true);
  const rows = await sql()`select reprint, reason from production.floor_label where floor_job_id = ${s.job.floorJobId} order by printed_dt`;
  assert.deepEqual(rows.map((x) => [x.reprint, x.reason]), [[false, null], [true, 'label smudged']]);
});

test('two kiosks: concurrent picks of the same line — exactly one wins', async () => {
  const s = await setup();
  const [l1] = (await stations.pickView(s.job.floorJobId)).lines;
  const tries = await Promise.allSettled([1, 2].map(() => stations.pickLine(s.job.floorJobId, l1!.floorLineId, { bin: s.aSoon.bin, barcode: s.aSoon.barcode }, picker)));
  assert.equal(tries.filter((t) => t.status === 'fulfilled').length, 1);
  assert.match(String((tries.find((t) => t.status === 'rejected') as PromiseRejectedResult).reason), /already picked/);
});

test('WALK2-RP-12: job candidates are the runs with a pick list not yet on the floor', async () => {
  const fam = await family();
  const m = await material(fam);
  await lot(m.id, 1000);
  const waiting = await order([{ materialId: m.id, grams: 5 }]);
  const g = await gramUom();
  const noList = uid();
  await sql()`insert into production.production_order (production_order_id, order_qty, uom_id, status) values (${noList}, 1, ${g}, 'INPROGRESS')`;
  let ids = (await stations.jobCandidates()).items.map((r) => r.productionOrderId);
  assert.ok(ids.includes(waiting));
  assert.ok(!ids.includes(noList), 'no pick list, not offered');
  await stations.createJob(waiting, {}, admin);
  ids = (await stations.jobCandidates()).items.map((r) => r.productionOrderId);
  assert.ok(!ids.includes(waiting), 'on the floor, not offered again');
});

// SCAN-3: a QR scan and a Code 128 scan of the same label resolve to the same lot, under the
// scanner's own permissions, whatever AIM prefix or suffix the wedge scanner was set to send.
test('scan-resolve: ]Q1 (QR) and ]C0 (Code 128) wedge scans resolve the same lot; the floor still never sees the material', async () => {
  const { resolveRmLot } = await import('../prodfloor/lot-trace.service.js');
  const fam = await family();
  const m = await material(fam);
  const l = await lot(m.id, 250);
  const qr = await codes.resolve(`]Q1${l.barcode}\r`, picker);
  const bar = await codes.resolve(`]C0${l.barcode}\t`, picker);
  assert.equal(qr.inventoryBatchId, l.inventoryBatchId);
  assert.equal(bar.inventoryBatchId, l.inventoryBatchId);
  assert.equal(qr.barcode, l.barcode);
  assert.equal(qr.materialName, undefined);
  assert.equal((await codes.resolve(`]Q1${l.barcode}`, proc)).materialName, 'Bergamot oil');
  // the lot hold / recall field takes the same label: L- code or the RM batch number
  const [rb] = await sql()`select rm_batch_id::text as id from inventory.inventory_batch where inventory_batch_id = ${l.inventoryBatchId}`;
  assert.equal(await resolveRmLot(sql(), `]Q1${l.barcode}`), rb!.id);
  assert.equal(await resolveRmLot(sql(), `]C0${l.batchNo}\r`), rb!.id);
});
