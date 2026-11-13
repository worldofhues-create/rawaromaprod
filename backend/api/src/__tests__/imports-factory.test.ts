/**
 * IMPORT-RP — the factory's bulk imports against a real Postgres, through the real single-record
 * services. Every name, code, lot and figure here is made up.
 *
 * What is proved for the mechanism (on the ingredients kind): the template reads back; a preview
 * writes only the job; a commit writes through the single-record functions; the same file again
 * changes nothing; a corrected file skips what is already in; a file with bad rows names every
 * problem, is refused whole by default and imports its good rows only when that is chosen; the
 * rows-to-fix sheet is the person's own rows plus a Problem column; a file changed since the preview
 * is refused; another person cannot see or commit the job; a person without the kind's permission is
 * refused. Then each other kind's own rules.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as masterdataSchema from '@ra/data-masterdata';
import { ImportEngine, readImportFile, templateXlsx, toCsv, writeWorkbook, type ImportKindHandler, type ImportJobResult } from '@core/backend-kernel';
import { DilutionService } from '../../../cluster-masterdata/src/material/dilution.service.js';
import { FloorCodeService } from '../floor/floor-code.service.js';
import { MaterialImportService } from '../floor/material-import.service.js';
import { factoryKinds, findUom, gstinValid } from '../imports/factory-kinds.js';
import { FACTORY_IMPORT_SPECS, INGREDIENTS } from '../imports/kind-specs.js';
import { PurchasePriceService } from '../imports/purchase-price.service.js';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';

const sql = () => testClient();
const t = () => crypto.randomUUID().slice(0, 6).toUpperCase();
const ALL = FACTORY_IMPORT_SPECS.map((s) => s.permission);
const buyer = principal({ userId: '00000000-0000-7000-8000-0000000000a1', roles: ['owner'], permissions: ALL });
const other = principal({ userId: '00000000-0000-7000-8000-0000000000a2', roles: ['owner'], permissions: ALL });
const picker = principal({ userId: '00000000-0000-7000-8000-0000000000a3', roles: ['picker'], permissions: [] });
const today = '2026-11-13';
const ctx = (p = buyer) => ({ principal: p, today });
const csv = (rows: string[][]) => Buffer.from(toCsv(rows), 'utf8');
const xlsx = (rows: string[][]) => writeWorkbook([{ name: 'Data', rows }]);
const count = async (table: string) => Number((await sql().unsafe(`select count(*)::int as n from ${table}`))[0]!.n);
const rowOf = (r: ImportJobResult, n: number) => r.rows.find((x) => x.row === n)!;
const refused = async (fn: () => Promise<unknown>, status: number, re: RegExp) => {
  await assert.rejects(fn, (err: { status?: number; message?: string }) => { assert.equal(err.status, status); assert.match(String(err.message), re); return true; });
};

let engine: ImportEngine;
let codes: FloorCodeService;
let family: string;

before(async () => {
  await ensureSchema();
  codes = new FloorCodeService(sql());
  engine = new ImportEngine(sql(), 'platform', factoryKinds(sql(), new MaterialImportService(sql(), codes), new PurchasePriceService(sql())));
  drizzle(sql(), { schema: masterdataSchema }); // as the cluster module does at boot: dates come back as text
  for (const u of ['kg', 'g', 'ml']) await sql()`insert into platform.uom_master (uom_code, uom_name, status) values (${u}, ${u}, 'ACTIVE') on conflict (uom_code) do nothing`;
  family = `fam_${t().toLowerCase()}`;
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  await codes.setFamily({ familyCode: family, familyName: `Family ${family}`, colourName: `Tone${letters}`, colourHex: '#2F5DFF' }, buyer);
});
after(closeTestClient);

/** Import a clean file of this kind and return the commit's result. */
async function run(kind: string, rows: string[][], p = buyer): Promise<ImportJobResult> {
  const bytes = csv(rows);
  const pre = await engine.preview(kind, { bytes, fileName: `${kind}.csv` }, ctx(p));
  assert.deepEqual(pre.job.fileProblems, []);
  assert.equal(pre.commitRefusal.all_or_nothing, null, JSON.stringify(pre.rows.filter((r) => r.problems.length)));
  return engine.commit(pre.job.importJobId, { bytes }, ctx(p));
}
async function makeSupplier(): Promise<{ code: string; name: string }> {
  const s = { code: `SUP-${t()}`, name: `Made-up Aromatics ${t()}` };
  await run('suppliers', [['Supplier code', 'Name'], [s.code, s.name]]);
  return s;
}
async function makeIngredients(n: number, unit = 'kg'): Promise<string[]> {
  const made = Array.from({ length: n }, () => `ING-${t()}`);
  await run('ingredients', [['Code', 'Name', 'Unit'], ...made.map((c) => [c, `Made-up material ${c}`, unit])]);
  return made;
}

/* ── the mechanism, on ingredients ────────────────────────────────────────────────────────── */

test('every template opens, carries its own header and one example row, and the example row is refused by name', async () => {
  for (const spec of FACTORY_IMPORT_SPECS) {
    const d = engine.template(spec.kind, 'xlsx', buyer);
    assert.equal(d.fileName, `${spec.kind}-template.xlsx`);
    const file = readImportFile(Buffer.from(d.base64, 'base64'));
    assert.equal(file.ok, true, spec.kind);
    if (file.ok) assert.deepEqual(file.table[0], spec.columns.map((c) => c.header), spec.kind);
    // The template uploaded as it is: its one row is the example, refused in words, and nothing can be committed.
    const pre = await engine.preview(spec.kind, { bytes: Buffer.from(d.base64, 'base64'), fileName: d.fileName }, ctx());
    assert.equal(pre.rows.length, 1, spec.kind);
    assert.equal(pre.rows[0]!.outcome, 'refuse', spec.kind);
    assert.match(pre.rows[0]!.problems[0]!, /template's example row/, spec.kind);
    assert.ok(pre.commitRefusal.valid_only, spec.kind);
    assert.equal(engine.template(spec.kind, 'csv', buyer).fileName, `${spec.kind}-template.csv`);
  }
  assert.equal(templateXlsx(INGREDIENTS).length > 1000, true);
});

test('no two columns of a kind answer to the same header: a name or another name, once folded, belongs to one column', () => {
  const fold = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const spec of FACTORY_IMPORT_SPECS) {
    const owner = new Map<string, string>();
    for (const c of spec.columns) for (const name of [c.header, c.key, ...c.aliases]) {
      const f = fold(name);
      assert.ok(!owner.has(f) || owner.get(f) === c.key, `${spec.kind}: "${name}" is claimed by ${owner.get(f)} and ${c.key}`);
      owner.set(f, c.key);
    }
    assert.ok(spec.columns.some((c) => c.key === spec.exampleKey && c.example), `${spec.kind}: the example row is marked by a filled column`);
  }
});

test('ingredients: preview writes nothing but the job; commit writes through the single-record functions; the same file again changes nothing', async () => {
  const supplier = await makeSupplier();
  const x = t();
  const rows = [
    ['Name', 'Code', 'Family', 'CAS number', 'Unit', 'Default supplier', 'Hazard class', 'Hazard source', 'Density (g per ml)', 'Density source', 'My notes'],
    [`Madeupyl acetate ${x}`, '', family, '64-17-5', 'kg', supplier.code, '3', 'SDS rev 4, 02/2026', '0.985', 'CoA lot 7', 'keep cool'],
    [`Inventone ${x}`, `IV-${x}`, '', '', 'kg', '', '', '', '', '', ''],
    [`Fabricol ${x}`, '', family, '', '', '', '', '', '', '', ''],
  ];
  const bytes = xlsx(rows);
  const before = { materials: await count('masterdata.material'), jobs: await count('platform.import_job'), outbox: await count('masterdata.outbox') };

  const pre = await engine.preview('ingredients', { bytes, fileName: 'my ingredients.xlsx' }, ctx());
  assert.equal(pre.job.status, 'previewed');
  assert.equal(pre.job.fileFormat, 'xlsx');
  assert.deepEqual(pre.job.counts, { rows: 3, create: 3, update: 0, skip: 0, refuse: 0 });
  assert.deepEqual(pre.job.ignoredColumns, ['My notes']);
  assert.equal(await count('masterdata.material'), before.materials, 'a preview writes no material');
  assert.equal(await count('masterdata.outbox'), before.outbox, 'a preview emits nothing');
  assert.equal(await count('platform.import_job'), before.jobs + 1);
  // A row that will import keeps no cells on the job.
  const kept = await sql()`select cells from platform.import_job_row where import_job_id = ${pre.job.importJobId}`;
  assert.equal(kept.length, 3);
  assert.equal(kept.every((k) => k.cells === null), true);

  const done = await engine.commit(pre.job.importJobId, { bytes }, ctx());
  assert.equal(done.job.status, 'committed');
  assert.equal(done.job.mode, 'all_or_nothing');
  assert.deepEqual(done.job.written, { rows: 3, create: 3, update: 0, skip: 0, refuse: 0 });
  assert.equal(done.job.committedBy, buyer.userId);
  const made = await sql()`select material_code, material_name, cas_number, hazard_class, hazard_source, density::text as density, density_source, uom_id, created_by
                             from masterdata.material where material_name like ${'%' + x} order by material_id`;
  assert.equal(made.length, 3);
  const [a, b, c] = made;
  assert.match(a!.material_code, /^RM-\d{5}$/);
  assert.equal(b!.material_code, `IV-${x}`);
  assert.equal(Number(c!.material_code.slice(3)), Number(a!.material_code.slice(3)) + 1, 'minted codes are taken in order');
  assert.deepEqual([a!.cas_number, a!.hazard_class, a!.hazard_source, Number(a!.density), a!.density_source], ['64-17-5', '3', 'SDS rev 4, 02/2026', 0.985, 'CoA lot 7']);
  assert.deepEqual([c!.hazard_class, c!.hazard_source, c!.density, c!.density_source], [null, null, null, null], 'an empty regulatory cell stays empty');
  assert.equal(a!.created_by, buyer.userId);
  // Written by createMaterial: one material.created event each, as POST /v1/materials emits.
  assert.equal(await count('masterdata.outbox'), before.outbox + 3);
  // The floor codes, in order within the family; the supplier link.
  const fc = await sql()`select c.number from masterdata.floor_code c join masterdata.material m on m.material_id = c.material_id where m.material_name like ${'%' + x} order by c.number`;
  assert.equal(fc.length, 2);
  assert.equal(fc[1]!.number, fc[0]!.number + 1);
  const link = await sql()`select vm.is_preferred from procurement.vendor_rm_mapping vm join masterdata.material m on m.material_id = vm.material_id where m.material_name = ${`Madeupyl acetate ${x}`}`;
  assert.deepEqual(link.map((l) => l.is_preferred), [true]);

  // The same file again: answered with the import it already was. Nothing is read, nothing is written.
  const after = { materials: await count('masterdata.material'), jobs: await count('platform.import_job') };
  const again = await engine.preview('ingredients', { bytes, fileName: 'my ingredients.xlsx' }, ctx());
  assert.equal(again.alreadyImported, true);
  assert.equal(again.job.importJobId, done.job.importJobId);
  assert.match(again.commitRefusal.valid_only!, /already imported/);
  const replay = await engine.commit(done.job.importJobId, { bytes }, ctx());
  assert.equal(replay.alreadyImported, true);
  assert.deepEqual({ materials: await count('masterdata.material'), jobs: await count('platform.import_job') }, after);

  // A corrected file (new bytes, the same three rows and one new one): the three are skipped by name.
  const fixed = csv([...rows.map((r) => r.slice(0, 10)), [`Newcomerol ${x}`, '', '', '', '', '', '', '', '', '']]);
  const pre2 = await engine.preview('ingredients', { bytes: fixed, fileName: 'fixed.csv' }, ctx());
  assert.deepEqual(pre2.job.counts, { rows: 4, create: 1, update: 0, skip: 3, refuse: 0 });
  assert.match(rowOf(pre2, 2).problems[0]!, /Already on file as RM-\d{5}/);
  const done2 = await engine.commit(pre2.job.importJobId, { bytes: fixed }, ctx());
  assert.deepEqual(done2.job.written, { rows: 4, create: 1, update: 0, skip: 3, refuse: 0 });
  assert.equal(await count('masterdata.material'), after.materials + 1);
});

test('ingredients: a file with bad rows names every problem; all-or-nothing refuses it; the rows-to-fix sheet; valid rows only', async () => {
  const x = t();
  const rows = [
    ['Code', 'Name', 'Family', 'CAS number', 'Unit', 'Default supplier', 'Hazard class', 'Hazard source', 'Density (g per ml)', 'Density source'],
    ['', `Goodanol ${x}`, '', '', '', '', '', '', '', ''],
    ['', 'TOTAL (g)', '', '', '', '', '', '', '', ''],
    ['', `Badcasol ${x}`, 'nofamily', '64-17-6', 'barrel', 'Nobody Ltd', '3', '', '9.9', ''],
    ['', `goodanol  ${x}`.toUpperCase(), '', '', '', '', '', '', '', ''],
    ['', `Heavyol ${x}`, '', '', '', '', '', 'SDS rev 1', '', 'CoA 3'],
    ['', '=1+1', '', '', '', '', '', '', '', ''],
  ];
  // A formula in a CSV cell refuses the whole file, in words.
  const withFormula = await engine.preview('ingredients', { bytes: csv(rows), fileName: 'bad.csv' }, ctx());
  assert.equal(withFormula.job.status, 'refused');
  assert.match(withFormula.job.fileProblems[0]!, /Row 7, "Name": the cell holds a formula/);
  await refused(() => engine.commit(withFormula.job.importJobId, { bytes: csv(rows) }, ctx()), 409, /refused when it was read/);

  const bytes = csv(rows.slice(0, 6));
  const before = await count('masterdata.material');
  const pre = await engine.preview('ingredients', { bytes, fileName: 'bad.csv' }, ctx());
  assert.deepEqual(pre.job.counts, { rows: 5, create: 1, update: 0, skip: 0, refuse: 4 });
  assert.match(rowOf(pre, 3).problems.join(' '), /sheet's total row, not a material/);
  const bad = rowOf(pre, 4).problems.join(' ');
  for (const re of [/No floor family "nofamily"/, /64-17-6 is not a CAS number/, /needs its source/, /unit "barrel" is not in the unit list/, /No supplier "Nobody Ltd" on file/, /density of 9\.9 g\/ml is outside 0\.3 to 2\.5/, /A density needs its source/]) assert.match(bad, re);
  assert.match(rowOf(pre, 5).problems.join(' '), /The same material as line 2/);
  assert.match(rowOf(pre, 6).problems.join(' '), /hazard source is given with no hazard class/);
  assert.match(rowOf(pre, 6).problems.join(' '), /density source is given with no density/);
  assert.match(pre.commitRefusal.all_or_nothing!, /4 rows have a problem, so nothing is imported/);
  assert.equal(pre.commitRefusal.valid_only, null);
  await refused(() => engine.commit(pre.job.importJobId, { bytes }, ctx()), 409, /4 rows have a problem, so nothing is imported/);
  assert.equal(await count('masterdata.material'), before, 'all or nothing: nothing was written');

  // The rows to fix: the person's own refused rows, in the template's columns, plus a Problem column.
  const sheet = await engine.problems(pre.job.importJobId, { format: 'xlsx' }, ctx());
  const back = readImportFile(Buffer.from(sheet.base64, 'base64'));
  assert.equal(back.ok, true);
  if (back.ok) {
    assert.deepEqual(back.table[0], [...INGREDIENTS.columns.map((c) => c.header), 'Problem']);
    assert.equal(back.table.length, 5);
    assert.equal(back.table[2]![1], `Badcasol ${x}`);
    assert.match(back.table[2]![10]!, /not a CAS number/);
    // Fixed and uploaded as it is: the Problem column is read past.
    const fixedRows = back.table.map((r) => [...r]);
    const again = await engine.preview('ingredients', { bytes: xlsx(fixedRows), fileName: 'fixed.xlsx' }, ctx());
    assert.deepEqual(again.job.ignoredColumns, []);
    assert.equal(again.rows.length, 4);
  }
  const asCsv = await engine.problems(pre.job.importJobId, { format: 'csv' }, ctx());
  assert.match(Buffer.from(asCsv.base64, 'base64').toString('utf8'), /Problem\r\n/);

  // Valid rows only is a choice, sent with the commit and recorded.
  const done = await engine.commit(pre.job.importJobId, { bytes, mode: 'valid_only' }, ctx());
  assert.equal(done.job.mode, 'valid_only');
  assert.deepEqual(done.job.written, { rows: 5, create: 1, update: 0, skip: 0, refuse: 4 });
  assert.equal(await count('masterdata.material'), before + 1);
  // The commit added its own rows; the preview's rows are still there (append-only).
  const phases = await sql()`select phase, count(*)::int as n from platform.import_job_row where import_job_id = ${pre.job.importJobId} group by 1 order by 1`;
  assert.deepEqual(phases.map((p) => [p.phase, p.n]), [['commit', 5], ['preview', 5]]);
  await refused(() => engine.commit(pre.job.importJobId, { bytes, mode: 'sometimes' }, ctx()), 422, /all or nothing/);
});

test('a file changed since the preview is refused; another person cannot see or commit the job; a person without the permission is refused', async () => {
  const x = t();
  const rows = [['Code', 'Name'], ['', `Privatol ${x}`]];
  const bytes = csv(rows);
  const pre = await engine.preview('ingredients', { bytes, fileName: 'p.csv' }, ctx());
  const before = await count('masterdata.material');
  await refused(() => engine.commit(pre.job.importJobId, { bytes: csv([['Code', 'Name'], ['', `Swappedol ${x}`]]) }, ctx()), 409, /not the file that was previewed/);
  assert.equal(await count('masterdata.material'), before);

  // Another person who holds the same permission: the job is not theirs to read, commit or take rows from.
  await refused(() => engine.job(pre.job.importJobId, other), 404, /No such import/);
  await refused(() => engine.commit(pre.job.importJobId, { bytes }, ctx(other)), 404, /No such import/);
  await refused(() => engine.problems(pre.job.importJobId, {}, ctx(other)), 404, /No such import/);
  // They do see it in the history of the kind (who, when, counts) and nothing of its rows.
  const hist = await engine.history(other, 'ingredients', 200);
  const mine = hist.find((j) => j.importJobId === pre.job.importJobId);
  assert.equal(mine?.uploadedBy, buyer.userId);
  assert.equal(Object.keys(mine!).some((k) => /row|cell/i.test(k)), false);

  // No permission: no template, no preview, no kinds, no history.
  assert.deepEqual(engine.kindsFor(picker), []);
  assert.throws(() => engine.template('ingredients', 'xlsx', picker), (e: { status?: number }) => e.status === 403);
  await refused(() => engine.preview('ingredients', { bytes }, ctx(picker)), 403, /may not import ingredients/);
  assert.deepEqual(await engine.history(picker), []);
  // One kind's permission opens that kind and no other.
  const onlySuppliers = principal({ userId: other.userId, permissions: ['procurement:vendor_import:write'] });
  assert.deepEqual(engine.kindsFor(onlySuppliers).map((s) => s.kind), ['suppliers']);
  await refused(() => engine.preview('ingredients', { bytes }, ctx(onlySuppliers)), 403, /may not import ingredients/);
  await refused(() => engine.preview('no-such-kind', { bytes }, ctx()), 404, /no import called/);
  assert.equal(await count('masterdata.material'), before);
  // Two people preview the same file; the first commits. The second is told it is in, and is not handed the first one's rows.
  const theirs = await engine.preview('ingredients', { bytes, fileName: 'p.csv' }, ctx(other));
  assert.equal((await engine.commit(pre.job.importJobId, { bytes }, ctx())).job.status, 'committed');
  const late = await engine.commit(theirs.job.importJobId, { bytes }, ctx(other));
  assert.deepEqual([late.alreadyImported, late.job.importJobId, late.rows.length], [true, pre.job.importJobId, 0]);
  const again = await engine.preview('ingredients', { bytes }, ctx(other));
  assert.deepEqual([again.alreadyImported, again.rows.length], [true, 0]);
  assert.equal(await count('masterdata.material'), before + 1);
});

test('one transaction: a row that fails when written undoes the whole import by default, and only itself under valid rows only', async () => {
  await sql().unsafe('create table if not exists public._imprp_things (code text primary key)');
  const fake: ImportKindHandler<{ code: string }> = {
    spec: { kind: 'things', title: 'Things', permission: 'x:thing_import:write', mirrors: [], exampleKey: 'code', instructions: [], naturalKey: 'Code', rule: '', refuses: [],
      columns: [{ key: 'code', header: 'Code', aliases: [], required: true, help: '', example: 'EXAMPLE' }] },
    async plan(rows) { return rows.map((r) => ({ row: r.row, outcome: 'create', naturalKey: r.values.code!, label: r.values.code!, problems: [], notes: [], input: { code: r.values.code! }, cells: r.cells })); },
    async writeUnit(tx, rows) {
      for (const r of rows) {
        await tx`insert into public._imprp_things (code) values (${r.input!.code})`;
        if (r.input!.code.startsWith('BOOM')) await tx`insert into public._imprp_things (code) values (${r.input!.code})`; // a unique violation, after a first write
      }
    },
  };
  const eng = new ImportEngine(sql(), 'platform', [fake as ImportKindHandler]);
  const who = principal({ userId: buyer.userId, permissions: ['x:thing_import:write'] });
  const x = t();
  const bytes = csv([['Code'], [`A-${x}`], [`BOOM-${x}`], [`C-${x}`]]);
  const pre = await eng.preview('things', { bytes }, { principal: who, today });
  assert.deepEqual(pre.job.counts, { rows: 3, create: 3, update: 0, skip: 0, refuse: 0 });
  await refused(() => eng.commit(pre.job.importJobId, { bytes }, { principal: who, today }), 409, /Row 3: .*Nothing was imported/);
  assert.equal((await sql()`select count(*)::int as n from public._imprp_things where code like ${'%' + x}`)[0]!.n, 0, 'all or nothing: A was rolled back with BOOM');
  assert.equal((await eng.job(pre.job.importJobId, who)).job.status, 'previewed');

  const done = await eng.commit(pre.job.importJobId, { bytes, mode: 'valid_only' }, { principal: who, today });
  assert.deepEqual(done.job.written, { rows: 3, create: 2, update: 0, skip: 0, refuse: 1 });
  assert.deepEqual((await sql()`select code from public._imprp_things where code like ${'%' + x} order by code`).map((r) => r.code), [`A-${x}`, `C-${x}`]);
  assert.match(rowOf(done, 3).problems.join(' '), /same code or key was added/);
});

test('a unit is read as written; one that differs only in capitals is taken when it is the only one, and never picked between two', () => {
  const list = [{ id: '1', code: 'kg' }, { id: '2', code: 'KG' }, { id: '3', code: 'Ltr' }];
  assert.deepEqual(findUom(list, 'kg'), { id: '1', code: 'kg' });
  assert.deepEqual(findUom(list, ' KG '), { id: '2', code: 'KG' });
  assert.deepEqual(findUom(list, 'ltr'), { id: '3', code: 'Ltr' });
  assert.match(String(findUom(list, 'Kg')), /matches 2 units that differ only in capitals \(kg, KG\)/);
  assert.match(String(findUom(list, 'barrel')), /is not in the unit list/);
});

/* ── suppliers ────────────────────────────────────────────────────────────────────────────── */

test('suppliers: created through the vendor service; a supplier on file is skipped; a bad GSTIN, PAN or email is refused', async () => {
  assert.equal(gstinValid('27AAPFU0939F1ZV'), true);
  assert.equal(gstinValid('27AAPFU0939F1ZW'), false);
  assert.equal(gstinValid('27AAPFU0939F1Z'), false);
  const x = t();
  const head = ['Supplier code', 'Name', 'GSTIN', 'PAN', 'Payment terms', 'Email', 'Phone'];
  const done = await run('suppliers', [head, [`V-${x}`, `Imagined Essences ${x}`, '27AAPFU0939F1ZV', 'AAPFU0939F', 'Net 30', 'orders@example.test', '+91 98765 43210'], ['', `Codeless Oils ${x}`, '', '', '', '', '']]);
  assert.deepEqual(done.job.written, { rows: 2, create: 2, update: 0, skip: 0, refuse: 0 });
  const made = await sql()`select vendor_code, gstin, pan_number, payment_terms, contact_email, status from procurement.vendor_details where vendor_name like ${'%' + x} order by vendor_name`;
  assert.equal(made.length, 2);
  assert.match(made[0]!.vendor_code, /^VEN-/, 'a blank code is given by the service, as on the form');
  assert.deepEqual([made[1]!.vendor_code, made[1]!.gstin, made[1]!.pan_number, made[1]!.payment_terms, made[1]!.status], [`V-${x}`, '27AAPFU0939F1ZV', 'AAPFU0939F', 'Net 30', 'ACTIVE']);

  const pre = await engine.preview('suppliers', { bytes: csv([head,
    [`V-${x}`, `imagined essences ${x}`, '', '', '', '', ''],
    [`V-${x}`, `Somebody Else ${x}`, '', '', '', '', ''],
    ['', `Wrongnumber Traders ${x}`, '27AAPFU0939F1ZW', 'AAPFU0939', '', 'not-an-email', ''],
    ['', '', '', '', '', '', 'x'],
  ]) }, ctx());
  assert.equal(rowOf(pre, 2).outcome, 'skip');
  assert.match(rowOf(pre, 3).problems.join(' '), /also on row 2.*belongs to another supplier/);
  const bad = rowOf(pre, 4).problems.join(' ');
  for (const re of [/is not a GSTIN/, /is not a PAN/, /is not an email/]) assert.match(bad, re);
  assert.match(rowOf(pre, 5).problems.join(' '), /"Name" is empty/);
});

/* ── supplier lots ────────────────────────────────────────────────────────────────────────── */

test('supplier lots: one receipt per supplier and day through GrnService; every lot is born in quarantine with its supplier lot, dates and certificate', async () => {
  const s1 = await makeSupplier(), s2 = await makeSupplier();
  const [a, b] = await makeIngredients(2);
  const x = t();
  const head = ['Ingredient code', 'Supplier', 'Supplier lot', 'Quantity', 'Unit', 'Received date', 'Manufacture date', 'Expiry date', 'Certificate reference'];
  const rows = [head,
    [a!, s1.code, `LOT-${x}-1`, '25', 'kg', '10/11/2026', '01/06/2026', '2028-06-01', `COA-${x}`],
    [b!, s1.name, `LOT-${x}-2`, '500', 'g', '10/11/2026', '', '', ''],
    [a!, s2.code, `LOT-${x}-3`, '1.2500', 'kg', '46336', '', '', ''], // an Excel serial: 10 Nov 2026
  ];
  const grnsBefore = await count('inventory.grn_master'), liveBefore = await count('inventory.inventory_batch');
  const done = await run('supplier-lots', rows);
  assert.deepEqual(done.job.written, { rows: 3, create: 3, update: 0, skip: 0, refuse: 0 });
  assert.equal(await count('inventory.grn_master'), grnsBefore + 2, 'two suppliers on one day: two receipts');
  const lots = await sql()`select b.batch_number, b.status, b.supplier_lot_ref, b.certificate_ref, b.received_qty::text as qty, b.manufacturing_date::text as mfg, b.expiry_date::text as exp,
                                  g.grn_date::text as grn_date, u.uom_code
                             from inventory.rm_batch_master b join inventory.grn_items i on i.grn_item_id = b.grn_item_id join inventory.grn_master g on g.grn_id = i.grn_id
                             left join platform.uom_master u on u.uom_id = b.uom_id
                            where b.supplier_lot_ref like ${`LOT-${x}-%`} order by b.supplier_lot_ref`;
  assert.equal(lots.length, 3);
  assert.equal(lots.every((l) => l.status === 'QUARANTINE'), true, 'QC release stays a separate act by a person');
  assert.deepEqual([lots[0]!.supplier_lot_ref, lots[0]!.certificate_ref, Number(lots[0]!.qty), lots[0]!.uom_code], [`LOT-${x}-1`, `COA-${x}`, 25, 'kg']);
  assert.equal(lots[0]!.mfg.slice(0, 10), '2026-06-01');
  assert.equal(lots[0]!.exp.slice(0, 10), '2028-06-01');
  assert.equal(lots[0]!.grn_date.slice(0, 10), '2026-11-10');
  assert.deepEqual([lots[1]!.certificate_ref, lots[1]!.mfg, lots[1]!.exp], [null, null, null], 'a date or certificate not given stays null, never worked out');
  assert.equal(Number(lots[2]!.qty), 1.25);
  assert.equal(lots[2]!.grn_date.slice(0, 10), '2026-11-10');
  assert.equal(await count('inventory.inventory_batch'), liveBefore, 'nothing reached the live ledger');

  // A new file with one lot already received and the bad rows: each problem named.
  const pre = await engine.preview('supplier-lots', { bytes: csv([head,
    [a!, s1.code, `lot-${x}-1`.toUpperCase(), '25', 'kg', '10/11/2026', '', '', ''],
    ['NOPE-1', 'Nobody Ltd', `LOT-${x}-9`, '0', 'barrel', '14/11/2026', '', '', ''],
    [a!, s1.code, `LOT-${x}-8`, '3', 'ml', '09/11/2026', '10/11/2026', '01/11/2026', ''],
    [b!, s1.code, `LOT-${x}-7`, '2', 'kg', '11/13/2026', '', '', ''],
    [b!, s1.code, `LOT-${x}-6`, '2', '', '', '', '', ''],
    [b!, s2.code, `LOT-${x}-5`, '2', 'kg', '09/11/2026', '', '', ''],
    [b!, s2.code, `LOT-${x}-5`, '3', 'kg', '09/11/2026', '', '', ''],
  ]) }, ctx());
  assert.equal(rowOf(pre, 2).outcome, 'skip');
  assert.match(rowOf(pre, 2).problems[0]!, /Already received as lot RMB-/);
  const r3 = rowOf(pre, 3).problems.join(' ');
  for (const re of [/No ingredient with the code NOPE-1/, /No supplier "Nobody Ltd"/, /must be more than zero/, /unit "barrel" is not in the unit list/, /received date is in the future/]) assert.match(r3, re);
  const r4 = rowOf(pre, 4).problems.join(' ');
  for (const re of [/is kept in kg: ml and kg do not convert without a density/, /manufacture date is after the day it was received/, /expiry date is before the day it was received/]) assert.match(r4, re);
  assert.match(rowOf(pre, 5).problems.join(' '), /"Received date": "11\/13\/2026" is not a date/);
  assert.match(rowOf(pre, 6).problems.join(' '), /"Unit" is empty: a quantity needs its unit.*"Received date" is empty/);
  assert.equal(rowOf(pre, 7).outcome, 'create');
  assert.match(rowOf(pre, 8).problems.join(' '), /same ingredient, supplier and lot is on row 7/);
});

/* ── dilutions ────────────────────────────────────────────────────────────────────────────── */

test('dilutions: base and solvent must exist, the shares must total 100, and the sheet and the single-record route are one function', async () => {
  const [dil, base, solvent, dil2] = await makeIngredients(4);
  const head = ['Dilution code', 'Base ingredient', 'Solvent', 'Base percent', 'Solvent percent'];
  const done = await run('dilutions', [head, [dil!, base!, solvent!, '10', '90']]);
  assert.deepEqual(done.job.written, { rows: 1, create: 1, update: 0, skip: 0, refuse: 0 });
  const [row] = await sql()`select d.base_percent::text as bp, d.solvent_percent::text as sp, b.material_code as base, s.material_code as solvent
                              from masterdata.material_dilution d join masterdata.material m on m.material_id = d.dilution_material_id
                              join masterdata.material b on b.material_id = d.base_material_id join masterdata.material s on s.material_id = d.solvent_material_id
                             where m.material_code = ${dil!}`;
  assert.deepEqual([Number(row!.bp), Number(row!.sp), row!.base, row!.solvent], [10, 90, base, solvent]);

  const pre = await engine.preview('dilutions', { bytes: csv([head,
    [dil!, base!, solvent!, '10.0', '90%'],
    [dil!.toLowerCase(), base!, solvent!, '1', '99'],
    [dil2!, base!, solvent!, '10', '89.5'],
    [dil2!, 'NOPE-BASE', base!, '0.1', '99.9'],
    ['NOPE-DIL', base!, base!, '100', '0'],
    [base!, base!, solvent!, '50', '50'],
  ]) }, ctx());
  assert.equal(rowOf(pre, 2).outcome, 'skip');
  assert.match(rowOf(pre, 3).problems.join(' '), /also on row 2.*already on file as 10% .* A different ratio is a different material/);
  assert.match(rowOf(pre, 4).problems.join(' '), /shares add up to 99\.5%, not 100%/);
  assert.match(rowOf(pre, 5).problems.join(' '), /base NOPE-BASE is not an ingredient on file/);
  const r6 = rowOf(pre, 6).problems.join(' ');
  for (const re of [/No ingredient with the code NOPE-DIL/, /base and the solvent are the same ingredient/, /base share must be more than 0 and less than 100/]) assert.match(r6, re);
  assert.match(rowOf(pre, 7).problems.join(' '), /cannot be its own base/);

  // The same judgement on the single-record route's service: a ratio that does not total, and a second composition.
  const service = new DilutionService(drizzle(sql(), { schema: masterdataSchema }) as never);
  const id = async (code: string) => (await sql()`select material_id::text as id from masterdata.material where material_code = ${code}`)[0]!.id as string;
  const ids = { d: await id(dil!), b: await id(base!), s: await id(solvent!), d2: await id(dil2!) };
  await assert.rejects(() => service.createDilution({ dilutionMaterialId: ids.d2, baseMaterialId: ids.b, solventMaterialId: ids.s, basePercent: '10', solventPercent: '89.5' }, buyer), /shares add up to 99\.5%, not 100%/);
  await assert.rejects(() => service.createDilution({ dilutionMaterialId: ids.d, baseMaterialId: ids.b, solventMaterialId: ids.s, basePercent: '1', solventPercent: '99' }, buyer), /already on file as 10% .* different ratio is a different material/);
  await assert.rejects(() => service.createDilution({ dilutionMaterialId: ids.d2, baseMaterialId: ids.b, solventMaterialId: ids.b, basePercent: '10', solventPercent: '90' }, buyer), /same material/);
  const made = await service.createDilution({ dilutionMaterialId: ids.d2, baseMaterialId: ids.b, solventMaterialId: ids.s, basePercent: '0.1', solventPercent: '99.9' }, buyer);
  assert.equal(Number(made.basePercent), 0.1);
  assert.equal((await service.listDilutions({ limit: 100 })).items.some((v) => v.dilutionCode === dil2 && v.baseCode === base), true);
});

/* ── raw stock: opening and adjustments ───────────────────────────────────────────────────── */

test('opening raw stock: the lot is born in quarantine through the manual-lot service; its reason is kept on the import; a lot on file is skipped', async () => {
  const [a, b] = await makeIngredients(2);
  const x = t();
  const head = ['Ingredient code', 'Lot', 'Quantity', 'Unit', 'Reason', 'Location', 'Supplier lot', 'Manufacture date', 'Expiry date'];
  const liveBefore = await count('inventory.inventory_batch');
  const done = await run('raw-stock-opening', [head, [a!, `OPEN-${x}-1`, '12.5', 'kg', 'Opening balance at go-live, count of 12 Nov', '', `S-${x}`, '', '31/12/2027'], [b!, `OPEN-${x}-2`, '750', 'g', 'Opening balance at go-live', '', '', '', '']]);
  assert.deepEqual(done.job.written, { rows: 2, create: 2, update: 0, skip: 0, refuse: 0 });
  assert.match(rowOf(done, 2).notes.join(' '), /Reason: Opening balance at go-live, count of 12 Nov/);
  const lots = await sql()`select batch_number, status, received_qty::text as qty, supplier_lot_ref, expiry_date::text as exp, grn_item_id from inventory.rm_batch_master where batch_number like ${`OPEN-${x}-%`} order by batch_number`;
  assert.deepEqual(lots.map((l) => [l.status, Number(l.qty), l.supplier_lot_ref, l.grn_item_id]), [['QUARANTINE', 12.5, `S-${x}`, null], ['QUARANTINE', 750, null, null]]);
  assert.equal(lots[0]!.exp.slice(0, 10), '2027-12-31');
  assert.equal(await count('inventory.inventory_batch'), liveBefore, 'an opening lot is not stock until QC releases it');
  const events = await sql()`select e.event from inventory.lot_qc_event e join inventory.rm_batch_master b on b.rm_batch_id = e.rm_batch_id where b.batch_number = ${`OPEN-${x}-1`}`;
  assert.deepEqual(events.map((e) => e.event), ['QUARANTINED']);

  const pre = await engine.preview('raw-stock-opening', { bytes: csv([head,
    [a!, `open-${x}-1`, '12.5', 'kg', 'again', '', '', '', ''],
    [b!, `OPEN-${x}-1`, '1', 'kg', 'wrong ingredient', '', '', '', ''],
    [a!, `OPEN-${x}-3`, '-4', 'kg', '', 'NOWHERE-1', '', '01/01/2030', '01/01/2020'],
  ]) }, ctx());
  assert.equal(rowOf(pre, 2).outcome, 'skip');
  assert.match(rowOf(pre, 3).problems.join(' '), /already used for another ingredient/);
  const r4 = rowOf(pre, 4).problems.join(' ');
  for (const re of [/"Reason" is empty/, /must be more than zero/, /No storage location with the code NOWHERE-1/, /manufacture date is in the future/, /expiry date is not after the manufacture date/]) assert.match(r4, re);
});

test('raw stock adjustments: a ledger row through the adjustment service; below zero, a cut into a reservation, a lot held for QC and a wrong unit are refused', async () => {
  const [a, b] = await makeIngredients(2);
  const x = t();
  await run('raw-stock-opening', [['Ingredient code', 'Lot', 'Quantity', 'Unit', 'Reason'], [a!, `ADJ-${x}-1`, '10', 'kg', 'opening'], [a!, `ADJ-${x}-2`, '5', 'kg', 'opening'], [b!, `ADJ-${x}-3`, '5', 'kg', 'opening']]);
  // QC release is a person's act; here the released state is set up directly: lots 1 and 3 are live, lot 2 is still held.
  const [kg] = await sql()`select uom_id::text as id from platform.uom_master where uom_code = 'kg'`;
  const live = async (lot: string, qty: string) => (await sql()`
    insert into inventory.inventory_batch (rm_batch_id, material_id, quantity_on_hand, uom_id, status)
    select rm_batch_id, material_id, ${qty}::numeric, ${kg!.id}::uuid, 'ACTIVE' from inventory.rm_batch_master where batch_number = ${lot} returning inventory_batch_id::text as id`)[0]!.id as string;
  const lot1 = await live(`ADJ-${x}-1`, '10'), lot3 = await live(`ADJ-${x}-3`, '5');
  await sql()`insert into inventory.stock_reservation (inventory_batch_id, reserved_qty, uom_id, status) values (${lot3}::uuid, 4, ${kg!.id}::uuid, 'ACTIVE')`;
  const onHand = async (id: string) => Number((await sql()`select quantity_on_hand::text as q from inventory.inventory_batch where inventory_batch_id = ${id}::uuid`)[0]!.q);

  const head = ['Ingredient code', 'Lot', 'Change', 'Unit', 'Reason', 'Reference'];
  const done = await run('raw-stock-adjustment', [head, [a!, `ADJ-${x}-1`, '-250', 'g', 'Count of 12 Nov found less', `CNT-${x}`], [a!, `ADJ-${x}-1`, '1.5', 'kg', 'Found behind the rack', `CNT-${x}-B`]]);
  assert.deepEqual(done.job.written, { rows: 2, create: 2, update: 0, skip: 0, refuse: 0 });
  assert.equal(await onHand(lot1), 11.25);
  const ledger = await sql()`select adjustment_qty::text as q, adjustment_reason, created_by from inventory.stock_adjustment where inventory_batch_id = ${lot1}::uuid order by created_dt, adjustment_qty`;
  assert.deepEqual(ledger.map((l) => [Number(l.q), l.adjustment_reason, l.created_by]).sort(), [[-0.25, `Count of 12 Nov found less [ref CNT-${x}]`, buyer.userId], [1.5, `Found behind the rack [ref CNT-${x}-B]`, buyer.userId]].sort());

  const pre = await engine.preview('raw-stock-adjustment', { bytes: csv([head,
    [a!, `ADJ-${x}-1`, '-250', 'g', 'the same count again', `cnt-${x}`],
    [a!, `ADJ-${x}-1`, '-11', 'kg', 'too much', `CNT-${x}-C`],
    [a!, `ADJ-${x}-1`, '-11.25', 'kg', 'down to nothing', `CNT-${x}-C2`],
    [a!, `ADJ-${x}-1`, '-0.01', 'kg', 'one more', `CNT-${x}-C3`],
    [b!, `ADJ-${x}-3`, '-2', 'kg', 'cuts the reservation', `CNT-${x}-D`],
    [b!, `ADJ-${x}-3`, '-1', 'kg', 'leaves the reservation whole', `CNT-${x}-E`],
    [a!, `ADJ-${x}-2`, '-1', 'kg', 'still held', `CNT-${x}-F`],
    [b!, `ADJ-${x}-1`, '1', 'kg', 'wrong ingredient', `CNT-${x}-G`],
    [a!, `ADJ-${x}-1`, '0', 'kg', 'nothing', `CNT-${x}-H`],
    [a!, `ADJ-${x}-1`, '5', 'ml', 'wrong unit', `CNT-${x}-I`],
    [a!, `NOPE-${x}`, '1', 'kg', '', ''],
  ]) }, ctx());
  assert.equal(rowOf(pre, 2).outcome, 'skip');
  assert.match(rowOf(pre, 2).problems[0]!, /already posted/);
  assert.equal(rowOf(pre, 3).outcome, 'create'); // 11.25 - 11 leaves 0.25
  assert.match(rowOf(pre, 4).problems.join(' '), /Adjustment would take on-hand negative \(-11\)/, 'the running figure counts the earlier rows of the same file');
  assert.equal(rowOf(pre, 5).outcome, 'create'); // 0.25 - 0.01
  assert.match(rowOf(pre, 6).problems.join(' '), /4 kg of this lot is reserved for production.*cuts into the reservation/);
  assert.equal(rowOf(pre, 7).outcome, 'create');
  assert.match(rowOf(pre, 8).problems.join(' '), /not released to stock yet \(it is held for QC\)/);
  assert.match(rowOf(pre, 9).problems.join(' '), /is not a lot of/);
  assert.match(rowOf(pre, 10).problems.join(' '), /change of zero changes nothing/);
  assert.match(rowOf(pre, 11).problems.join(' '), /The lot is kept in kg: ml and kg do not convert without a density/);
  const last = rowOf(pre, 12).problems.join(' ');
  for (const re of [/No lot NOPE-/, /"Reason" is empty/, /"Reference" is empty/]) assert.match(last, re);
  assert.equal(await onHand(lot1), 11.25, 'a preview moved nothing');
  assert.equal(await onHand(lot3), 5);
});

/* ── packaging materials ──────────────────────────────────────────────────────────────────── */

test('packaging materials: created through the catalogue service; the same code and name is skipped, another name refused', async () => {
  const x = t();
  const head = ['Code', 'Name', 'Unit'];
  const before = await count('packaging.packaging_material_master');
  const done = await run('packaging-materials', [head, [`PKG-${x}-1`, `Made-up bottle 100 ml ${x}`, ''], [`PKG-${x}-2`, `Made-up cap ${x}`, 'g']]);
  assert.deepEqual(done.job.written, { rows: 2, create: 2, update: 0, skip: 0, refuse: 0 });
  assert.equal(await count('packaging.packaging_material_master'), before + 2);
  const pre = await engine.preview('packaging-materials', { bytes: csv([head, [`pkg-${x}-1`, `made-up bottle 100 ml ${x}`, ''], [`PKG-${x}-2`, 'Something else', ''], [`PKG-${x}-3`, '', 'crate']]) }, ctx());
  assert.equal(rowOf(pre, 2).outcome, 'skip');
  assert.match(rowOf(pre, 3).problems.join(' '), /on file under another name/);
  assert.match(rowOf(pre, 4).problems.join(' '), /"Name" is empty.*unit "crate" is not in the unit list/);
});
