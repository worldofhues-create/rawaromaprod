/**
 * FLOOR-FIX-2 — the raw-lot label at putaway is QUEUED to the print agent (production-floor plan §4,
 * "Scan the bin -> raw-lot label printed"). It used to be logged in inventory.raw_lot_label and never
 * reach a printer, so the rack held lots with no label on them. One payload drives both codes: the
 * QR and the Code 128 carry the same opaque L- id the picker scans.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { LotTraceService } from '../prodfloor/lot-trace.service.js';
import { FloorCodeService } from '../floor/floor-code.service.js';
import { PrintService } from '../floor-ops/print.service.js';
import { DevicesService } from '../floor-ops/devices.service.js';

before(ensureSchema);
after(closeTestClient);

test('putaway queues one raw-lot print job: QR and Code 128 carry the same lot code; a reprint is marked', async () => {
  const s = testClient();
  const [u] = await s`select uom_id::text as id from platform.uom_master where uom_code = 'KG' limit 1`;
  const kg = u?.id ?? String((await s`insert into platform.uom_master (uom_code, uom_name, status) values ('KG', 'Kilogram', 'ACTIVE') returning uom_id::text as id`)[0]!.id);
  const rm = randomUUID(), ib = randomUUID(), bin = randomUUID(), binCode = 'B-' + bin.slice(0, 6).toUpperCase();
  await s`insert into inventory.rm_batch_master (rm_batch_id, batch_number, received_qty, uom_id, status, expiry_date) values (${rm}, ${'RMB-' + rm.slice(0, 8)}, 5, ${kg}, 'ACTIVE', '2099-01-01')`;
  await s`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values (${randomUUID()}, ${rm}, 'ACCEPT')`; // FLOOR-QC-IN-1: QC released it
  await s`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, quantity_on_hand, status) values (${ib}, ${rm}, 5, 'ACTIVE')`;
  await s`insert into location.storage_location_master (storage_location_id, storage_location_code, status) values (${bin}, ${binCode}, 'ACTIVE')`;
  const print = new PrintService(s, new DevicesService(s));
  const lots = new LotTraceService(s, new FloorCodeService(s), print);
  const station = `PUT-${rm.slice(0, 4)}`;

  const label = await lots.putawayLabel(rm, { storageLocationId: binCode, station }, principal());
  assert.ok(label.printJobId, 'the label was queued, not only logged');
  const jobs = await s`select label_kind, subject_ref, station, template from platform.print_job where station = ${station} order by created_at`;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.label_kind, 'raw_lot');
  assert.equal(jobs[0]!.subject_ref, label.barcode);
  const tpl = (typeof jobs[0]!.template === 'string' ? JSON.parse(jobs[0]!.template) : jobs[0]!.template) as { elements: { t: string; d?: string }[]; reprint: boolean };
  const qr = tpl.elements.filter((e) => e.t === 'qr'), bars = tpl.elements.filter((e) => e.t === 'code128');
  assert.equal(qr.length, 1);
  assert.equal(bars.length, 1);
  assert.equal(qr[0]!.d, label.barcode);
  assert.equal(bars[0]!.d, qr[0]!.d, 'QR and Code 128 carry the same payload');
  assert.equal(tpl.reprint, false);

  const rp = await lots.putawayLabel(rm, { reprintReason: 'smudged', station }, principal());
  const again = await s`select template from platform.print_job where print_job_id = ${rp.printJobId}::uuid`;
  const t2 = (typeof again[0]!.template === 'string' ? JSON.parse(again[0]!.template) : again[0]!.template) as { reprint: boolean };
  assert.equal(t2.reprint, true);
});
