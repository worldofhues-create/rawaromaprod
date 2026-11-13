/**
 * IMPORT-RP — the files a person is handed, as tables of text.
 *
 * THE TEMPLATE TEACHES THE FORMAT: an Instructions sheet written from the kind's own registry entry,
 * and a Data sheet with the header and ONE example row, which the importer refuses by name so it
 * cannot become a record.
 *
 * THE PROBLEMS SHEET IS THE PERSON'S OWN SHEET: their refused rows, in the template's columns, with a
 * "Problem" column added. They fix the cells and upload that file; the importer reads past the added
 * column.
 *
 * Every cell of every download is guarded against formula injection where it is written
 * (sheet.ts: `writeWorkbook`, `toCsv`).
 */
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, type ImportKindSpec } from './model.js';
import { DATA_SHEET, INSTRUCTIONS_SHEET, toCsv, writeWorkbook, type WorkbookSheet } from './sheet.js';
import { PROBLEM_HEADER } from './table.js';

/** What every kind's Instructions sheet says, then what the kind adds. */
export function importInstructions(spec: ImportKindSpec): string[] {
  return [
    'Fill in the "Data" sheet: one row for each record. Keep the column names as they are; their order does not matter, and a column of your own (notes, say) is read past.',
    'Delete the example row before you upload. It is refused if left in, so it can never become a record.',
    'Upload the file, read the preview, then import. Nothing is written until you press Import.',
    'Dates are day first: 22/09/2026, or 2026-09-22. A quantity needs its unit. A cell holding a formula is refused: paste its value instead.',
    `A file may hold up to ${IMPORT_MAX_ROWS.toLocaleString('en-IN')} rows and ${IMPORT_MAX_BYTES / 1048576} MB. Excel (.xlsx) and CSV (UTF-8) are both read.`,
    'If rows are refused, download "rows to fix": it is your own rows with a Problem column. Correct them and upload that file.',
    ...spec.instructions,
  ];
}

function dataSheet(spec: ImportKindSpec): WorkbookSheet {
  return { name: DATA_SHEET, rows: [spec.columns.map((c) => c.header), spec.columns.map((c) => c.example)] };
}
function instructionsSheet(spec: ImportKindSpec): WorkbookSheet {
  const rows: string[][] = [[`${spec.title}: how to fill in this file`], []];
  importInstructions(spec).forEach((line, i) => rows.push([`${i + 1}. ${line}`]));
  rows.push([], ['Column', 'Required', 'What goes in it', 'Example']);
  for (const c of spec.columns) rows.push([c.header, c.required ? 'Yes' : 'No', c.help, c.example]);
  rows.push([], ['What identifies a row', spec.naturalKey], ['New or changed', spec.rule], ['A row is refused for', spec.refuses.join('; ')]);
  return { name: INSTRUCTIONS_SHEET, rows };
}

/** The template workbook: Instructions first, because it is what is read first. */
export function templateXlsx(spec: ImportKindSpec): Buffer {
  return writeWorkbook([instructionsSheet(spec), dataSheet(spec)]);
}
/** The CSV template: the header and the example row, with the byte order mark a spreadsheet needs. */
export function templateCsv(spec: ImportKindSpec): Buffer {
  return Buffer.from('﻿' + toCsv(dataSheet(spec).rows), 'utf8');
}

export interface ImportProblemRow {
  readonly cells: Readonly<Record<string, string>>;
  readonly problems: readonly string[];
}
function problemTable(spec: ImportKindSpec, rows: readonly ImportProblemRow[]): string[][] {
  const header = [...spec.columns.map((c) => c.header), PROBLEM_HEADER];
  return [header, ...rows.map((r) => [...spec.columns.map((c) => r.cells[c.header] ?? ''), r.problems.join(' ')])];
}
export function problemsXlsx(spec: ImportKindSpec, rows: readonly ImportProblemRow[]): Buffer {
  return writeWorkbook([{ name: DATA_SHEET, rows: problemTable(spec, rows) }]);
}
export function problemsCsv(spec: ImportKindSpec, rows: readonly ImportProblemRow[]): Buffer {
  return Buffer.from('﻿' + toCsv(problemTable(spec, rows)), 'utf8');
}

/** True when this row is the template's own example, left in. */
export function isExampleRow(spec: ImportKindSpec, values: Readonly<Record<string, string>>): boolean {
  const col = spec.columns.find((c) => c.key === spec.exampleKey);
  return !!col && col.example !== '' && (values[spec.exampleKey] ?? '').trim().toLowerCase() === col.example.trim().toLowerCase();
}
export const EXAMPLE_ROW_PROBLEM = 'This is the template\'s example row. Delete it, or replace it with a record of your own.';
