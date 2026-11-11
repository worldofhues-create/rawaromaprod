/**
 * FLOOR-QC-IN-1-LEGACY (owner decision 2026-11-12): "Legacy release for lots with an existing QC release,
 * marked as such with no sample records created. Lots without one go to QC_PENDING."
 *
 * Runs the real migration file (scripts/migrations/2026-11-12-legacy-qc-release.sql) and its rollback
 * against lots this file builds, on a real Postgres:
 *   Group A  latest inspection ACCEPT/PASS -> a LEGACY_RELEASE lot_qc_event carrying the original release
 *            date and releaser from the disposition (or the inspection), its source named; no sample,
 *            result or inspection row created; status untouched; still usable on the floor.
 *   Group B  no inspection at all -> QUARANTINE (raw lots have no QC_PENDING state), a QUARANTINED event and
 *            a PENDING inspection in QC's queue; refused on the floor.
 *   Neither  rejected, expired, or already in QC (PENDING) -> untouched.
 * And the enforcement: LEGACY_RELEASE reads as released everywhere, until a newer inspection supersedes it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureSchema, testClient, productionDb, qualityDb, principal, closeTestClient } from '../../../test-support/db.js';
import { PickingService } from '@ra/cluster-production';
import { InspectionsService } from '../../../cluster-quality/src/inspections/inspections.service.js';
import { rmLotQcRefusal } from '../../../cluster-inventory/src/batch/lot-qc.js';
import type { VaultPort } from '../../../cluster-formula/src/vault-port.js';
import { FloorCodeService } from '../floor/floor-code.service.js';
import { LotTraceService } from '../prodfloor/lot-trace.service.js';
import { InventoryViewService } from '../inventory-view/inventory-view.service.js';

const migration = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../scripts/migrations/${name}`, import.meta.url)), 'utf8');
const UP = migration('2026-11-12-legacy-qc-release.sql');
const DOWN = migration('rollback/2026-11-12-legacy-qc-release.down.sql');
const ACTOR = 'migration:2026-11-12-legacy-qc-release';

const vault: VaultPort = { async resolveManufacturingInstruction() { return null; }, async resolvePickList() { return null; } };
const sql = () => testClient();
const uid = () => crypto.randomUUID();
const tag = () => uid().slice(0, 6).toUpperCase();
const admin = principal({ roles: ['admin'], userId: '00000000-0000-7000-8000-0000000fd001' });
const proc = principal({ roles: ['procurement'], userId: '00000000-0000-7000-8000-0000000fd002', permissions: ['masterdata:material:reveal'] });
const store = principal({ roles: ['warehouse'], userId: '00000000-0000-7000-8000-0000000fd003', permissions: [] });
const supervisor = principal({ roles: ['production'], userId: '00000000-0000-7000-8000-0000000fd004', permissions: [] });
const QC_USER = '00000000-0000-7000-8000-0000000fd0aa';

let codes: FloorCodeService;
const apply = (text: string) => sql().unsafe(text);

before(async () => {
  await ensureSchema();
  codes = new FloorCodeService(sql());
  // the runner's ledger, which the rollback clears its own rows from (scripts/db-migrate.ts)
  await sql()`create table if not exists public.schema_migrations (id text primary key, applied_at timestamptz not null default now())`;
  await sql()`insert into iam.user_master (user_id, user_name, status) values (${QC_USER}, 'Asha QC', 'ACTIVE') on conflict do nothing`;
});
after(async () => { await closeTestClient(); });

async function gramUom(): Promise<string> {
  await sql()`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values (${uid()}, 'g', 'gram', 'ACTIVE') on conflict do nothing`;
  return (await sql()`select uom_id::text from platform.uom_master where uom_code = 'g'`)[0]!.uom_id as string;
}
async function material() {
  const t = tag();
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const fam = `lq_${t.toLowerCase()}`;
  await codes.setFamily({ familyCode: fam, familyName: `Family ${t}`, colourName: `Tone${letters}`, colourHex: '#5A7D8B' }, admin);
  const id = uid();
  await sql()`insert into masterdata.material (material_id, material_code, material_name, status) values (${id}, ${'M-' + tag()}, 'Legacy material', 'ACTIVE')`;
  await codes.assignCode(id, fam, proc);
  return id;
}
/** A lot as it sits on the floor before the sample rule: no lot_qc_event, no retained sample. */
async function legacyLot(materialId: string, o: { status: string; result?: string | null; expiry?: string; disposed?: boolean }) {
  const g = await gramUom();
  const rb = uid(), ib = uid(), bin = uid(), insp = uid();
  const batchNo = `LG-${tag()}`;
  await sql()`insert into location.bin_master (bin_id, bin_code, status) values (${bin}, ${'LQ-' + tag()}, 'ACTIVE')`;
  await sql()`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status, created_dt)
    values (${rb}, ${materialId}, ${batchNo}, ${o.expiry ?? '2099-01-01'}, ${o.status}, now() - interval '30 days')`;
  if (o.result) {
    await sql()`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result, status, inspection_dt, created_dt, updated_dt, updated_by)
      values (${insp}, ${rb}, ${o.result}, ${o.result}, '2026-10-01T09:00:00Z', now() - interval '20 days', '2026-10-02T10:00:00Z', ${QC_USER})`;
    if (o.disposed) await sql()`insert into quality.qc_disposition (qc_disposition_id, qc_inspection_id, disposition_code, disposed_by, disposed_dt, status)
      values (${uid()}, ${insp}, ${o.result}, ${QC_USER}, '2026-10-03T11:30:00Z', 'ACTIVE')`;
  }
  await sql()`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status)
    values (${ib}, ${rb}, ${materialId}, ${bin}, 500, ${g}, 'ACTIVE')`;
  const barcode = await codes.lotBarcode(ib, null);
  return { rb, ib, bin, batchNo, barcode, inspection: o.result ? insp : null };
}
const rowsFor = async (rb: string) => ({
  status: (await sql()`select status from inventory.rm_batch_master where rm_batch_id = ${rb}`)[0]!.status as string,
  events: [...(await sql()`select event, actor, released_at, released_by, source from inventory.lot_qc_event where rm_batch_id = ${rb} order by at`)] as Array<Record<string, unknown>>,
  inspections: (await sql()`select overall_result from quality.qc_inspections where rm_batch_id = ${rb} order by created_dt`).map((r) => r.overall_result as string),
  samples: Number((await sql()`select count(*)::int c from quality.qc_sample_retention where rm_batch_id = ${rb}`)[0]!.c),
  results: Number((await sql()`select count(*)::int c from quality.qc_result_details d join quality.qc_inspections q on q.qc_inspection_id = d.qc_inspection_id where q.rm_batch_id = ${rb}`)[0]!.c),
});

let m: string;
let aDisposed: Awaited<ReturnType<typeof legacyLot>>, aInspOnly: Awaited<ReturnType<typeof legacyLot>>, bActive: Awaited<ReturnType<typeof legacyLot>>,
  bReleasedNoQc: Awaited<ReturnType<typeof legacyLot>>, rejected: Awaited<ReturnType<typeof legacyLot>>, expired: Awaited<ReturnType<typeof legacyLot>>,
  pending: Awaited<ReturnType<typeof legacyLot>>;

test('legacy QC release: the migration settles Group A and Group B and leaves the rest alone', async () => {
  m = await material();
  aDisposed = await legacyLot(m, { status: 'RELEASED', result: 'ACCEPT', disposed: true });
  aInspOnly = await legacyLot(m, { status: 'ACTIVE', result: 'PASS' });
  bActive = await legacyLot(m, { status: 'ACTIVE' });
  bReleasedNoQc = await legacyLot(m, { status: 'RELEASED' }); // "Release to stock" with no QC: not a QC release
  rejected = await legacyLot(m, { status: 'REJECTED', result: 'REJECT' });
  expired = await legacyLot(m, { status: 'ACTIVE', expiry: '2020-01-01' });
  pending = await legacyLot(m, { status: 'QUARANTINE', result: 'PENDING' });

  await apply(UP);

  // Group A, from the disposition: when and who are the disposition's, and it is named as the source.
  const a1 = await rowsFor(aDisposed.rb);
  assert.equal(a1.status, 'RELEASED');
  assert.equal(a1.events.length, 1);
  assert.equal(a1.events[0]!.event, 'LEGACY_RELEASE');
  assert.equal(a1.events[0]!.actor, ACTOR);
  assert.equal(new Date(a1.events[0]!.released_at as string).toISOString(), '2026-10-03T11:30:00.000Z');
  assert.equal(a1.events[0]!.released_by, QC_USER);
  assert.match(String(a1.events[0]!.source), /^quality\.qc_disposition:[0-9a-f-]{36}$/);
  assert.deepEqual([a1.inspections, a1.samples, a1.results], [['ACCEPT'], 0, 0], 'no sample, result or inspection is invented');

  // Group A, from the inspection alone.
  const a2 = await rowsFor(aInspOnly.rb);
  assert.equal(a2.status, 'ACTIVE');
  assert.equal(a2.events[0]!.event, 'LEGACY_RELEASE');
  assert.equal(new Date(a2.events[0]!.released_at as string).toISOString(), '2026-10-01T09:00:00.000Z');
  assert.equal(a2.events[0]!.released_by, QC_USER);
  assert.equal(a2.events[0]!.source, `quality.qc_inspections:${aInspOnly.inspection}`);
  assert.deepEqual([a2.inspections, a2.samples, a2.results], [['PASS'], 0, 0]);

  // Group B: quarantined for re-inspection, with a PENDING inspection in QC's queue.
  for (const b of [bActive, bReleasedNoQc]) {
    const r = await rowsFor(b.rb);
    assert.equal(r.status, 'QUARANTINE');
    assert.deepEqual(r.events.map((e) => e.event), ['QUARANTINED']);
    assert.deepEqual(r.inspections, ['PENDING']);
    assert.equal(r.samples, 0);
  }

  // Neither.
  for (const [l, status, insp] of [[rejected, 'REJECTED', ['REJECT']], [expired, 'ACTIVE', []], [pending, 'QUARANTINE', ['PENDING']]] as const) {
    const r = await rowsFor(l.rb);
    assert.equal(r.status, status);
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.inspections, insp);
  }
});

test('legacy QC release: running it again changes nothing', async () => {
  const before = await Promise.all([aDisposed, aInspOnly, bActive, bReleasedNoQc].map((l) => rowsFor(l.rb)));
  await apply(UP);
  const again = await Promise.all([aDisposed, aInspOnly, bActive, bReleasedNoQc].map((l) => rowsFor(l.rb)));
  assert.deepEqual(again, before);
});

test('legacy QC release: Group A stays usable on the floor and carries the badge; Group B is refused', async () => {
  const tx = { execute: (q: unknown) => qualityDb().execute(q as never) };
  assert.equal(await rmLotQcRefusal(tx, aDisposed.rb), null);
  assert.match(String(await rmLotQcRefusal(tx, bActive.rb)), /quarantine/i);

  const scanA = await codes.resolve(aDisposed.barcode, store) as Record<string, unknown>;
  assert.equal(scanA.pickable, true);
  assert.equal(scanA.status, 'RELEASED');
  assert.deepEqual(scanA.legacyRelease, { label: 'Released before the sample rule', releasedAt: '2026-10-03T11:30:00Z', releasedBy: QC_USER, releasedByName: 'Asha QC', source: (await rowsFor(aDisposed.rb)).events[0]!.source });
  const scanB = await codes.resolve(bActive.barcode, store) as Record<string, unknown>;
  assert.equal(scanB.pickable, false);
  assert.equal(scanB.legacyRelease, null);

  const view = await new InventoryViewService(sql()).availability({ materialId: m });
  const blocked = Object.fromEntries((view as unknown as { items: Array<{ rmBatchId: string; blocked: number }> }).items.map((i) => [i.rmBatchId, i.blocked]));
  assert.equal(blocked[aDisposed.rb], 0);
  assert.equal(blocked[bActive.rb], 500);

  const queue = await new InspectionsService(qualityDb()).listInspections({ limit: 200 } as never);
  const mine = queue.items.filter((r) => ([aDisposed.rb, bActive.rb] as string[]).includes(String(r.rmBatchId)));
  assert.equal(mine.find((r) => r.rmBatchId === aDisposed.rb)!.legacyRelease, 'Released before the sample rule');
  assert.equal(mine.find((r) => r.rmBatchId === bActive.rb)!.legacyRelease, null);
});

test('legacy QC release: a lot whose only release is LEGACY_RELEASE is released, until a newer inspection supersedes it', async () => {
  const l = await legacyLot(m, { status: 'ACTIVE' });
  await sql()`insert into inventory.lot_qc_event (rm_batch_id, event, detail, actor, released_at, released_by, source)
    values (${l.rb}, 'LEGACY_RELEASE', 'test', 'test', '2026-09-01T00:00:00Z', ${QC_USER}, 'test:fixture')`;
  const tx = { execute: (q: unknown) => qualityDb().execute(q as never) };
  assert.equal(await rmLotQcRefusal(tx, l.rb), null);
  assert.equal((await codes.resolve(l.barcode, store) as Record<string, unknown>).pickable, true);
  const loc = uid();
  await sql()`insert into location.storage_location_master (storage_location_id, storage_location_code, status) values (${loc}, ${'SL-' + tag()}, 'ACTIVE')`;
  await new LotTraceService(sql(), codes).putawayLabel(l.batchNo, { storageLocationId: loc }, store); // no throw: the label prints

  // The pick-list issue takes it.
  const g = await gramUom();
  const orderId = uid(), pl = uid(), item = uid();
  await sql()`insert into production.production_order (production_order_id, order_qty, uom_id, status) values (${orderId}, 1, ${g}, 'INPROGRESS')`;
  await sql()`insert into production.material_pick_list (material_pick_list_id, production_order_id, status) values (${pl}, ${orderId}, 'ACTIVE')`;
  await sql()`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, uom_id, status)
    values (${uid()}, ${orderId}, ${m}, 5, false, ${g}, 'ACTIVE')`;
  await sql()`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, uom_id, status, created_dt)
    values (${item}, ${pl}, ${m}, 5, ${g}, 'ACTIVE', clock_timestamp())`;
  await new PickingService(productionDb(), vault).issueMaterials({ productionOrderId: orderId, materialPickListId: pl, items: [{ materialPickListItemId: item, inventoryBatchId: l.ib }] } as never, supervisor);

  // QC opens a re-test: the newer inspection is QC's word now.
  await sql()`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result, created_dt) values (${uid()}, ${l.rb}, 'PENDING', clock_timestamp() + interval '1 second')`;
  assert.match(String(await rmLotQcRefusal(tx, l.rb)), /not released/);
  assert.equal((await codes.resolve(l.barcode, store) as Record<string, unknown>).pickable, false);
});

test('legacy QC release: the rollback restores every lot, and the migration applies clean again', async () => {
  await apply(DOWN);
  // The legacy columns are gone with the rollback, so read only what 2026-11-11-floor-claims defines.
  const after = async (rb: string) => [
    (await sql()`select status from inventory.rm_batch_master where rm_batch_id = ${rb}`)[0]!.status,
    (await sql()`select event from inventory.lot_qc_event where rm_batch_id = ${rb}`).map((r) => r.event),
    (await sql()`select overall_result from quality.qc_inspections where rm_batch_id = ${rb}`).map((r) => r.overall_result),
  ];
  assert.deepEqual(await after(aDisposed.rb), ['RELEASED', [], ['ACCEPT']]);
  assert.deepEqual(await after(bActive.rb), ['ACTIVE', [], []]);
  assert.deepEqual(await after(bReleasedNoQc.rb), ['RELEASED', [], []]);
  assert.equal(await sql()`select to_regclass('inventory.legacy_qc_release_2026_11_12') t`.then((r) => r[0]!.t), null);

  await apply(UP);
  assert.equal((await rowsFor(aDisposed.rb)).events[0]!.event, 'LEGACY_RELEASE');
  assert.equal((await rowsFor(bActive.rb)).status, 'QUARANTINE');
});
