/**
 * IMPORT-RP — THE FORMULA RULE, tested by looking for a formula where it must never be.
 *
 * A formula is the house's trade secret. The formulas import (cluster-formula/src/imports) is run
 * here against a real formula schema, the real Vault, Formulas, Approvals and recipe-setup services
 * and the real idempotency store, with a made-up formula whose ingredient codes, names, ids and
 * quantities are CANARIES: strings that occur nowhere else. After an import, each place the rule
 * names is read back and searched for every canary:
 *
 *   a log               everything written to stdout, stderr and console during the calls
 *   an audit row        formula.audit_events
 *   an event            formula.formula_event_hist
 *   an outbox payload   formula.outbox
 *   an error message    every problem and every refusal the import returns for a bad file
 *   the job's rows      formula.import_job, formula.import_job_row (and its CHECK refuses a cell)
 *   the stored replies  formula.idempotency_key, through the real interceptor
 *
 * and the import is shown to land through the Vault's own path: sealed as the uploader, submitted for
 * review, refused to its own uploader for approval, approved by a second person, and read back at
 * exactly the percentages the parts come to. Nothing here is real: no file of the owner's is opened.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { from, lastValueFrom } from 'rxjs';
import { eq } from 'drizzle-orm';
import * as formulaSchema from '@ra/data-formula';
import { ImportEngine, META_NO_STORED_REPLY, META_PERMISSIONS, readImportFile, toCsv, writeWorkbook, type ImportJobResult } from '@core/backend-kernel';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { EnvKmsAdapter } from '../../../cluster-formula/src/crypto/env-kms.adapter.js';
import { VaultService } from '../../../cluster-formula/src/vault.service.js';
import { FormulasService } from '../../../cluster-formula/src/formulas/formulas.service.js';
import { ApprovalsService } from '../../../cluster-formula/src/approvals/approvals.service.js';
import { MaterialCatalogue, materialCatalogueDigest } from '../../../cluster-formula/src/facts-bridge/material-catalogue.js';
import { FormulaSetupService } from '../../../cluster-formula/src/setup/formula-setup.service.js';
import { FormulaSetupController } from '../../../cluster-formula/src/setup/formula-setup.controller.js';
import { FORMULAS, formulasKind, sayKind } from '../../../cluster-formula/src/imports/formula-import.kind.js';
import { FormulaImportController } from '../../../cluster-formula/src/imports/formula-import.controller.js';
import { ensureSchema, formulaDb, testClient, closeTestClient } from '../../../cluster-formula/src/__tests__/db.js';
import { principal } from '../../../test-support/db.js';
import { ROLES } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';
import { IdempotencyInterceptorBase, IdempotencyStore } from '../idempotency/idempotency.interceptor.js';
import { FACTORY_IMPORT_SPECS } from '../imports/kind-specs.js';

const TEST_KEK = 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=';
const config = new ConfigService({ DATABASE_URL: 'postgres://unused/x', JWT_SECRET: 'x'.repeat(32), FORMULA_KEK: TEST_KEK });
const run = randomUUID().slice(0, 6).toUpperCase();
const permsOf = (role: string) => RA_PERMISSIONS.filter(ROLES.find((r) => r.code === role)!.select);
const formulator = principal({ userId: randomUUID(), roles: ['formulator'], permissions: permsOf('formulator') });
const formulator2 = principal({ userId: randomUUID(), roles: ['formulator'], permissions: permsOf('formulator') });
const approver = principal({ userId: randomUUID(), roles: ['vault_approver'], permissions: permsOf('vault_approver') });
const owner = principal({ userId: randomUUID(), roles: ['owner'], permissions: permsOf('owner') });
const today = '2026-11-13';
const ctx = (p = formulator) => ({ principal: p, today });

/* The made-up formula. Every string below is a canary. */
const MAT = {
  a: { materialId: randomUUID(), materialCode: `ZQX-ALPHA-${run}`, materialName: `Canaryol Alpha ${run}` },
  b: { materialId: randomUUID(), materialCode: `ZQX-BETA-${run}`, materialName: `Canaryol Beta ${run}` },
  c: { materialId: randomUUID(), materialCode: `ZQX-GAMMA-${run}`, materialName: `Canaryol Gamma ${run}` },
};
const PARTS = { a: '611.3771', b: '288.6229', c: '100' }; // of 1,000
const PERCENT = { a: '61.13771', b: '28.86229', c: '10' };
const UNKNOWN = `ZQX-NOSUCH-${run}`;
const BAD_PARTS = '417.99913';
const CANARIES = [
  ...Object.values(MAT).flatMap((m) => [m.materialId, m.materialCode, m.materialName]),
  PARTS.a, PARTS.b, PERCENT.a, PERCENT.b, UNKNOWN, BAD_PARTS, 'ZQX-', 'Canaryol',
];
/** Timestamps are taken out before searching: "…:28.86229+05:30" would be a coincidence, not a leak. */
const strip = (text: string) => text.replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?/g, '');
function assertClean(text: string, where: string): void {
  const t = strip(text);
  for (const c of CANARIES) assert.equal(t.includes(c), false, `${where} holds formula content (a canary of ${c.length} characters was found)`);
}

let sql: ReturnType<typeof testClient>;
let db: ReturnType<typeof formulaDb>;
let formulas: FormulasService;
let approvals: ApprovalsService;
let setup: FormulaSetupService;
let engine: ImportEngine;
let captured = '';
let restore: Array<() => void> = [];
const HEAD = ['Formula code', 'Version', 'Line number', 'Ingredient code', 'Parts by weight'];
const csv = (rows: string[][]) => Buffer.from(toCsv(rows), 'utf8');
const rowOf = (r: ImportJobResult, n: number) => r.rows.find((x) => x.row === n)!;
const dump = async (table: string, where = 'true') => (await sql.unsafe(`select coalesce(string_agg(row_to_json(t)::text, E'\\n'), '') as j from (select * from ${table} where ${where}) t`))[0]!.j as string;
const refused = async (fn: () => Promise<unknown>, status: number) => {
  let message = '';
  await assert.rejects(fn, (err: { status?: number; message?: string }) => { assert.equal(err.status, status, err.message); message = String(err.message); return true; });
  return message;
};
async function newFormula(tag: string): Promise<string> {
  const code = `F-CAN-${tag}-${run}`;
  await formulas.createFormula({ formulaCode: code, formulaName: `Made-up accord ${tag} ${run}` }, formulator);
  return code;
}
const good = (code: string, version = '1') => [HEAD, [code, version, '1', MAT.a.materialCode, PARTS.a], [code, version, '2', MAT.b.materialCode, PARTS.b], [code, version, '3', MAT.c.materialCode, PARTS.c]];

before(async () => {
  await ensureSchema();
  sql = testClient();
  db = formulaDb();
  const kms = new EnvKmsAdapter(config);
  const catalogue = new MaterialCatalogue();
  const all = Object.values(MAT);
  catalogue.receive({ digest: materialCatalogueDigest(all), materials: all });
  const vault = new VaultService(db as never, kms);
  formulas = new FormulasService(db as never, kms, vault, catalogue);
  approvals = new ApprovalsService(db as never, vault);
  setup = new FormulaSetupService(db as never, kms, vault, formulas, approvals, catalogue);
  engine = new ImportEngine(sql, 'formula', [formulasKind(sql, setup)] as never);

  // A log: everything the process writes while these tests run is kept, and searched at the end.
  for (const stream of [process.stdout, process.stderr] as const) {
    const write = stream.write.bind(stream);
    (stream as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => { captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'); return (write as (...a: unknown[]) => boolean)(chunk, ...rest); };
    restore.push(() => { (stream as { write: unknown }).write = write; });
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => { captured += args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n'; original(...args); };
    restore.push(() => { console[level] = original; });
  }
});
after(async () => {
  for (const r of restore) r();
  await closeTestClient();
});

/* ── who ──────────────────────────────────────────────────────────────────────────────────── */

test('who: every route of the Vault import demands the formulas permission; an approver and the owner are refused; the factory box has no formulas kind', async () => {
  const proto = FormulaImportController.prototype as unknown as Record<string, unknown>;
  const routes = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
  assert.deepEqual(routes.sort(), ['commit', 'history', 'job', 'kinds', 'preview', 'problems', 'template']);
  for (const name of routes) assert.deepEqual(Reflect.getMetadata(META_PERMISSIONS, proto[name] as object), [FORMULAS.permission], name);

  assert.equal(formulator.permissions.includes(FORMULAS.permission), true);
  for (const p of [approver, owner]) {
    assert.equal(p.permissions.includes(FORMULAS.permission), false);
    assert.deepEqual(engine.kindsFor(p), []);
    assert.throws(() => engine.template('formulas', 'xlsx', p), (e: { status?: number }) => e.status === 403);
    await refused(() => engine.preview('formulas', { bytes: csv(good('F-X')) }, ctx(p)), 403);
    assert.deepEqual(await engine.history(p), []);
  }
  assert.equal(FACTORY_IMPORT_SPECS.some((s) => s.kind === 'formulas' || s.secret), false);
});

/* ── a clean upload ───────────────────────────────────────────────────────────────────────── */

test('a clean upload lands through the Vault\'s seal and review path, and not a word of it is kept anywhere but the sealed formula', async () => {
  const code = await newFormula('A');
  const bytes = writeWorkbook([{ name: 'Data', rows: good(code) }]);
  const mark = { audit: Number((await sql`select coalesce(max(chain_seq), 0) as n from formula.audit_events`)[0]!.n), outbox: Number((await sql`select coalesce(max(seq), 0) as n from formula.outbox`)[0]!.n) };

  // The template first: an empty workbook with instructions, no formula in it.
  const template = engine.template('formulas', 'xlsx', formulator);
  const t = readImportFile(Buffer.from(template.base64, 'base64'));
  assert.equal(t.ok && t.table[0]!.join('|'), HEAD.join('|'));

  const sealedBefore = Number((await sql`select count(*)::int as n from formula.formula_ingredients`)[0]!.n);
  const pre = await engine.preview('formulas', { bytes, fileName: 'accord.xlsx' }, ctx());
  assert.deepEqual(pre.job.counts, { rows: 3, create: 3, update: 0, skip: 0, refuse: 0 });
  assert.equal(Number((await sql`select count(*)::int as n from formula.formula_ingredients`)[0]!.n), sealedBefore, 'a preview seals nothing');
  assert.deepEqual(pre.rows.map((r) => r.naturalKey), [`${code} v1`, `${code} v1`, `${code} v1`]);
  assertClean(JSON.stringify(pre), 'the preview answer');

  const done = await engine.commit(pre.job.importJobId, { bytes }, ctx());
  assert.equal(done.job.status, 'committed');
  assert.deepEqual(done.job.written, { rows: 3, create: 3, update: 0, skip: 0, refuse: 0 });
  assertClean(JSON.stringify(done), 'the commit answer');

  // Through the seal path: three sealed lines, by the uploader, in a version submitted for review.
  const [version] = await sql<{ id: string; status: string; submitted_by: string | null; sealed: number; sealed_by: string[] }[]>`
    select v.formula_version_id::text as id, v.status, v.submitted_by::text as submitted_by,
           (select count(*)::int from formula.formula_ingredients i where i.formula_version_id = v.formula_version_id) as sealed,
           (select array_agg(distinct i.created_by) from formula.formula_ingredients i where i.formula_version_id = v.formula_version_id) as sealed_by
      from formula.formula_version v join formula.formula_master m on m.formula_id = v.formula_id where m.formula_code = ${code}`;
  assert.deepEqual([version!.sealed, version!.submitted_by, version!.sealed_by], [3, formulator.userId, [formulator.userId]]);
  assert.ok(['VERSIONED', 'REVIEW'].includes(version!.status), `submitted for review, not approved (${version!.status})`);
  // The sealed rows hold ciphertext: no ingredient and no quantity in the clear.
  assertClean(await dump('formula.formula_ingredients', `formula_version_id = '${version!.id}'`), 'the sealed ingredient rows');

  // A second person's approval, and never the uploader's own.
  await assert.rejects(() => approvals.approveVersion(version!.id, { remarks: 'my own' }, { ...formulator, permissions: [...formulator.permissions, 'formula:formula_approval:write'] }), /sealed|author|own/i);
  await approvals.approveVersion(version!.id, { remarks: 'reviewed' }, approver);
  // Read back by the person who may: exactly the percentages the parts come to. Nothing was rounded.
  const actual = await formulas.getActualFormula(version!.id, 'checking the import', formulator);
  const got = Object.fromEntries(actual.ingredients.map((i) => [i.materialId, String(i.percentage)]));
  assert.deepEqual(got, { [MAT.a.materialId]: PERCENT.a, [MAT.b.materialId]: PERCENT.b, [MAT.c.materialId]: PERCENT.c });

  // Every place the rule names, read back and searched.
  assertClean(await dump('formula.audit_events', `chain_seq > ${mark.audit}`), 'an audit row');
  assertClean(await dump('formula.outbox', `seq > ${mark.outbox}`), 'an outbox payload');
  assertClean(await dump('formula.formula_event_hist', `formula_version_id = '${version!.id}'`), 'an event');
  assertClean(await dump('formula.formula_version', `formula_version_id = '${version!.id}'`), 'the version row');
  assertClean(await dump('formula.import_job', `import_job_id = '${pre.job.importJobId}'`), 'the import job');
  const rows = await sql`select phase, cells, problems, natural_key, label, notes from formula.import_job_row where import_job_id = ${pre.job.importJobId}`;
  assert.equal(rows.length, 6);
  assert.equal(rows.every((r) => r.cells === null), true, 'no cell of a formula row is kept');
  assertClean(JSON.stringify(rows), 'the job\'s stored row outcomes');
  assert.ok(Number((await sql`select count(*)::int as n from formula.audit_events where chain_seq > ${mark.audit}`)[0]!.n) > 0, 'the seal path wrote its own audit rows');

  // The same file again: answered with the import it already was; nothing is sealed twice.
  const sealedAfter = Number((await sql`select count(*)::int as n from formula.formula_ingredients`)[0]!.n);
  const again = await engine.preview('formulas', { bytes, fileName: 'accord.xlsx' }, ctx());
  assert.equal(again.alreadyImported, true);
  assert.equal(again.job.importJobId, done.job.importJobId);
  // The same lines in a new file: the version is on file, so every row is a skip, and it cannot be committed.
  const retyped = csv(good(code));
  const pre2 = await engine.preview('formulas', { bytes: retyped }, ctx());
  assert.deepEqual(pre2.job.counts, { rows: 3, create: 0, update: 0, skip: 3, refuse: 0 });
  assert.match(rowOf(pre2, 2).problems[0]!, /already on file. A version on file is never changed/);
  await refused(() => engine.commit(pre2.job.importJobId, { bytes: retyped }, ctx()), 409);
  assert.equal(Number((await sql`select count(*)::int as n from formula.formula_ingredients`)[0]!.n), sealedAfter);
});

/* ── a bad upload ─────────────────────────────────────────────────────────────────────────── */

test('a bad upload: every problem is said in words that name no ingredient and no quantity, in the answer, in the refusal and on the job', async () => {
  const [f1, f2, f3, f4, f5] = [await newFormula('B1'), await newFormula('B2'), await newFormula('B3'), await newFormula('B4'), await newFormula('B5')];
  const rows = [HEAD,
    [f1, '1', '1', MAT.a.materialCode, PARTS.a], [f1, '1', '2', UNKNOWN, '388.6229'],                                  // an ingredient not in the material list
    [f2, '1', '1', MAT.a.materialCode, PARTS.a], [f2, '1', '2', MAT.a.materialCode.toLowerCase(), '388.6229'],        // an ingredient twice
    [f3, '1', '1', MAT.a.materialCode, PARTS.a], [f3, '1', '2', MAT.b.materialCode, BAD_PARTS],                       // does not total a power of ten
    [f4, '1', '1', MAT.a.materialCode, '33.3333333'], [f4, '1', '2', MAT.b.materialCode, '66.6666667'],               // totals 100, not exact at six decimals
    [f5, '2', '1', MAT.a.materialCode, PARTS.a], [f5, '2', '2', MAT.b.materialCode, '388.6229'],                       // the Vault would seal version 1
    [`F-NOSUCH-${run}`, '1', '1', MAT.c.materialCode, '100'],                                                          // no such formula
    [`F-ODD-${run}`, 'two', '', '', `${BAD_PARTS} g`],                                                                             // cells that cannot be read
  ];
  const bytes = csv(rows);
  const pre = await engine.preview('formulas', { bytes, fileName: 'bad.csv' }, ctx());
  assert.equal(pre.job.counts.refuse, pre.job.counts.rows);
  assert.match(rowOf(pre, 3).problems.join(' '), /ingredient code on this row is not in the material list the Vault holds/);
  assert.match(rowOf(pre, 2).problems.join(' '), /Row 3 of this formula version has a problem, and a version is accepted or refused whole/);
  assert.match(rowOf(pre, 5).problems.join(' '), /repeats the ingredient on row 4 of the same formula version/);
  assert.match(rowOf(pre, 6).problems.join(' '), /do not add up to 100, 1,000 or another power of ten.*the 100 percent rule/);
  assert.match(rowOf(pre, 8).problems.join(' '), /do not come to exact percentages at six decimals/);
  assert.match(rowOf(pre, 10).problems.join(' '), /The Vault would seal this as version 1, not version 2/);
  assert.match(rowOf(pre, 12).problems.join(' '), /no formula with this code in the Vault/);
  const last = rowOf(pre, 13).problems.join(' ');
  for (const re of [/"Version" must be a whole number/, /"Line number" must be a whole number/, /"Ingredient code" is empty/, /"Parts by weight" is not a plain number/]) assert.match(last, re);

  // An error message: the answer, the refusal of a commit, and what is stored.
  const answer = JSON.stringify(pre); // a formula code is not formula content
  assertClean(answer, 'an error message in the preview answer');
  for (const mode of ['all_or_nothing', 'valid_only']) assertClean(await refused(() => engine.commit(pre.job.importJobId, { bytes, mode }, ctx()), 409), `the ${mode} refusal`);
  const stored = await sql`select cells, problems, natural_key, label from formula.import_job_row where import_job_id = ${pre.job.importJobId}`;
  assert.equal(stored.every((r) => r.cells === null), true, 'a refused formula row keeps no cells either');
  assertClean(JSON.stringify(stored), 'the job\'s stored row outcomes');
  assert.equal(Number((await sql`select count(*)::int as n from formula.formula_ingredients i join formula.formula_version v on v.formula_version_id = i.formula_version_id join formula.formula_master m on m.formula_id = v.formula_id where m.formula_code = any(${[f1, f2, f3, f4, f5]})`)[0]!.n), 0, 'nothing of a refused file was sealed');

  // A file-level refusal says where and what kind, never what the cell held.
  const tooLong = await engine.preview('formulas', { bytes: csv([HEAD, [f1, '1', '1', `${MAT.a.materialCode}${'x'.repeat(2100)}`, PARTS.a]]) }, ctx());
  assert.equal(tooLong.job.status, 'refused');
  assertClean(JSON.stringify(tooLong), 'a file refusal');
  const formulaCell = await engine.preview('formulas', { bytes: csv([HEAD, [f1, '1', '1', MAT.a.materialCode, `=${PARTS.a}*2`]]) }, ctx());
  assert.match(formulaCell.job.fileProblems[0]!, /the cell holds a formula/);
  assertClean(JSON.stringify(formulaCell), 'a formula-cell refusal');

  // The recipe service's own messages are never passed on: each is re-said in fixed words.
  for (const m of [`no material with code "${UNKNOWN}"`, `line 3 repeats the material on line 2`, `the percentages add up to ${PERCENT.a}%, 38.86229% short of 100%`, `"${MAT.a.materialName}" matches 2 materials — use the material code`, `something new about ${MAT.b.materialName}`]) assertClean(sayKind(m), 'a re-said refusal');
});

/* ── the preview is the uploader's, in that session ───────────────────────────────────────── */

test('the rows-to-fix sheet is read from the file the uploader sends again and kept nowhere; another formulator cannot see the job', async () => {
  const [f1, f2] = [await newFormula('C1'), await newFormula('C2')];
  const bytes = csv([HEAD, ...good(f1).slice(1), [f2, '1', '1', MAT.a.materialCode, PARTS.a], [f2, '1', '2', UNKNOWN, '388.6229']]);
  const pre = await engine.preview('formulas', { bytes, fileName: 'two.csv' }, ctx());
  assert.deepEqual(pre.job.counts, { rows: 5, create: 3, update: 0, skip: 0, refuse: 2 });

  // Not without the file: the job holds no cell to build it from.
  await refused(() => engine.problems(pre.job.importJobId, { format: 'csv' }, ctx()), 422);
  await refused(() => engine.problems(pre.job.importJobId, { format: 'csv', bytes: csv(good(f1)) }, ctx()), 409);
  const sheet = await engine.problems(pre.job.importJobId, { format: 'xlsx', bytes }, ctx());
  const back = readImportFile(Buffer.from(sheet.base64, 'base64'));
  assert.equal(back.ok, true);
  if (back.ok) {
    assert.deepEqual(back.table[0], [...HEAD, 'Problem']);
    assert.equal(back.table.length, 3);
    assert.deepEqual(back.table[2]!.slice(0, 5), [f2, '1', '2', UNKNOWN, '388.6229'], 'the uploader gets their own rows back');
    assert.match(back.table[2]![5]!, /not in the material list/);
  }
  assertClean(await dump('formula.import_job_row', `import_job_id = '${pre.job.importJobId}'`), 'the job after its rows-to-fix sheet was built');

  // Another person who also holds the permission: not their upload, so no rows, no sheet, no commit.
  for (const fn of [() => engine.job(pre.job.importJobId, formulator2), () => engine.problems(pre.job.importJobId, { bytes }, ctx(formulator2)), () => engine.commit(pre.job.importJobId, { bytes, mode: 'valid_only' }, ctx(formulator2))]) {
    assert.match(await refused(fn, 404), /No such import/);
  }
  const seen = (await engine.history(formulator2, 'formulas', 200)).find((j) => j.importJobId === pre.job.importJobId)!;
  assert.deepEqual([seen.uploadedBy, seen.counts.rows, seen.counts.refuse], [formulator.userId, 5, 2]);
  assertClean(JSON.stringify(seen), 'the history');

  // Valid rows only: the whole good version is sealed, the refused one is not.
  const done = await engine.commit(pre.job.importJobId, { bytes, mode: 'valid_only' }, ctx());
  assert.deepEqual(done.job.written, { rows: 5, create: 3, update: 0, skip: 0, refuse: 2 });
  const sealed = await sql<{ code: string; n: number }[]>`select m.formula_code as code, count(i.*)::int as n from formula.formula_master m left join formula.formula_version v on v.formula_id = m.formula_id
    left join formula.formula_ingredients i on i.formula_version_id = v.formula_version_id where m.formula_code = any(${[f1, f2]}) group by 1 order by 1`;
  assert.deepEqual(sealed.map((s) => [s.code, s.n]), [[f1, 3], [f2, 0]]);
});

/* ── the stored replies ───────────────────────────────────────────────────────────────────── */

test('the idempotency store keeps no recipe: the rows-to-fix answer and the recipe preview are never stored, and what is stored names nothing', async () => {
  const interceptor = new IdempotencyInterceptorBase(new IdempotencyStore(sql, 'formula.idempotency_key'));
  const through = (handler: unknown, key: string, body: unknown, fn: () => Promise<unknown>) => lastValueFrom(interceptor.intercept({
    getType: () => 'http', getHandler: () => handler, getClass: () => Object,
    switchToHttp: () => ({ getRequest: () => ({ method: 'POST', url: '/v1/imports/x', body, headers: { 'idempotency-key': key }, user: formulator }) }),
  } as never, { handle: () => from(fn()) }));
  const stored = async (key: string) => sql`select state, response from formula.idempotency_key where user_id = ${formulator.userId} and idempotency_key = ${key}`;
  const imports = FormulaImportController.prototype, recipes = FormulaSetupController.prototype;
  assert.equal(Reflect.getMetadata(META_NO_STORED_REPLY, imports.problems), true);
  assert.equal(Reflect.getMetadata(META_NO_STORED_REPLY, recipes.importRecipes), true);

  const f = await newFormula('D');
  const bytes = csv([HEAD, [f, '1', '1', MAT.a.materialCode, PARTS.a], [f, '1', '2', UNKNOWN, '388.6229']]);
  const fileBase64 = bytes.toString('base64');

  // The preview: stored, as any write's answer is, and it names no ingredient and no quantity.
  const k1 = `imp-preview-${run}`;
  const pre = await through(imports.preview, k1, { fileBase64 }, () => engine.preview('formulas', { bytes }, ctx())) as ImportJobResult;
  const s1 = await stored(k1);
  assert.equal(s1[0]?.state, 'completed');
  assertClean(JSON.stringify(s1), 'the stored preview answer');
  assertClean(await dump('formula.idempotency_key', `idempotency_key = '${k1}'`), 'the idempotency row (its request hash is a hash)');

  // The rows-to-fix sheet holds the uploader's own lines: returned to them, and no row is left behind.
  const k2 = `imp-problems-${run}`;
  const sheet = await through(imports.problems, k2, { fileBase64 }, () => engine.problems(pre.job.importJobId, { format: 'csv', bytes }, ctx())) as { base64: string };
  assert.match(Buffer.from(sheet.base64, 'base64').toString('utf8'), new RegExp(UNKNOWN));
  assert.equal((await stored(k2)).length, 0, 'nothing of the rows-to-fix answer is stored');

  // The Vault's own recipe preview (POST /v1/formula-recipes/import) answered with material and
  // percentage and was being stored on every preview. It is not any more.
  const k3 = `recipe-preview-${run}`;
  const recipe = `formula_code,material_code,percentage\n${f},${MAT.a.materialCode},${PERCENT.a}\n${f},${MAT.b.materialCode},38.86229\n`;
  const answer = await through(recipes.importRecipes, k3, { csv: recipe }, () => setup.importRecipes({ csv: recipe, commit: false, submit: true }, formulator)) as { rows: unknown[] };
  assert.equal(answer.rows.length, 2);
  assert.equal((await stored(k3)).length, 0);
  assertClean(await dump('formula.idempotency_key', `user_id = '${formulator.userId}'`), 'the idempotency store');
});

/* ── the table itself ─────────────────────────────────────────────────────────────────────── */

test('the Vault\'s job-row table refuses a cell by its own CHECK, whatever the code does', async () => {
  const [job] = await sql`select import_job_id from formula.import_job limit 1`;
  await assert.rejects(
    () => sql`insert into formula.import_job_row (import_job_id, phase, row_no, outcome, cells) values (${job!.import_job_id}, 'preview', 999999, 'refuse', ${JSON.stringify({ a: 'b' })}::text::jsonb)`,
    /import_job_row_no_cells/);
});

/* ── a log ────────────────────────────────────────────────────────────────────────────────── */

test('a log: nothing written to stdout, stderr or the console while formulas were imported holds any of it', () => {
  assert.ok(captured.length > 0, 'the capture was in place (the test runner itself writes)');
  assertClean(captured, 'a log');
});

test('the version and its lines can be found by the people who may read a formula, and by nobody through the import', async () => {
  const lines = await db.select().from(formulaSchema.formulaIngredients).where(eq(formulaSchema.formulaIngredients.createdBy, formulator.userId));
  assert.ok(lines.length >= 6);
  assert.equal(lines.every((l) => typeof l.encPayload === 'string' && l.encPayload.length > 0 && l.materialId == null), true, 'sealed lines carry ciphertext and no material id');
});
