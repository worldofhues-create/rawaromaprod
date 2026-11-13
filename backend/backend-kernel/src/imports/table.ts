/**
 * IMPORT-RP — a table of cells into rows a kind can judge.
 *
 * HEADER NAMES ARE FIXED; ORDER AND CASE ARE NOT. Compared after lower-casing and dropping everything
 * but letters and digits, so "Supplier lot", "supplier_lot" and "SUPPLIERLOT" are one header, and each
 * column has a short list of other names people use. A missing required column refuses the FILE and
 * names it: reading the rows anyway would report 400 rows each "missing a name" when the truth is one
 * column heading. An unknown column is read past and listed, so a person can keep a notes column.
 *
 * THE ROW NUMBER IS THE SPREADSHEET'S. Blank rows are passed over but still counted, so "row 86" is
 * the row the person has open, not the 84th non-empty one.
 */
import { IMPORT_MAX_CELL, IMPORT_MAX_COLUMNS, IMPORT_MAX_ROWS, type ImportKindSpec } from './model.js';

const fold = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The column a problems sheet adds. Read past on the way back in. */
export const PROBLEM_HEADER = 'Problem';

export interface ImportTableRow {
  readonly row: number;
  /** Cell text by column KEY; a column the file does not carry is "". */
  readonly values: Readonly<Record<string, string>>;
  /** Cell text by the template's HEADER, for the problems sheet. */
  readonly cells: Readonly<Record<string, string>>;
}

export type ImportTable =
  | { readonly ok: false; readonly fileProblems: readonly string[] }
  | { readonly ok: true; readonly rows: readonly ImportTableRow[]; readonly ignoredColumns: readonly string[];
      /** Column keys the file's header carries. */
      readonly present: ReadonlySet<string> };

/* One leading apostrophe before = + - @ is how this system's own downloads keep such a cell as text
   (sheet.ts `guard`), and how a person keeps "-2.5" from becoming a sum. It is not part of the value. */
const unguard = (s: string): string => (/^'[=+\-@]/.test(s) ? s.slice(1) : s);

export function readImportTable(spec: ImportKindSpec, table: readonly (readonly string[])[]): ImportTable {
  const at = table.findIndex((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (at < 0) return { ok: false, fileProblems: ['The file is empty. Download the template, fill in a row and upload it.'] };
  const header = table[at]!.map((c) => String(c ?? '').trim());
  if (header.length > IMPORT_MAX_COLUMNS) {
    return { ok: false, fileProblems: [`The file has ${header.length} columns. The most a file may have is ${IMPORT_MAX_COLUMNS}.`] };
  }

  const byFold = new Map<string, string>();
  for (const col of spec.columns) for (const name of [col.header, col.key, ...col.aliases]) byFold.set(fold(name), col.key);
  const index = new Map<string, number>();
  const ignored: string[] = [];
  const problems: string[] = [];
  header.forEach((h, i) => {
    if (h === '' || fold(h) === fold(PROBLEM_HEADER)) return;
    const key = byFold.get(fold(h));
    if (!key) { ignored.push(h); return; }
    if (index.has(key)) {
      const col = spec.columns.find((c) => c.key === key)!;
      problems.push(`Two columns are both "${col.header}" ("${header[index.get(key)!]}" and "${h}"). Remove one.`);
      return;
    }
    index.set(key, i);
  });
  for (const col of spec.columns) {
    if (col.required && !index.has(col.key)) problems.push(`The column "${col.header}" is missing. Download the template again; the names matter, the order does not.`);
  }
  for (const group of spec.oneOf ?? []) {
    if (!group.some((k) => index.has(k))) {
      const names = group.map((k) => `"${spec.columns.find((c) => c.key === k)!.header}"`);
      problems.push(`The file needs at least one of these columns: ${names.join(', ')}.`);
    }
  }
  if (problems.length) return { ok: false, fileProblems: problems };

  const rows: ImportTableRow[] = [];
  for (let n = at + 1; n < table.length; n += 1) {
    const raw = table[n]!;
    if (!raw.some((c) => String(c ?? '').trim() !== '')) continue;
    if (rows.length >= IMPORT_MAX_ROWS) {
      return { ok: false, fileProblems: [`The file has more than ${IMPORT_MAX_ROWS} rows. Split it into smaller files; nothing was read past the limit, so nothing was imported.`] };
    }
    const values: Record<string, string> = {};
    const cells: Record<string, string> = {};
    for (const col of spec.columns) {
      const i = index.get(col.key);
      const text = i === undefined ? '' : unguard(String(raw[i] ?? '').trim());
      if (text.length > IMPORT_MAX_CELL) {
        return { ok: false, fileProblems: [`Row ${n + 1}, "${col.header}": the cell holds ${text.length} characters. The most a cell may hold is ${IMPORT_MAX_CELL}.`] };
      }
      // A CSV has no formula cells, only text a spreadsheet would RUN as one the next time the file
      // is opened. Refused in words; never read.
      if (text.startsWith('=')) {
        return { ok: false, fileProblems: [`Row ${n + 1}, "${col.header}": the cell holds a formula (it starts with "="). Replace it with its value; a formula is never worked out here.`] };
      }
      values[col.key] = text;
      if (i !== undefined) cells[col.header] = text;
    }
    rows.push({ row: n + 1, values, cells });
  }
  return { ok: true, rows, ignoredColumns: ignored, present: new Set(index.keys()) };
}
