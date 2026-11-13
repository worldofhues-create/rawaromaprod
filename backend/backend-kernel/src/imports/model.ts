/**
 * IMPORT-RP — the one shape every bulk import has (owner, 13 Nov 2026: "an excel/spreadsheet template
 * must be there in the system so that users can download it fill it and upload it").
 *
 * A KIND names its columns once. A ROW comes out as one of four outcomes with its reasons in plain
 * words. The plan is the same object whether the screen is previewing or the server is about to
 * write, so a preview can never promise what the commit will not do.
 *
 * Domain-free, like the rest of this package: a kind's columns and judgement live with the cluster
 * that owns the record (backend/api/src/imports for the factory, cluster-formula for the Vault).
 * Pure: no I/O, no clock, no randomness. Mirrors Alembic's packages/domain/src/imports (LD-138) in
 * shape so a person meets one import in both systems.
 */

/* THE CAPS, and each is a refusal with a sentence, never a truncation: a file read to row 5,000 and
   silently dropped after it is a list somebody believes is on the system. The inflated cap is the
   zip-bomb one: a 40 KB workbook can declare gigabytes, and the reader stops inside the inflate. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_MAX_COLUMNS = 60;
export const IMPORT_MAX_CELL = 2000;
export const IMPORT_MAX_INFLATED_BYTES = 40 * 1024 * 1024;

export interface ImportColumn {
  /** The name the row validator reads the cell by. Never shown. */
  readonly key: string;
  /** The header in the template, exactly. */
  readonly header: string;
  /** Other headers people write for the same column. */
  readonly aliases: readonly string[];
  readonly required: boolean;
  /** One line for the Instructions sheet: what goes in the cell. */
  readonly help: string;
  /** The example row's cell. */
  readonly example: string;
}

export interface ImportKindSpec {
  readonly kind: string;
  readonly title: string;
  /** The permission this kind is gated on. */
  readonly permission: string;
  /** The single-record permission(s) it mirrors: `permission` is held by exactly the roles that
   *  hold these, so a sheet can never do what the form cannot (asserted by a test). */
  readonly mirrors: readonly string[];
  readonly columns: readonly ImportColumn[];
  /** Groups of column keys where the HEADER must carry at least one. */
  readonly oneOf?: readonly (readonly string[])[];
  /** The column whose example value marks the template's example row. */
  readonly exampleKey: string;
  readonly instructions: readonly string[];
  readonly naturalKey: string;
  readonly rule: string;
  readonly refuses: readonly string[];
  /** A TRADE SECRET kind (a formula). Its rows' cells are never kept on the job, and every word the
   *  kind writes about a row must name no ingredient and no quantity (the formula rule). */
  readonly secret?: boolean;
}

/** What becomes of a row. `refuse` is the only one that blocks a commit. */
export type ImportOutcome = 'create' | 'update' | 'skip' | 'refuse';

export interface ImportRowPlan<I = unknown> {
  /** The row number in the person's spreadsheet (the header is row 1). */
  readonly row: number;
  outcome: ImportOutcome;
  /** What identifies the record: a code, a supplier and lot, a formula code and version. */
  readonly naturalKey: string;
  /** A short name for the preview table. */
  readonly label: string;
  /** Why it is refused, or why it is skipped. Plain sentences, all of them. */
  readonly problems: string[];
  /** Remarks that do not block. */
  readonly notes: string[];
  /** What the writer is handed. Never stored on the job. */
  readonly input: I | null;
  /** The row's cells by column header, for the problems sheet. */
  readonly cells: Readonly<Record<string, string>>;
}

export interface ImportCounts {
  rows: number;
  create: number;
  update: number;
  skip: number;
  refuse: number;
}

export function countImportRows(rows: readonly { readonly outcome: ImportOutcome }[]): ImportCounts {
  const c: ImportCounts = { rows: rows.length, create: 0, update: 0, skip: 0, refuse: 0 };
  for (const r of rows) c[r.outcome] += 1;
  return c;
}

/** "All or nothing" is the default; the other is a choice somebody made, sent and recorded. */
export const IMPORT_MODES = ['all_or_nothing', 'valid_only'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];
export const isImportMode = (m: unknown): m is ImportMode => typeof m === 'string' && (IMPORT_MODES as readonly string[]).includes(m);

/** May this plan be committed under this mode, and if not, why. One opinion, asked by the screen
 *  (to enable the button) and the server (to refuse). */
export function importCommitRefusal(counts: ImportCounts, mode: ImportMode): string | null {
  if (counts.rows === 0) return 'The file has a header and no rows.';
  if (counts.create + counts.update === 0) {
    return counts.refuse > 0
      ? `Every row that would be written has a problem (${counts.refuse}). Nothing can be imported until one is fixed.`
      : 'Every row is already on file. There is nothing to import.';
  }
  if (mode === 'all_or_nothing' && counts.refuse > 0) {
    return `${counts.refuse} row${counts.refuse === 1 ? ' has' : 's have'} a problem, so nothing is imported. `
      + 'Fix them and upload again, or choose to import the valid rows only.';
  }
  return null;
}

/** Build a row plan; a row with any problem is a refusal unless the caller says skip. */
export function rowPlan<I>(row: number, cells: Readonly<Record<string, string>>, naturalKey: string, label: string): ImportRowPlan<I> & { input: I | null } {
  return { row, outcome: 'create', naturalKey, label, problems: [], notes: [], input: null, cells };
}
