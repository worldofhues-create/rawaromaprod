/**
 * STOCK-FIX-RP, item 6: STK-16 (the supplier's lot reference reaches the raw lot), STK-18 (one material,
 * one name; a hazard class with its source; a sheet's total row is never a material), STK-17 (a CSV
 * import of raw materials with a dry run) and STK-19 (the D-2 floor families are seeded; code numbers
 * are issued in order). Real Postgres, the real services. Every material name here is made up.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as masterdataSchema from '@ra/data-masterdata';
import { createMaterial } from '../../../cluster-masterdata/src/cluster-masterdata.dtos.js';
import { MaterialService } from '../../../cluster-masterdata/src/material/material.service.js';
import { GrnService } from '../../../cluster-inventory/src/grn/grn.service.js';
import { splitByTarget } from '../../../../scripts/db-migrate.js';
import { FloorCodeService } from '../floor/floor-code.service.js';
import { MaterialImportService, casValid } from '../floor/material-import.service.js';
import { ensureSchema, testClient, inventoryDb, principal, closeTestClient } from '../../../test-support/db.js';

let materials: MaterialService;
let codes: FloorCodeService;
let importer: MaterialImportService;
const sql = () => testClient();
const buyer = principal({ roles: ['procurement'], permissions: ['masterdata:material_import:write'] });
const t = () => crypto.randomUUID().slice(0, 6).toUpperCase();

before(async () => {
  await ensureSchema();
  materials = new MaterialService(drizzle(testClient(), { schema: masterdataSchema }) as never);
  codes = new FloorCodeService(sql());
  importer = new MaterialImportService(sql(), codes);
});
after(closeTestClient);

async function family() {
  const x = t();
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const code = `fam_${x.toLowerCase()}`;
  await codes.setFamily({ familyCode: code, familyName: `Family ${x}`, colourName: `Tone${letters}`, colourHex: '#2F5DFF' }, buyer);
  return code;
}

/* ── STK-16 ───────────────────────────────────────────────────────────────────────────────── */

test('STK-16: the supplier\'s lot reference on a GRN line reaches the raw lot; none given is null, never made up', async () => {
  await sql()`insert into platform.uom_master (uom_code, uom_name, status) values ('g', 'g', 'ACTIVE') on conflict (uom_code) do nothing`;
  const [g] = await sql()`select uom_id::text from platform.uom_master where uom_code = 'g'`;
  const m = await materials.createMaterial({ materialCode: `S16-${t()}`, materialName: `Probe ether ${t()}` }, buyer);
  const grn = await new GrnService(inventoryDb()).createGrn({
    grnDate: '2026-11-13',
    items: [
      { materialId: m.materialId, uomId: g!.uom_id, receivedQty: 500, supplierLotRef: 'SUP-24117-B', containers: [] },
      { materialId: m.materialId, uomId: g!.uom_id, receivedQty: 200, containers: [] },
    ],
  } as never, buyer);
  assert.deepEqual(grn.batches.map((b) => b.supplierLotRef), ['SUP-24117-B', null]);
  assert.deepEqual(grn.items.map((i) => i.supplierLotRef), ['SUP-24117-B', null]);
  const [rb] = await sql()`select supplier_lot_ref from inventory.rm_batch_master where rm_batch_id = ${grn.batches[0]!.rmBatchId}`;
  assert.equal(rb!.supplier_lot_ref, 'SUP-24117-B');
});

/* ── STK-18 ───────────────────────────────────────────────────────────────────────────────── */

test('STK-18: a second material of the same name (case and spaces aside) is refused, also when two race', async () => {
  const name = `Probe Aldehyde ${t()}`;
  await materials.createMaterial({ materialCode: `S18-${t()}`, materialName: name }, buyer);
  await assert.rejects(() => materials.createMaterial({ materialCode: `S18-${t()}`, materialName: `  ${name.toLowerCase().replace(' ', '   ')} ` }, buyer),
    (e: unknown) => e instanceof ConflictException && /already on file/.test((e as Error).message));
  const other = `Probe Ketone ${t()}`;
  const r = await Promise.allSettled([1, 2].map(() => materials.createMaterial({ materialCode: `S18-${t()}`, materialName: other }, buyer)));
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
});

test('STK-18: a sheet\'s total row is never a material; a name that only begins with "Total" is', async () => {
  for (const n of ['TOTAL (g)', 'Total', 'Grand total:', 'Subtotal']) {
    await assert.rejects(() => materials.createMaterial({ materialCode: `S18-${t()}`, materialName: n }, buyer), BadRequestException, n);
  }
  await assert.doesNotReject(() => materials.createMaterial({ materialCode: `S18-${t()}`, materialName: `Totarol probe ${t()}` }, buyer));
});

test('STK-18: a hazard class is stored only with its source; without one it is refused, and none is "pending"', async () => {
  assert.equal(createMaterial.safeParse({ materialCode: 'X', materialName: 'Y', hazardClass: '3' }).success, false);
  assert.equal(createMaterial.safeParse({ materialCode: 'X', materialName: 'Y', hazardClass: '3.5', hazardSource: 'SDS' }).success, false);
  const m = await materials.createMaterial(createMaterial.parse({ materialCode: `S18-${t()}`, materialName: `Probe solvent ${t()}`, hazardClass: '3', hazardSource: 'Supplier SDS rev 4, section 14' }), buyer);
  assert.deepEqual([m.hazardClass, m.hazardSource], ['3', 'Supplier SDS rev 4, section 14']);
  const plain = await materials.createMaterial({ materialCode: `S18-${t()}`, materialName: `Probe resin ${t()}` }, buyer);
  assert.equal(plain.hazardClass, null);
  await assert.rejects(() => sql()`update masterdata.material set hazard_class = '3' where material_id = ${plain.materialId}`, /material_hazard_class_chk/);
});

/* ── STK-17 ───────────────────────────────────────────────────────────────────────────────── */

test('STK-17: the dry run reports every problem and writes nothing; total rows, repeats, spellings, codes, families, CAS', async () => {
  const fam = await family();
  const x = t();
  const taken = await materials.createMaterial({ materialCode: `S17-${x}`, materialName: `Probe Musk ${x}` }, buyer);
  const csv = [
    'material_name,material_code,family,cas,hazard_class,hazard_source',
    `Probe Citral ${x},,${fam},5392-40-5,,`,
    `  probe   citral ${x.toLowerCase()} ,,,,,`, // the same name again
    `Probe Citrall ${x},,,,,`, // one letter more
    `TOTAL (g),,,,,`, // the sheet's total row
    `Probe Musk ${x},,,,,`, // already on file: that material, not an error (STK-30)
    `Probe Vetiver ${x},${taken.materialCode},,,,`, // a code taken
    `Probe Iris ${x},,no_such_family,,,`,
    `Probe Rose ${x},,,5392-40-4,,`, // bad check digit
    `Probe Fir ${x},,,,3,`, // class with no source
    `Total Probe Blend ${x},,,,,`, // begins with Total: a warning only
  ].join('\n');
  const before = (await sql()`select count(*)::int as n from masterdata.material`)[0]!.n;
  const r = await importer.import({ csv }, buyer);
  assert.equal(r.committed, false);
  const at = (line: number) => r.rows.find((x) => x.line === line)!;
  assert.deepEqual(at(2).errors, []);
  assert.match(at(3).errors.join(), /same material as line 2/);
  assert.match(at(4).warnings.join(), /one letter from line 2/);
  assert.match(at(5).errors.join(), /total row/);
  assert.deepEqual(at(6).errors, [], 'STK-30: a name on file is that material; it no longer refuses the file');
  assert.equal(at(6).onFile?.materialCode, taken.materialCode);
  assert.match(at(7).errors.join(), /already on file/);
  assert.match(at(8).errors.join(), /no floor family/);
  assert.match(at(9).errors.join(), /not a CAS number/);
  assert.match(at(10).errors.join(), /needs its source/);
  assert.deepEqual(at(11).errors, []);
  assert.match(at(11).warnings.join(), /begins with "Total"/);
  // commit is refused while there are errors, and the dry run wrote nothing.
  const refused = await importer.import({ csv, commit: true }, buyer);
  assert.equal(refused.committed, false);
  assert.equal((await sql()`select count(*)::int as n from masterdata.material`)[0]!.n, before);
});

test('STK-17 + STK-19: a clean file commits in one go: codes minted in order, floor codes filed in order', async () => {
  const fam = await family();
  const x = t();
  const csv = `material_name\tfamily\tcas\nProbe Linalyl ${x}\t${fam}\t115-95-7\nProbe Ambrette ${x}\t${fam}\t\nProbe Benzoin ${x}\t\t\n`;
  const r = await importer.import({ csv, commit: true }, buyer);
  assert.equal(r.committed, true, JSON.stringify(r.rows));
  assert.equal(r.created.length, 3);
  const nums = r.created.map((c) => Number(c.materialCode.slice(3)));
  assert.ok(r.created.every((c) => /^RM-\d{5}$/.test(c.materialCode)));
  assert.deepEqual(nums, [nums[0], nums[0]! + 1, nums[0]! + 2], 'minted in order');
  assert.deepEqual(r.created.map((c) => c.floorCode?.slice(-4) ?? null), ['0001', '0002', null]);
  const outbox = await sql()`select count(*)::int as n from masterdata.outbox where type = 'masterdata.material.created' and aggregate_id = any(${r.created.map((c) => c.materialId)}::uuid[])`;
  assert.equal(outbox[0]!.n, 3, 'each material announced as MaterialService does');
  // The same file again: every name is on file, so every row is named as the material it is and nothing is
  // made (STK-30; it used to be three errors, which also refused any file that overlapped the master).
  const again = await importer.import({ csv }, buyer);
  assert.equal(again.rows.filter((x) => x.onFile !== null).length, 3);
  assert.equal(again.errorCount, 0);
});

/* ── STK-30 (STOCK-E2E-2, the joint run) ──────────────────────────────────────────────────────── */

test('STK-30: a name already on file is that material, named and left alone, and the rest of the file is imported', async () => {
  // Production's factory already holds the materials Alembic's catalogue sent it. A sheet of raw materials that
  // names one of them was refused WHOLE ("already on file"), so not one of its other rows could be loaded.
  const fam = await family();
  const x = t();
  const held = await materials.createMaterial({ materialCode: `S30-${x}`, materialName: `Probe Alpha ${x}` }, buyer);
  const csv = [
    'material_name,material_code,family',
    `Probe Alpha ${x},,${fam}`, // on file: nothing to make, and it gets the floor code it lacked
    `Probe Beta ${x},,${fam}`,
    `Probe Gamma ${x},,`,
  ].join('\n');
  const dry = await importer.import({ csv }, buyer);
  assert.equal(dry.errorCount, 0, JSON.stringify(dry.rows));
  assert.equal(dry.rows[0]!.onFile?.materialCode, held.materialCode, 'the dry run names the material it found');
  assert.equal(dry.rows[1]!.onFile, null);
  const before = (await sql()`select count(*)::int as n from masterdata.material`)[0]!.n;
  const r = await importer.import({ csv, commit: true }, buyer);
  assert.equal(r.committed, true, JSON.stringify(r.rows));
  assert.deepEqual(r.created.map((c) => c.line), [3, 4]);
  assert.deepEqual(r.existing.map((e) => [e.line, e.materialId, e.materialCode]), [[2, held.materialId, held.materialCode]]);
  assert.match(r.existing[0]!.floorCode ?? '', /-0001$/, 'the material on file had no floor code, the row names its family, so it is filed first');
  assert.match(r.created[0]!.floorCode ?? '', /-0002$/);
  assert.equal((await sql()`select count(*)::int as n from masterdata.material`)[0]!.n, before + 2, 'never a second material of the same name');
  // The same file again changes nothing, and says so.
  const again = await importer.import({ csv, commit: true }, buyer);
  assert.equal(again.committed, true);
  assert.equal(again.created.length, 0);
  assert.equal(again.existing.length, 3);
  assert.equal(again.existing[0]!.floorCode, r.existing[0]!.floorCode, 'a floor code on file is kept');
  assert.equal((await sql()`select count(*)::int as n from masterdata.material`)[0]!.n, before + 2);
  // A row that gives the material on file ANOTHER code is a contradiction, and still refuses the file.
  const other = await importer.import({ csv: `material_name,material_code\nProbe Alpha ${x},S30-OTHER-${x}\n`, commit: true }, buyer);
  assert.equal(other.committed, false);
  assert.match(other.rows[0]!.errors.join(), /already on file as S30-/);
});

test('CAS check digit', () => {
  assert.equal(casValid('7732-18-5'), true); // water
  assert.equal(casValid('115-95-7'), true);
  assert.equal(casValid('7732-18-4'), false);
  assert.equal(casValid('77-32-185'), false);
});

/* ── STK-19 ───────────────────────────────────────────────────────────────────────────────── */

test('STK-19: the migration seeds the nine D-2 families, Signal among them, and leaves a family or colour on file alone', async () => {
  const path = fileURLToPath(new URL('../../../../scripts/migrations/2026-11-23-stk-materials.sql', import.meta.url));
  const block = splitByTarget(readFileSync(path, 'utf8')).find((b) => b.target === 'main')!.sql;
  const sqlc = sql();
  const reserved = sqlc.reserve ? await sqlc.reserve() : sqlc;
  try {
    await reserved`begin`;
    await reserved.unsafe(block);
    await reserved.unsafe(block); // idempotent
    const fams = await reserved<{ family_code: string; colour_name: string; colour_hex: string; initial: string }[]>`
      select family_code, colour_name, colour_hex, initial from masterdata.floor_family_colour
       where family_code in ('citrus', 'woody', 'musk', 'floral', 'aldehydic', 'spicy', 'amber', 'aquatic', 'solvent') order by family_code`;
    const sig = fams.find((f) => f.family_code === 'solvent');
    if (sig) assert.deepEqual([sig.colour_name, sig.colour_hex, sig.initial], ['Signal', '#2F5DFF', 'S']);
    const colours = (await reserved<{ c: string }[]>`select upper(colour_name) as c from masterdata.floor_family_colour`).map((x) => x.c);
    for (const c of ['YELLOW', 'BROWN', 'GREY', 'PINK', 'WHITE', 'RED', 'ORANGE', 'TEAL', 'SIGNAL']) assert.ok(colours.includes(c), c);
  } finally {
    await reserved`rollback`;
    if ('release' in reserved) (reserved as { release: () => void }).release();
  }
});
