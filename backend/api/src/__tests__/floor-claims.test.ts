/**
 * FLOOR-QC-IN-1, FLOOR-LOT-STOP-1, FLOOR-TEMP-1 (owner rule 2026-11-11: a claim the website makes is
 * built so it can be backed). On a real Postgres. The storefront says:
 *
 *   "QC samples every incoming lot"  -> a received lot is born QUARANTINE; QC cannot release it without a
 *                                       recorded sample result; nothing consumes, picks, releases to stock
 *                                       or labels a lot QC has not released. Every transition is on file.
 *   "A wrong lot stops the line"     -> a wrong scan at the pick station is refused AND stops the job:
 *                                       every station write on it is refused until a supervisor (not the
 *                                       person who scanned) resumes it with a reason. The stop is the audit.
 *   "Temperature watched throughout" -> readings per zone; a reading outside a material's SOURCED limit
 *                                       holds every lot of it in the zone and raises an alert; a material
 *                                       with no sourced limit is reported "no limit on file", never "within
 *                                       limits"; a zone not logged within its interval raises an overdue alert.
 *
 * No reading, limit or zone here is seed data: each test makes its own and asserts on it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSchema, testClient, productionDb, inventoryDb, qualityDb, principal, closeTestClient } from '../../../test-support/db.js';
import { PickingService, MixingService, BatchService } from '@ra/cluster-production';
import { BatchService as RmBatchService } from '../../../cluster-inventory/src/batch/batch.service.js';
import { GrnService } from '../../../cluster-inventory/src/grn/grn.service.js';
import { InspectionsService } from '../../../cluster-quality/src/inspections/inspections.service.js';
import type { VaultPort } from '../../../cluster-formula/src/vault-port.js';
import { FloorCodeService } from '../floor/floor-code.service.js';
import { FloorStationService } from '../floor/floor-station.service.js';
import { LotTraceService } from '../prodfloor/lot-trace.service.js';
import { QuarantineIntakeService } from '../automation/quarantine-intake.service.js';
import { TemperatureService, parseCentiC } from '../floor-ops/temperature.service.js';
import { DevicesService } from '../floor-ops/devices.service.js';

const vault: VaultPort = { async resolveManufacturingInstruction() { return null; }, async resolvePickList() { return null; } };
let codes: FloorCodeService;
let stations: FloorStationService;
let picking: PickingService;
let temps: TemperatureService;
const sql = () => testClient();

const admin = principal({ roles: ['admin'], userId: '00000000-0000-7000-8000-0000000fc001' });
const proc = principal({ roles: ['procurement'], userId: '00000000-0000-7000-8000-0000000fc002', permissions: ['masterdata:material:reveal'] });
const picker = principal({ roles: ['picker'], userId: '00000000-0000-7000-8000-0000000fc003', permissions: [] });
const supervisor = principal({ roles: ['production'], userId: '00000000-0000-7000-8000-0000000fc004', permissions: [] });
const qc = principal({ roles: ['qc'], userId: '00000000-0000-7000-8000-0000000fc005', permissions: [] });
const store = principal({ roles: ['warehouse'], userId: '00000000-0000-7000-8000-0000000fc006', permissions: [] });

before(async () => {
  await ensureSchema();
  codes = new FloorCodeService(sql());
  const db = productionDb();
  picking = new PickingService(db, vault);
  stations = new FloorStationService(sql(), codes, picking, new MixingService(db), new BatchService(db));
  temps = new TemperatureService(sql());
});
// The suite shares one database: the floor-wide alerts and the paired sensors this file makes would
// otherwise sit in every later station test's alert count and offline sweep.
after(async () => {
  await sql()`update platform.floor_alert set cleared_at = now() where kind in ('LINE_STOPPED', 'TEMP_EXCURSION', 'TEMP_LOG_OVERDUE') and cleared_at is null`;
  await sql()`update platform.device_master set status = 'revoked', revoked_at = now() where kind = 'temp_sensor' and status <> 'revoked'`;
  await closeTestClient();
});

const uid = () => crypto.randomUUID();
const tag = () => uid().slice(0, 6).toUpperCase();

async function gramUom(): Promise<string> {
  await sql()`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values (${uid()}, 'g', 'gram', 'ACTIVE') on conflict do nothing`;
  const [r] = await sql()`select uom_id::text from platform.uom_master where uom_code = 'g'`;
  return r!.uom_id as string;
}
async function family(): Promise<string> {
  const t = tag();
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const code = `fc_${t.toLowerCase()}`;
  await codes.setFamily({ familyCode: code, familyName: `Family ${t}`, colourName: `Tone${letters}`, colourHex: '#5A7D8B' }, admin);
  return code;
}
async function material(fam: string) {
  const id = uid();
  await sql()`insert into masterdata.material (material_id, material_code, material_name, status) values (${id}, ${'M-' + tag()}, 'Test material', 'ACTIVE')`;
  const fc = await codes.assignCode(id, fam, proc);
  return { id, code: fc.code };
}
let binSeq = 0;
async function bin(): Promise<{ id: string; code: string }> {
  const id = uid();
  const code = `FC-${tag()}-${++binSeq}`;
  await sql()`insert into location.bin_master (bin_id, bin_code, status) values (${id}, ${code}, 'ACTIVE')`;
  return { id, code };
}
/** A stock lot. `status`/`result` let a test build a lot QC has, or has not, released. */
async function lot(materialId: string, grams: number, opts: { status?: string; result?: string | null; binId?: string } = {}) {
  const g = await gramUom();
  const rb = uid(), ib = uid();
  const b = opts.binId ? { id: opts.binId, code: '' } : await bin();
  const batchNo = `RM-${tag()}`;
  await sql()`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status, created_dt)
    values (${rb}, ${materialId}, ${batchNo}, '2099-01-01', ${opts.status ?? 'RELEASED'}, now())`;
  if (opts.result !== null) await sql()`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values (${uid()}, ${rb}, ${opts.result ?? 'ACCEPT'})`;
  await sql()`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status)
    values (${ib}, ${rb}, ${materialId}, ${b.id}, ${grams}, ${g}, 'ACTIVE')`;
  const barcode = await codes.lotBarcode(ib, null);
  const [bc] = await sql()`select bin_code from location.bin_master where bin_id = ${b.id}`;
  return { inventoryBatchId: ib, rmBatchId: rb, barcode, bin: String(bc!.bin_code), binId: b.id, batchNo };
}
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
  return { orderId, pickListId: pl };
}
async function events(rmBatchId: string) {
  return (await sql()`select event from inventory.lot_qc_event where rm_batch_id = ${rmBatchId} order by at, lot_qc_event_id`).map((r) => r.event as string);
}

/* ── FLOOR-QC-IN-1: incoming QC ──────────────────────────────────────────────────────────── */

test('FLOOR-QC-IN-1: a received lot is born QUARANTINE (GRN and direct create), with the quarantine on file', async () => {
  const fam = await family();
  const m = await material(fam);
  const g = await gramUom();
  const grn = await new GrnService(inventoryDb()).createGrn({
    grnDate: '2026-11-11', items: [{ materialId: m.id, uomId: g, receivedQty: 500, containers: [] }],
  } as never, store);
  const rb = grn.batches[0]!;
  assert.equal(rb.status, 'QUARANTINE');
  assert.deepEqual(await events(rb.rmBatchId), ['QUARANTINED']);
  const direct = await new RmBatchService(inventoryDb()).createRmBatch({ materialId: m.id, receivedQty: 10, uomId: g } as never, store);
  assert.equal(direct.status, 'QUARANTINE');
  assert.deepEqual(await events(direct.rmBatchId), ['QUARANTINED']);
});

test('FLOOR-QC-IN-1: the intake rule opens the PENDING inspection for a lot born in quarantine, once', async () => {
  const m = await material(await family());
  const g = await gramUom();
  const rb = await new RmBatchService(inventoryDb()).createRmBatch({ materialId: m.id, receivedQty: 10, uomId: g } as never, store);
  const svc = new QuarantineIntakeService(sql());
  const apply = (id: string) => (svc as unknown as { applyOne(i: string): Promise<void> }).applyOne(id);
  await apply(rb.rmBatchId);
  await apply(rb.rmBatchId);
  const insp = await sql()`select overall_result from quality.qc_inspections where rm_batch_id = ${rb.rmBatchId}`;
  assert.deepEqual(insp.map((r) => r.overall_result), ['PENDING']);
});

test('FLOOR-QC-IN-1: QC cannot ACCEPT an incoming lot with no sample result recorded', async () => {
  const m = await material(await family());
  const g = await gramUom();
  const rb = await new RmBatchService(inventoryDb()).createRmBatch({ materialId: m.id, receivedQty: 10, uomId: g } as never, store);
  const q = new InspectionsService(qualityDb());
  const insp = await q.createInspection({ rmBatchId: rb.rmBatchId } as never, qc);
  await assert.rejects(() => q.dispose(insp.qcInspectionId, { dispositionCode: 'ACCEPT' } as never, qc), /sample/i);
  // REJECT and HOLD are always allowed: refusing a lot never needs evidence it is good.
  await q.addResults(insp.qcInspectionId, { results: [{ result: 'PASS', observedText: 'clear, conforms to reference' }] } as never, qc);
  await assert.rejects(() => q.dispose(insp.qcInspectionId, { dispositionCode: 'ACCEPT' } as never, qc), /retained sample/);
  await sql()`insert into quality.qc_sample_retention (qc_sample_retention_id, qc_inspection_id, rm_batch_id, sample_code, retained_dt, retained_by)
    values (${uid()}, ${insp.qcInspectionId}, ${rb.rmBatchId}, ${'S-' + tag()}, now(), ${qc.userId})`;
  const ok = await q.dispose(insp.qcInspectionId, { dispositionCode: 'ACCEPT' } as never, qc);
  assert.equal(ok.inspection.overallResult, 'ACCEPT');
});

test('FLOOR-QC-IN-1: "Release to stock" is refused until QC has accepted the lot, then works', async () => {
  const m = await material(await family());
  const g = await gramUom();
  const inv = new RmBatchService(inventoryDb());
  const rb = await inv.createRmBatch({ materialId: m.id, receivedQty: 10, uomId: g } as never, store);
  await assert.rejects(() => inv.releaseRmBatch(rb.rmBatchId, {} as never, store), /QC/);
  const insp = uid();
  await sql()`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values (${insp}, ${rb.rmBatchId}, 'PENDING')`;
  await assert.rejects(() => inv.releaseRmBatch(rb.rmBatchId, {} as never, store), /QC/);
  await sql()`update quality.qc_inspections set overall_result = 'ACCEPT' where qc_inspection_id = ${insp}`;
  const out = await inv.releaseRmBatch(rb.rmBatchId, {} as never, store);
  assert.ok(out.inventoryBatch.inventoryBatchId);
  assert.deepEqual(await events(rb.rmBatchId), ['QUARANTINED', 'RELEASED']);
});

test('FLOOR-QC-IN-1: a lot QC has not released cannot be issued (consumed), even by naming it directly', async () => {
  const m = await material(await family());
  for (const opts of [{ status: 'QUARANTINE', result: 'PENDING' }, { status: 'ACTIVE', result: null }, { status: 'REJECTED', result: 'REJECT' }] as const) {
    const l = await lot(m.id, 1000, opts);
    const o = await order([{ materialId: m.id, grams: 5 }]);
    const [line] = await sql()`select material_pick_list_item_id::text as id from production.material_pick_list_items where material_pick_list_id = ${o.pickListId}`;
    await assert.rejects(
      () => picking.issueMaterials({ productionOrderId: o.orderId, materialPickListId: o.pickListId, items: [{ materialPickListItemId: line!.id, inventoryBatchId: l.inventoryBatchId }] } as never, supervisor),
      /not released by QC|quarantine|rejected/i,
      `status ${opts.status} must not be issuable`,
    );
  }
  const good = await lot(m.id, 1000);
  const o = await order([{ materialId: m.id, grams: 5 }]);
  const [line] = await sql()`select material_pick_list_item_id::text as id from production.material_pick_list_items where material_pick_list_id = ${o.pickListId}`;
  await picking.issueMaterials({ productionOrderId: o.orderId, materialPickListId: o.pickListId, items: [{ materialPickListItemId: line!.id, inventoryBatchId: good.inventoryBatchId }] } as never, supervisor);
});

test('FLOOR-QC-IN-1: no putaway label for a lot QC has not accepted (a legacy ACTIVE lot with no inspection included)', async () => {
  const m = await material(await family());
  const lots = new LotTraceService(sql(), codes);
  const legacy = await lot(m.id, 100, { status: 'ACTIVE', result: null });
  await assert.rejects(() => lots.putawayLabel(legacy.batchNo, {}, store), /QC/);
  const pending = await lot(m.id, 100, { status: 'QUARANTINE', result: 'PENDING' });
  await assert.rejects(() => lots.putawayLabel(pending.batchNo, {}, store), /quarantine/i);
});

/* ── FLOOR-LOT-STOP-1: a wrong lot stops the line ───────────────────────────────────────── */

async function job() {
  const fam = await family();
  const a = await material(fam), b = await material(fam);
  const aLot = await lot(a.id, 1000), bLot = await lot(b.id, 1000);
  const o = await order([{ materialId: a.id, grams: 10 }]);
  const j = await stations.createJob(o.orderId, {}, admin);
  const [l1] = (await stations.pickView(j.floorJobId)).lines;
  return { a, b, aLot, bLot, j, line: l1!.floorLineId };
}

test('FLOOR-LOT-STOP-1: a wrong-material scan is refused and stops the job; nothing on it moves until a supervisor resumes', async () => {
  const s = await job();
  await assert.rejects(() => stations.pickLine(s.j.floorJobId, s.line, { bin: s.bLot.bin, barcode: s.bLot.barcode }, picker), /Wrong material.*line is stopped/s);
  const v = await stations.pickView(s.j.floorJobId);
  assert.equal(v.stop?.kind, 'WRONG_MATERIAL');
  assert.equal(v.stop?.scanned, s.bLot.barcode);
  // the right lot is refused too while the line is stopped: the stop is not advisory
  await assert.rejects(() => stations.pickLine(s.j.floorJobId, s.line, { bin: s.aLot.bin, barcode: s.aLot.barcode }, picker), /stopped/);
  const [alert] = await sql()`select kind from platform.floor_alert where dedupe_key = ${'line_stop:' + s.j.floorJobId} and cleared_at is null`;
  assert.equal(alert?.kind, 'LINE_STOPPED');
  // resuming: a reason, and never the person who made the scan
  await assert.rejects(() => stations.clearStop(s.j.floorJobId, { reason: '' }, supervisor), /reason/);
  await assert.rejects(() => stations.clearStop(s.j.floorJobId, { reason: 'checked' }, picker), /someone else/);
  const r = await stations.clearStop(s.j.floorJobId, { reason: 'Wrong drum returned to bin; picker re-briefed' }, supervisor);
  assert.equal(r.resumed, true);
  const [row] = await sql()`select kind, stopped_by, cleared_by, clear_reason from production.floor_line_stop where floor_job_id = ${s.j.floorJobId}`;
  assert.deepEqual([row!.kind, row!.stopped_by, row!.cleared_by, row!.clear_reason], ['WRONG_MATERIAL', picker.userId, supervisor.userId, 'Wrong drum returned to bin; picker re-briefed']);
  assert.equal((await sql()`select 1 from platform.floor_alert where dedupe_key = ${'line_stop:' + s.j.floorJobId} and cleared_at is null`).length, 0);
  assert.equal((await stations.pickView(s.j.floorJobId)).stop, null);
  await stations.pickLine(s.j.floorJobId, s.line, { bin: s.aLot.bin, barcode: s.aLot.barcode }, picker);
});

test('FLOOR-LOT-STOP-1: an unknown label, a quarantined lot and a held lot of the right material each stop the line', async () => {
  for (const make of ['unknown', 'quarantine', 'held'] as const) {
    const s = await job();
    let barcode = 'L-ZZZZZZZ', binCode = s.aLot.bin, kind = 'UNKNOWN_LOT';
    if (make === 'quarantine') { const q = await lot(s.a.id, 1000, { status: 'QUARANTINE', result: 'PENDING' }); barcode = q.barcode; binCode = q.bin; kind = 'LOT_NOT_RELEASED'; }
    if (make === 'held') {
      const h = await lot(s.a.id, 1000);
      await sql()`insert into inventory.lot_hold (subject_type, subject_id, reason, source) values ('RM_LOT', ${h.rmBatchId}, 'test hold', 'TEST')`;
      barcode = h.barcode; binCode = h.bin; kind = 'LOT_ON_HOLD';
    }
    await assert.rejects(() => stations.pickLine(s.j.floorJobId, s.line, { bin: binCode, barcode }, picker), /stopped/);
    assert.equal((await stations.pickView(s.j.floorJobId)).stop?.kind, kind, make);
  }
});

test('FLOOR-LOT-STOP-1: an off-FEFO lot of the right material is not a stop (it needs a reason, as before)', async () => {
  const s = await job();
  const late = await lot(s.a.id, 1000);
  await sql()`update inventory.rm_batch_master set expiry_date = '2099-12-01' where rm_batch_id = ${late.rmBatchId}`;
  await assert.rejects(() => stations.pickLine(s.j.floorJobId, s.line, { bin: late.bin, barcode: late.barcode }, picker), /give a reason/);
  assert.equal((await stations.pickView(s.j.floorJobId)).stop, null);
});

/* ── FLOOR-TEMP-1: temperature ──────────────────────────────────────────────────────────── */

test('FLOOR-TEMP-1: temperatures are parsed exactly to 0.01 °C, never through a float', () => {
  assert.equal(parseCentiC('25'), 2500);
  assert.equal(parseCentiC('-18.5'), -1850);
  assert.equal(parseCentiC('31.25'), 3125);
  assert.equal(parseCentiC('31.255'), null);
  assert.equal(parseCentiC('abc'), null);
  assert.equal(parseCentiC(''), null);
  assert.equal(parseCentiC('1000'), null);
});

test('FLOOR-TEMP-1: a limit needs a source; a zone needs an interval', async () => {
  const m = await material(await family());
  await assert.rejects(() => temps.setLimit(m.id, { maxC: '25', source: '' }, qc), /source/);
  await assert.rejects(() => temps.setLimit(m.id, { source: 'supplier SDS rev 3' }, qc), /min or a max/);
  await assert.rejects(() => temps.setLimit(m.id, { minC: '30', maxC: '20', source: 'SDS' }, qc), /below/);
  await assert.rejects(() => temps.createZone({ code: `Z-${tag()}`, name: 'Cold room', kind: 'STORAGE', logIntervalMin: 0, bins: [] }, qc), /interval/);
});

test('FLOOR-TEMP-1: a reading outside a sourced limit holds every lot of that material in the zone and raises an alarm; no limit is reported as none on file', async () => {
  const fam = await family();
  const limited = await material(fam), unlimited = await material(fam);
  const b1 = await bin(), b2 = await bin(), elsewhere = await bin();
  const zone = await temps.createZone({ code: `Z-${tag()}`, name: 'RM store A', kind: 'STORAGE', logIntervalMin: 240, bins: [b1.code, b2.code] }, qc);
  await temps.setLimit(limited.id, { minC: '2', maxC: '25', source: 'Supplier SDS section 7, rev 2024-03' }, qc);
  const inZone = await lot(limited.id, 1000, { binId: b1.id });
  const inZone2 = await lot(limited.id, 1000, { binId: b2.id });
  const outOfZone = await lot(limited.id, 1000, { binId: elsewhere.id });
  const noLimit = await lot(unlimited.id, 1000, { binId: b1.id });

  const ok = await temps.recordReading(zone.zoneId, { tempC: '24.5' }, store);
  assert.equal(ok.excursions.length, 0);
  assert.equal(ok.noLimitOnFile, 1);

  const hot = await temps.recordReading(zone.zoneId, { tempC: '31.0', note: 'door left open' }, store);
  assert.deepEqual(hot.excursions.map((e) => e.lot).sort(), [inZone.batchNo, inZone2.batchNo].sort());
  assert.equal(hot.noLimitOnFile, 1, 'a material with no sourced limit is not called within limits');
  const held = await sql()`select subject_id::text, source, reason from inventory.lot_hold where subject_type = 'RM_LOT' and released_dt is null and subject_id = any(${[inZone.rmBatchId, inZone2.rmBatchId, outOfZone.rmBatchId, noLimit.rmBatchId]}::uuid[])`;
  assert.deepEqual(held.map((h) => h.subject_id).sort(), [inZone.rmBatchId, inZone2.rmBatchId].sort());
  assert.ok(held.every((h) => h.source === 'TEMP_EXCURSION' && /31\.00 °C/.test(String(h.reason)) && /SDS/.test(String(h.reason))));
  const [alert] = await sql()`select kind, title from platform.floor_alert where dedupe_key = ${'temp_excursion:' + zone.zoneId} and cleared_at is null`;
  assert.equal(alert?.kind, 'TEMP_EXCURSION');
  // the held lot cannot be picked: the hold reaches the floor
  const o = await order([{ materialId: limited.id, grams: 10 }]);
  const j = await stations.createJob(o.orderId, {}, admin);
  const v = await stations.pickView(j.floorJobId);
  assert.equal(v.lines[0]!.takeLot?.lot, outOfZone.batchNo, 'only the lot outside the zone is directed');
  // readings are on file, append-only, with who logged them
  const rs = await sql()`select centi_c, source, recorded_by from quality.temperature_reading where zone_id = ${zone.zoneId} order by read_at`;
  assert.deepEqual(rs.map((r) => [r.centi_c, r.source, r.recorded_by]), [[2450, 'MANUAL', store.userId], [3100, 'MANUAL', store.userId]]);
});

test('FLOOR-TEMP-1: a zone not logged within its interval is overdue; the sweep raises it and a reading clears it', async () => {
  const b = await bin();
  const zone = await temps.createZone({ code: `Z-${tag()}`, name: 'Mixing room', kind: 'PRODUCTION', logIntervalMin: 60, bins: [b.code] }, qc);
  let z = (await temps.zones()).find((x) => x.zoneId === zone.zoneId)!;
  assert.equal(z.overdue, true, 'never logged is overdue');
  await temps.sweepOverdue(new Date());
  assert.equal((await sql()`select 1 from platform.floor_alert where dedupe_key = ${'temp_overdue:' + zone.zoneId} and cleared_at is null`).length, 1);
  await temps.recordReading(zone.zoneId, { tempC: '22' }, store);
  z = (await temps.zones()).find((x) => x.zoneId === zone.zoneId)!;
  assert.equal(z.overdue, false);
  assert.equal(z.lastReading?.centiC, 2200);
  assert.equal((await sql()`select 1 from platform.floor_alert where dedupe_key = ${'temp_overdue:' + zone.zoneId} and cleared_at is null`).length, 0);
  // an hour and a minute later with no reading, the sweep raises it again
  await temps.sweepOverdue(new Date(Date.now() + 61 * 60_000));
  assert.equal((await sql()`select 1 from platform.floor_alert where dedupe_key = ${'temp_overdue:' + zone.zoneId} and cleared_at is null`).length, 1);
});

test('FLOOR-TEMP-1: a zone is MANUAL until a sensor is paired to it; a paired sensor posts readings with its device token', async () => {
  const b = await bin();
  const zone = await temps.createZone({ code: `Z-${tag()}`, name: 'Maceration store', kind: 'STORAGE', logIntervalMin: 30, bins: [b.code] }, qc);
  const z0 = (await temps.zones()).find((x) => x.zoneId === zone.zoneId)!;
  assert.equal(z0.source, 'MANUAL', 'no sensor paired: a person must log it');
  const devices = new DevicesService(sql());
  await assert.rejects(() => devices.create({ kind: 'temp_sensor', station: 'Stores', name: 'Logger 1', config: {} }, admin), /zone/);
  const made = await devices.create({ kind: 'temp_sensor', station: 'Stores', name: 'Logger 1', config: { zoneId: zone.zoneId } }, admin);
  assert.equal((await temps.zones()).find((x) => x.zoneId === zone.zoneId)!.source, 'MANUAL', 'a sensor not yet paired does not count');
  await assert.rejects(() => devices.create({ kind: 'temp_sensor', station: 'Stores', name: 'Logger 2', config: { zoneId: zone.zoneId } }, admin), /already has a sensor/);
  const paired = await devices.pair(made.pairing!.code);
  const dev = await devices.authenticate(paired.token);
  const r = await temps.recordSensorReading(dev, { tempC: '18.25' });
  assert.equal(r.source, 'SENSOR');
  const z1 = (await temps.zones()).find((x) => x.zoneId === zone.zoneId)!;
  assert.equal(z1.source, 'SENSOR');
  assert.equal(z1.lastReading?.centiC, 1825);
  const [row] = await sql()`select source, device_id::text from quality.temperature_reading where temperature_reading_id = ${r.temperatureReadingId}`;
  assert.deepEqual([row!.source, row!.device_id], ['SENSOR', made.device.deviceId]);
  // another kind of device cannot post a temperature
  await assert.rejects(() => temps.recordSensorReading({ ...dev, kind: 'scale' }, { tempC: '18' }), /temperature sensor/);
  // a silent sensor makes the zone overdue like any other: it falls back to manual logging
  await temps.sweepOverdue(new Date(Date.now() + 31 * 60_000));
  const [a] = await sql()`select title from platform.floor_alert where dedupe_key = ${'temp_overdue:' + zone.zoneId} and cleared_at is null`;
  assert.match(String(a?.title), /sensor silent.*by hand/i);
});

test('FLOOR-TEMP-1: zone bounds need a source, and a reading outside them holds every lot in the zone', async () => {
  const fam = await family();
  const m = await material(fam);
  const b = await bin();
  await assert.rejects(() => temps.createZone({ code: `Z-${tag()}`, name: 'x', kind: 'STORAGE', logIntervalMin: 60, bins: [], minC: '16', maxC: '20' }, qc), /document/);
  const zone = await temps.createZone({ code: `Z-${tag()}`, name: 'Maceration store', kind: 'STORAGE', logIntervalMin: 60, bins: [b.code], minC: '16', maxC: '20', boundsSource: 'House SOP-STO-04 rev 1' }, qc);
  const l = await lot(m.id, 1000, { binId: b.id });
  const r = await temps.recordReading(zone.zoneId, { tempC: '23' }, store);
  assert.equal(r.zoneBreach, 'zone max 20.00 °C');
  assert.deepEqual(r.excursions.map((e) => e.lot), [l.batchNo]);
  const [h] = await sql()`select reason from inventory.lot_hold where subject_type = 'RM_LOT' and subject_id = ${l.rmBatchId} and released_dt is null`;
  assert.match(String(h?.reason), /SOP-STO-04/);
  const [e] = await sql()`select basis from quality.temperature_excursion where rm_batch_id = ${l.rmBatchId}`;
  assert.equal(e?.basis, 'ZONE');
});

test('FLOOR-TEMP-1: the floor-claims migration allows every device kind the code allows, and its rollback narrows it again', async () => {
  const { readFileSync } = await import('node:fs');
  const { DEVICE_KINDS } = await import('../floor-ops/devices.service.js');
  const mig = readFileSync(new URL('../../../../scripts/migrations/2026-11-11-floor-claims.sql', import.meta.url), 'utf8');
  const down = readFileSync(new URL('../../../../scripts/migrations/rollback/2026-11-11-floor-claims.down.sql', import.meta.url), 'utf8');
  const kinds = (t: string) => /device_master_kind_check\s+check \(kind in \(([^)]*)\)\)/.exec(t)![1]!.split(',').map((x) => x.trim().replace(/'/g, ''));
  assert.deepEqual(kinds(mig).sort(), [...DEVICE_KINDS].sort());
  assert.deepEqual(kinds(down).sort(), DEVICE_KINDS.filter((k) => k !== 'temp_sensor').sort());
});
