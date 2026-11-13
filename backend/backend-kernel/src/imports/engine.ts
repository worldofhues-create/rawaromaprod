/**
 * IMPORT-RP — the one mechanism behind every bulk import: preview, commit, the problems sheet and
 * the history. A box makes one engine over its own database (the factory: `platform.import_job` on
 * DATABASE_URL; the Vault: `formula.import_job` on its own connection) and registers its kinds.
 *
 *   preview   reads the file, asks the kind to judge every row, and writes ONLY the job and each
 *             row's outcome. No material, supplier, lot or formula is written.
 *   commit    takes the same file again. A file whose SHA-256 differs from the previewed one is
 *             refused. The rows are judged afresh (the database may have moved since the preview),
 *             and each accepted row is written by the function the single-record route calls.
 *             All-or-nothing unless the person chose "valid rows only".
 *   twice     by file: a file already committed for the kind is answered with that job and nothing
 *             is written. By row: each kind has a natural key, and a row already on file is a skip.
 *
 * ONE TRANSACTION, THROUGH THE SINGLE-RECORD FUNCTIONS. A kind's `writeUnit` is handed a transaction
 * and runs the service the route runs, bound to it (`asPool`): the service's own `transaction()`
 * becomes a savepoint inside the import's transaction, so nothing in a service is rewritten for the
 * import and a failed row cannot leave half a record. A kind whose writer owns its transaction (the
 * Vault's seal path, which wraps keys, seals and audits in one of its own) gives `writeAll` instead.
 *
 * WHAT IS KEPT. The uploaded file is not stored: the job keeps its hash, name and counts. A refused
 * row keeps its cells (the problems sheet is built from them); a row that imported keeps none. A
 * SECRET kind (a formula) keeps no cells at all, and its problems sheet is built from the file the
 * person sends again. Nothing from a row is written to a log by this file.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { uuidv7 } from '@core/data-kernel';
import { DomainError } from '../edge/domain-error.js';
import type { AuthPrincipal } from '../edge/principal.js';
import {
  countImportRows, importCommitRefusal, isImportMode,
  type ImportCounts, type ImportKindSpec, type ImportMode, type ImportOutcome, type ImportRowPlan,
} from './model.js';
import { readImportFile } from './sheet.js';
import { readImportTable, type ImportTableRow } from './table.js';
import { EXAMPLE_ROW_PROBLEM, filledCsv, filledXlsx, isExampleRow, problemsCsv, problemsXlsx, templateCsv, templateXlsx } from './template.js';

export interface ImportContext {
  readonly principal: AuthPrincipal;
  /** Today as YYYY-MM-DD, read once at the edge: a rule about "the future" is a rule about a day. */
  readonly today: string;
  /** The import job being committed (set by the engine for a writer that records where a row came from). */
  readonly jobId?: string;
}

export interface ImportKindHandler<I = unknown> {
  readonly spec: ImportKindSpec;
  /** Judge every row. Reads the database; writes nothing. Sets outcome, problems, notes and input. */
  plan(rows: readonly ImportTableRow[], ctx: ImportContext): Promise<ImportRowPlan<I>[]>;
  /** Rows that are written together or not at all (a receipt's lines, a formula version's lines).
   *  Default: each row on its own. */
  units?(rows: readonly ImportRowPlan<I>[]): ImportRowPlan<I>[][];
  /** Write one unit inside the import's transaction, through the single-record function. */
  writeUnit?(tx: TransactionSql, rows: readonly ImportRowPlan<I>[], ctx: ImportContext): Promise<void>;
  /** Write every accepted row in the writer's own transaction (all of them or none). */
  writeAll?(rows: readonly ImportRowPlan<I>[], ctx: ImportContext): Promise<void>;
  /**
   * EXPORT WHAT IS ON FILE (LD-156): one row per existing record with its current values, by column
   * key, in the template's own columns, so a person fills the empty cells and uploads the sheet back.
   * Only a kind whose rule lets a row be added to (a new price from a later date) offers it. A kind
   * that does not define this has no export at all: the formulas kind never does.
   */
  exportRows?(ctx: ImportContext): Promise<Record<string, string>[]>;
}

export interface ImportJobView {
  importJobId: string;
  kind: string;
  fileName: string | null;
  fileFormat: string;
  fileSha256: string;
  status: 'previewed' | 'committed' | 'refused';
  mode: ImportMode | null;
  uploadedBy: string;
  uploadedDt: string;
  committedBy: string | null;
  committedDt: string | null;
  counts: ImportCounts;
  written: ImportCounts | null;
  fileProblems: string[];
  ignoredColumns: string[];
}
export interface ImportRowView {
  row: number;
  outcome: ImportOutcome;
  naturalKey: string;
  label: string;
  problems: string[];
  notes: string[];
}
export interface ImportJobResult {
  job: ImportJobView;
  rows: ImportRowView[];
  /** Why this plan cannot be committed under each mode (null: it can). */
  commitRefusal: Record<ImportMode, string | null>;
  /** True when this very file was already imported: the job returned is that import. */
  alreadyImported: boolean;
}
export interface ImportDownload { fileName: string; mime: string; base64: string }

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_MIME = 'text/csv; charset=utf-8';

/**
 * A postgres.js transaction that a service's Drizzle client can be bound to. Drizzle's
 * `transaction()` calls `client.begin(fn)`; a transaction has no `begin`, it has `savepoint`. This
 * maps one to the other, so `new MaterialService(drizzle(asPool(tx, pool), { schema }))` runs the
 * service exactly as the route does, inside the import's transaction. Drizzle also reads the client's
 * `options` (its date parsers); a transaction carries none of its own, so the pool's are handed over.
 */
export function asPool(tx: TransactionSql, pool: Sql): Sql {
  return new Proxy(tx as unknown as Sql, {
    get(target, prop, receiver) {
      if (prop === 'begin') return (...args: unknown[]) => (tx.savepoint as (fn: unknown) => unknown)(args[args.length - 1]);
      if (prop === 'options') return pool.options;
      return Reflect.get(target, prop, receiver);
    },
  });
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const countsOf = (r: Record<string, unknown>, p: string): ImportCounts | null =>
  r[`${p}rows`] == null ? null : { rows: Number(r[`${p}rows`]), create: Number(r[`${p}create`]), update: Number(r[`${p}update`]), skip: Number(r[`${p}skip`]), refuse: Number(r[`${p}refuse`]) };

/** What a person is told when a write the preview accepted fails. For a secret kind the cause is
 *  never repeated: a service's own message may name an ingredient. */
function writeProblem(err: unknown, secret: boolean): string {
  if (secret) return 'This was refused when it was written. Preview the file again to see why.';
  const e = err as { code?: string; message?: string; getStatus?: () => number; status?: number };
  const status = typeof e?.getStatus === 'function' ? e.getStatus() : e?.status;
  if (typeof status === 'number' && status >= 400 && status < 500 && e.message) return e.message;
  if (e?.code === '23505') return 'A record with the same code or key was added while this file was being imported. Preview the file again.';
  if (e?.code === '23514' || e?.code === '23502' || e?.code === '22001') return 'The database refused this row (a value is missing, too long or not allowed).';
  return 'This row could not be written. Nothing of it was kept.';
}

export class ImportEngine {
  private readonly kinds = new Map<string, ImportKindHandler>();

  /** `schema` is fixed by the box that builds the engine, never caller input. */
  constructor(private readonly sql: Sql, private readonly schema: string, kinds: readonly ImportKindHandler[]) {
    for (const k of kinds) this.kinds.set(k.spec.kind, k);
  }
  private get jobs() { return this.sql(`${this.schema}.import_job`); }
  private get jobRows() { return this.sql(`${this.schema}.import_job_row`); }

  /* ── who may run what ─────────────────────────────────────────────────────────────────── */

  /** The kinds this person may run, with their columns: what the panel offers. */
  kindsFor(principal: AuthPrincipal): Array<ImportKindSpec & { exportable: boolean }> {
    return [...this.kinds.values()].filter((k) => principal.permissions.includes(k.spec.permission)).map((k) => ({ ...k.spec, exportable: !!k.exportRows }));
  }
  private handler(kind: string, principal: AuthPrincipal): ImportKindHandler {
    const h = this.kinds.get(kind);
    if (!h) throw DomainError.notFound(`There is no import called "${kind}".`);
    if (!principal.permissions.includes(h.spec.permission)) {
      throw DomainError.forbidden('AUTH_FORBIDDEN', `You may not import ${h.spec.title.toLowerCase()}.`);
    }
    return h;
  }

  /* ── downloads ────────────────────────────────────────────────────────────────────────── */

  template(kind: string, format: string, principal: AuthPrincipal): ImportDownload {
    const { spec } = this.handler(kind, principal);
    return format === 'csv'
      ? { fileName: `${spec.kind}-template.csv`, mime: CSV_MIME, base64: templateCsv(spec).toString('base64') }
      : { fileName: `${spec.kind}-template.xlsx`, mime: XLSX_MIME, base64: templateXlsx(spec).toString('base64') };
  }

  /** The kind's own sheet filled with what is on file. Same permission as the kind; every cell guarded. */
  async exportFilled(kind: string, format: string, ctx: ImportContext): Promise<ImportDownload> {
    const h = this.handler(kind, ctx.principal);
    if (!h.exportRows) throw DomainError.notFound(`${h.spec.title} has no export of what is on file.`);
    const rows = await h.exportRows(ctx);
    return format === 'csv'
      ? { fileName: `${h.spec.kind}-on-file.csv`, mime: CSV_MIME, base64: filledCsv(h.spec, rows).toString('base64') }
      : { fileName: `${h.spec.kind}-on-file.xlsx`, mime: XLSX_MIME, base64: filledXlsx(h.spec, rows).toString('base64') };
  }

  /* ── reading and judging ──────────────────────────────────────────────────────────────── */

  private async judge(h: ImportKindHandler, bytes: Buffer, ctx: ImportContext) {
    const file = readImportFile(bytes);
    if (!file.ok) return { format: file.format, fileProblems: [file.problem], rows: [] as ImportRowPlan[], ignored: [] as string[] };
    const table = readImportTable(h.spec, file.table);
    if (!table.ok) return { format: file.format, fileProblems: [...table.fileProblems], rows: [] as ImportRowPlan[], ignored: [] as string[] };
    const examples = new Set(table.rows.filter((r) => isExampleRow(h.spec, r.values)).map((r) => r.row));
    const rows = await h.plan(table.rows, ctx);
    for (const r of rows) {
      if (examples.has(r.row)) { r.problems.unshift(EXAMPLE_ROW_PROBLEM); r.outcome = 'refuse'; }
      else if (r.problems.length && r.outcome !== 'skip') r.outcome = 'refuse';
    }
    return { format: file.format, fileProblems: [] as string[], rows, ignored: [...table.ignoredColumns] };
  }

  private view(r: Record<string, unknown>): ImportJobView {
    return {
      importJobId: String(r.import_job_id), kind: String(r.kind), fileName: (r.file_name as string | null) ?? null,
      fileFormat: String(r.file_format), fileSha256: String(r.file_sha256).trim(), status: r.status as ImportJobView['status'],
      mode: (r.mode as ImportMode | null) ?? null, uploadedBy: String(r.uploaded_by), uploadedDt: iso(r.uploaded_dt)!,
      committedBy: (r.committed_by as string | null) ?? null, committedDt: iso(r.committed_dt),
      counts: countsOf(r, 'n_') ?? { rows: 0, create: 0, update: 0, skip: 0, refuse: 0 }, written: countsOf(r, 'w_'),
      fileProblems: (r.file_problems as string[] | null) ?? [], ignoredColumns: (r.ignored_columns as string[] | null) ?? [],
    };
  }
  private static rowView(r: ImportRowPlan): ImportRowView {
    return { row: r.row, outcome: r.outcome, naturalKey: r.naturalKey, label: r.label, problems: [...r.problems], notes: [...r.notes] };
  }
  private static refusals(counts: ImportCounts): Record<ImportMode, string | null> {
    return { all_or_nothing: importCommitRefusal(counts, 'all_or_nothing'), valid_only: importCommitRefusal(counts, 'valid_only') };
  }
  private async insertRows(db: Sql | TransactionSql, jobId: string, phase: 'preview' | 'commit', rows: readonly ImportRowPlan[], secret: boolean) {
    const tx = db as Sql;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({
        row_no: r.row, outcome: r.outcome, natural_key: r.naturalKey.slice(0, 500), label: r.label.slice(0, 500), problems: r.problems, notes: r.notes,
        // Only a refused row keeps its cells, and a secret kind's rows never do.
        cells: !secret && r.outcome === 'refuse' ? r.cells : null,
      }));
      // One statement a chunk; the JSON goes as text and is cast (a jsonb parameter would be encoded twice).
      await tx`insert into ${this.jobRows} (import_job_id, phase, row_no, outcome, natural_key, label, problems, notes, cells)
               select ${jobId}::uuid, ${phase}, x.row_no, x.outcome, x.natural_key, x.label, x.problems, x.notes, x.cells
                 from jsonb_to_recordset(${JSON.stringify(chunk)}::text::jsonb)
                   as x(row_no int, outcome text, natural_key text, label text, problems jsonb, notes jsonb, cells jsonb)`;
    }
  }

  /* ── preview ──────────────────────────────────────────────────────────────────────────── */

  async preview(kind: string, input: { bytes: Buffer; fileName?: string | null }, ctx: ImportContext): Promise<ImportJobResult> {
    const h = this.handler(kind, ctx.principal);
    const sha = createHash('sha256').update(input.bytes).digest('hex');
    const [done] = await this.sql`select * from ${this.jobs} where kind = ${kind} and file_sha256 = ${sha} and status = 'committed' limit 1`;
    if (done) {
      // The same file again: answered with the import it already was, and nothing is read or written.
      // Its rows are the uploader's; anyone else who holds the kind is told only that it is in.
      const mine = String(done.uploaded_by) === ctx.principal.userId;
      return { job: this.view(done), rows: mine ? await this.rowsOf(String(done.import_job_id), 'commit') : [], commitRefusal: { all_or_nothing: 'This file was already imported.', valid_only: 'This file was already imported.' }, alreadyImported: true };
    }
    const judged = await this.judge(h, input.bytes, ctx);
    const counts = countImportRows(judged.rows);
    const jobId = uuidv7();
    const name = (input.fileName ?? '').replace(/[\x00-\x1f]/g, '').slice(0, 255) || null;
    const status = judged.fileProblems.length ? 'refused' : 'previewed';
    await this.sql.begin(async (tx) => {
      await tx`insert into ${this.jobs} (import_job_id, kind, file_sha256, file_name, file_format, uploaded_by, status, n_rows, n_create, n_update, n_skip, n_refuse, file_problems, ignored_columns)
               values (${jobId}, ${kind}, ${sha}, ${name}, ${judged.format}, ${ctx.principal.userId}, ${status}, ${counts.rows}, ${counts.create}, ${counts.update}, ${counts.skip}, ${counts.refuse},
                       ${JSON.stringify(judged.fileProblems)}::text::jsonb, ${JSON.stringify(judged.ignored)}::text::jsonb)`;
      await this.insertRows(tx, jobId, 'preview', judged.rows, !!h.spec.secret);
    });
    const [job] = await this.sql`select * from ${this.jobs} where import_job_id = ${jobId}`;
    return { job: this.view(job!), rows: judged.rows.map(ImportEngine.rowView), commitRefusal: ImportEngine.refusals(counts), alreadyImported: false };
  }

  /* ── commit ───────────────────────────────────────────────────────────────────────────── */

  async commit(jobId: string, input: { bytes: Buffer; mode?: unknown }, ctx: ImportContext): Promise<ImportJobResult> {
    const mode: ImportMode = input.mode == null || input.mode === '' ? 'all_or_nothing' : (isImportMode(input.mode) ? input.mode : (() => { throw new DomainError('VALIDATION_FAILED', 'Choose "all or nothing" or "valid rows only".', 422); })());
    const job = await this.ownJob(jobId, ctx.principal);
    const h = this.handler(job.kind, ctx.principal);
    if (job.status === 'committed') return this.result(job, 'commit', true);
    if (job.status === 'refused') throw DomainError.conflict('This file was refused when it was read. Fix it and upload it again.');
    const sha = createHash('sha256').update(input.bytes).digest('hex');
    if (sha !== job.fileSha256) throw DomainError.conflict('This is not the file that was previewed (it has changed since). Preview it again, then import.');
    const [other] = await this.sql`select import_job_id from ${this.jobs} where kind = ${job.kind} and file_sha256 = ${sha} and status = 'committed' limit 1`;
    if (other) {
      // Somebody committed this very file while this preview waited. It is in; its rows are theirs.
      const theirs = this.view((await this.sql`select * from ${this.jobs} where import_job_id = ${other.import_job_id}`)[0]!);
      const answer = await this.result(theirs, 'commit', true);
      return theirs.uploadedBy === ctx.principal.userId ? answer : { ...answer, rows: [] };
    }

    // Judged afresh: the preview is a promise about the file, the commit is about the database now.
    const judged = await this.judge(h, input.bytes, ctx);
    if (judged.fileProblems.length) throw DomainError.conflict(judged.fileProblems[0]!);
    const rows = judged.rows;
    const refusal = importCommitRefusal(countImportRows(rows), mode);
    if (refusal) throw DomainError.conflict(refusal);

    const accepted = rows.filter((r) => r.outcome === 'create' || r.outcome === 'update');
    const units = h.units ? h.units(accepted) : accepted.map((r) => [r]);
    const secret = !!h.spec.secret;
    const failUnit = (unit: readonly ImportRowPlan[], err: unknown) => {
      const why = writeProblem(err, secret);
      for (const r of unit) { r.outcome = 'refuse'; r.problems.push(why); }
      return why;
    };
    const finish = async (tx: Sql | TransactionSql) => {
      const written = countImportRows(rows);
      if (written.create + written.update === 0) throw DomainError.conflict('Nothing could be written: every row was refused when it was written. Preview the file again.');
      await this.insertRows(tx, jobId, 'commit', rows, secret);
      const claimed = await tx`update ${this.jobs} set status = 'committed', mode = ${mode}, committed_by = ${ctx.principal.userId}, committed_dt = now(),
                                      w_rows = ${written.rows}, w_create = ${written.create}, w_update = ${written.update}, w_skip = ${written.skip}, w_refuse = ${written.refuse}
                                where import_job_id = ${jobId} and status = 'previewed' returning import_job_id`;
      if (!claimed.length) throw DomainError.conflict('This import was committed by another request. Look at the history.');
    };

    if (h.writeAll) {
      // The writer owns its transaction (all of these rows or none). One commit of a job at a time.
      await this.sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${'import_job:' + jobId}))`;
        const [now] = await tx`select status from ${this.jobs} where import_job_id = ${jobId}`;
        if (now?.status !== 'previewed') throw DomainError.conflict('This import was committed by another request. Look at the history.');
        try { await h.writeAll!(accepted, { ...ctx, jobId }); }
        catch (err) { throw DomainError.conflict(`${writeProblem(err, secret)} Nothing was imported.`); }
        await finish(tx);
      });
    } else {
      if (!h.writeUnit) throw new Error(`import kind ${h.spec.kind} has no writer`);
      await this.sql.begin(async (tx) => {
        const [locked] = await tx`select status from ${this.jobs} where import_job_id = ${jobId} for update`;
        if (locked?.status !== 'previewed') throw DomainError.conflict('This import was committed by another request. Look at the history.');
        for (const unit of units) {
          try { await tx.savepoint((sp) => h.writeUnit!(sp, unit, { ...ctx, jobId })); }
          catch (err) {
            const why = failUnit(unit, err);
            if (mode === 'all_or_nothing') throw DomainError.conflict(`Row ${unit[0]!.row}: ${why} Nothing was imported.`);
          }
        }
        await finish(tx);
      });
    }
    return this.result(await this.ownJob(jobId, ctx.principal), 'commit', false);
  }

  /* ── reading a job, its problems sheet, the history ───────────────────────────────────── */

  /** A job's rows are the uploader's alone: a preview is shown to nobody else. */
  private async ownJob(jobId: string, principal: AuthPrincipal): Promise<ImportJobView> {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw DomainError.notFound('No such import.');
    const [r] = await this.sql`select * from ${this.jobs} where import_job_id = ${jobId}`;
    if (!r || String(r.uploaded_by) !== principal.userId) throw DomainError.notFound('No such import.');
    return this.view(r);
  }
  private async rowsOf(jobId: string, phase: 'preview' | 'commit'): Promise<ImportRowView[]> {
    const rows = await this.sql`select row_no, outcome, natural_key, label, problems, notes from ${this.jobRows} where import_job_id = ${jobId} and phase = ${phase} order by row_no`;
    return rows.map((r) => ({ row: Number(r.row_no), outcome: r.outcome as ImportOutcome, naturalKey: String(r.natural_key), label: String(r.label), problems: (r.problems as string[]) ?? [], notes: (r.notes as string[]) ?? [] }));
  }
  private async result(job: ImportJobView, phase: 'preview' | 'commit', alreadyImported: boolean): Promise<ImportJobResult> {
    const rows = await this.rowsOf(job.importJobId, phase);
    const refusals = job.status === 'committed'
      ? { all_or_nothing: 'This file was already imported.', valid_only: 'This file was already imported.' }
      : ImportEngine.refusals(job.counts);
    return { job, rows, commitRefusal: refusals, alreadyImported };
  }

  async job(jobId: string, principal: AuthPrincipal): Promise<ImportJobResult> {
    const job = await this.ownJob(jobId, principal);
    this.handler(job.kind, principal);
    return this.result(job, job.status === 'committed' ? 'commit' : 'preview', false);
  }

  /** The refused rows with a "Problem" column. A secret kind keeps no cells, so the person sends
   *  the file again and the sheet is built from it, for them, and kept nowhere. */
  async problems(jobId: string, input: { format?: string; bytes?: Buffer | null }, ctx: ImportContext): Promise<ImportDownload> {
    const job = await this.ownJob(jobId, ctx.principal);
    const h = this.handler(job.kind, ctx.principal);
    const phase = job.status === 'committed' ? 'commit' : 'preview';
    let refused: { cells: Record<string, string>; problems: string[] }[];
    if (h.spec.secret) {
      if (!input.bytes?.length) throw new DomainError('VALIDATION_FAILED', 'Send the file again: its rows are not kept here, so the rows to fix are read from it.', 422);
      if (createHash('sha256').update(input.bytes).digest('hex') !== job.fileSha256) throw DomainError.conflict('This is not the file that was previewed.');
      const file = readImportFile(input.bytes);
      const table = file.ok ? readImportTable(h.spec, file.table) : null;
      if (!table?.ok) throw DomainError.conflict('The file could not be read.');
      const cellsByRow = new Map(table.rows.map((r) => [r.row, r.cells]));
      const stored = await this.sql`select row_no, problems from ${this.jobRows} where import_job_id = ${jobId} and phase = ${phase} and outcome = 'refuse' order by row_no`;
      refused = stored.map((r) => ({ cells: { ...(cellsByRow.get(Number(r.row_no)) ?? {}) }, problems: (r.problems as string[]) ?? [] }));
    } else {
      const stored = await this.sql`select cells, problems from ${this.jobRows} where import_job_id = ${jobId} and phase = ${phase} and outcome = 'refuse' order by row_no`;
      refused = stored.map((r) => ({ cells: (r.cells as Record<string, string>) ?? {}, problems: (r.problems as string[]) ?? [] }));
    }
    if (refused.length === 0) throw DomainError.notFound('No row of this import was refused.');
    return input.format === 'csv'
      ? { fileName: `${job.kind}-rows-to-fix.csv`, mime: CSV_MIME, base64: problemsCsv(h.spec, refused).toString('base64') }
      : { fileName: `${job.kind}-rows-to-fix.xlsx`, mime: XLSX_MIME, base64: problemsXlsx(h.spec, refused).toString('base64') };
  }

  /** Every import of the kinds this person may run: who, when, the counts. Never a row. */
  async history(principal: AuthPrincipal, kind?: string, limit = 50): Promise<ImportJobView[]> {
    const allowed = this.kindsFor(principal).map((s) => s.kind).filter((k) => !kind || k === kind);
    if (allowed.length === 0) return [];
    const rows = await this.sql`select * from ${this.jobs} where kind = any(${allowed}) order by uploaded_dt desc, import_job_id desc limit ${Math.min(Math.max(1, limit), 200)}`;
    return rows.map((r) => this.view(r));
  }
}
