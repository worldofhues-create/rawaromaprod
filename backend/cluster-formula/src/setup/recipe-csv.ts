/**
 * The recipe file reader for the Vault's recipe import (lane vaultsetup). PURE and deterministic —
 * no AI, no fuzzy matching, no network: the same text always yields the same rows and the same
 * errors. It runs only on the Vault box (FormulaSetupService.importRecipes); the recipe text never
 * leaves it and is never logged.
 *
 * ACCEPTED SHAPE. A header row, then one row per ingredient line. Comma-separated (RFC-4180
 * quoting), or the tab-separated text a spreadsheet copy/paste produces, or semicolon-separated —
 * picked from the header line: a tab wins, then a semicolon when the header has no comma.
 * Header names are matched case-insensitively, ignoring spaces/punctuation:
 *
 *   which formula   product_code | product            → the product's formula (formula_product_link)
 *                   formula_code | formula            → the formula with that code
 *                   (both columns may be present: the first non-empty one on a row wins)
 *                   A BLANK cell repeats the row above (a spreadsheet's merged/blank-down cells);
 *                   the first data row must name one.
 *   which material  material_code                     → exact material code
 *                   material_name                     → exact material name
 *                   material | ingredient | raw_material → code first, then name
 *                   floor_code | rm_alias | alias     → refused: floor codes are not held on the
 *                                                       Vault box (material-catalogue.ts), by design
 *   how much        percentage | percent | pct | % | w/w — a number > 0 and ≤ 100, at most 6
 *                   decimals, an optional trailing "%". A decimal comma is accepted only in a tab-
 *                   or semicolon-separated file (in a comma file it would be a column break).
 *   optional        stage | stage_name | phase        → the formula stage the line belongs to
 *                   sequence | seq | sequence_no | order → a whole number 1..100000
 *
 * Row-level problems (missing cell, bad number, ≤ 0, > 100) are reported per line and BLOCK the
 * import; whole-recipe checks (the total, duplicates, matching) are the service's job.
 */
import { parseCsv } from '../compliance/csv.js';

/** Upper bound on data rows in one recipe file (same bound as the compliance imports). */
export const MAX_RECIPE_ROWS = 5000;
/** At most this many decimals in a percentage. */
export const MAX_PERCENT_DECIMALS = 6;

export type TargetKind = 'product' | 'formula';
export type MaterialKind = 'code' | 'name' | 'either';

export interface RecipeLine {
  /** 1-based line number in the pasted/uploaded text. */
  line: number;
  /** The formula reference (after blank-down) and how to read it. */
  target: string;
  targetKind: TargetKind;
  /** The material reference as typed, and how to read it. */
  material: string;
  materialKind: MaterialKind;
  /** The percentage as typed, and parsed (null when it did not parse). */
  percentText: string;
  percentage: number | null;
  stage: string | null;
  sequenceNo: number | null;
  /** Blocking problems found on this line alone. */
  errors: string[];
}

export interface ParsedRecipeFile {
  delimiter: ',' | '\t' | ';';
  lines: RecipeLine[];
  /** Problems with the file as a whole (no header, missing columns, too many rows). */
  fileErrors: string[];
}

const norm = (h: string) => h.toLowerCase().replace(/%/g, ' pct ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const TARGET_COLUMNS: Record<string, TargetKind> = {
  product_code: 'product',
  product: 'product',
  formula_code: 'formula',
  formula: 'formula',
};
const MATERIAL_COLUMNS: Record<string, MaterialKind> = {
  material_code: 'code',
  material_name: 'name',
  material: 'either',
  ingredient: 'either',
  raw_material: 'either',
};
const FLOOR_CODE_COLUMNS = new Set(['floor_code', 'rm_alias', 'alias', 'rm_alias_name']);
const PERCENT_COLUMNS = new Set(['percentage', 'percent', 'pct', 'percentage_pct', 'pct_pct', 'w_w', 'w_w_pct', 'ww', 'percent_pct']);
const STAGE_COLUMNS = new Set(['stage', 'stage_name', 'phase']);
const SEQUENCE_COLUMNS = new Set(['sequence', 'seq', 'sequence_no', 'seq_no', 'sequence_number', 'order']);

/** The delimiter, from the first non-empty line: a tab wins, then ';' when there is no ','. */
export function detectDelimiter(text: string): ',' | '\t' | ';' {
  const first = text.replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  if (first.includes('\t')) return '\t';
  if (!first.includes(',') && first.includes(';')) return ';';
  return ',';
}

/** Parse one percentage cell. Returns the number, or an error sentence. */
export function parsePercent(raw: string, delimiter: ',' | '\t' | ';'): { value: number } | { error: string } {
  let t = raw.trim();
  if (t === '') return { error: 'percentage is missing' };
  if (t.endsWith('%')) t = t.slice(0, -1).trim();
  if (delimiter !== ',' && /^[+-]?\d+,\d+$/.test(t)) t = t.replace(',', '.');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return { error: `percentage "${raw.trim()}" is not a number` };
  const decimals = (t.split('.')[1] ?? '').length;
  if (decimals > MAX_PERCENT_DECIMALS) return { error: `percentage "${raw.trim()}" has more than ${MAX_PERCENT_DECIMALS} decimals` };
  const value = Number(t);
  if (!Number.isFinite(value)) return { error: `percentage "${raw.trim()}" is not a number` };
  if (value <= 0) return { error: `percentage must be greater than 0 (got ${raw.trim()})` };
  if (value > 100) return { error: `percentage cannot exceed 100 (got ${raw.trim()})` };
  return { value };
}

export function parseRecipeFile(text: string): ParsedRecipeFile {
  const delimiter = detectDelimiter(text);
  const table = parseCsv(text, delimiter);
  const fileErrors: string[] = [];
  const header = table.header.map(norm);
  if (header.length === 0 || header.every((h) => h === '')) {
    return { delimiter, lines: [], fileErrors: ['The file is empty — paste a header row and at least one ingredient line.'] };
  }

  const targetCols = header.map((h, i) => ({ i, kind: TARGET_COLUMNS[h] })).filter((c): c is { i: number; kind: TargetKind } => !!c.kind);
  const materialCols = header.map((h, i) => ({ i, kind: MATERIAL_COLUMNS[h] })).filter((c): c is { i: number; kind: MaterialKind } => !!c.kind);
  const floorCol = header.findIndex((h) => FLOOR_CODE_COLUMNS.has(h));
  const pctCol = header.findIndex((h) => PERCENT_COLUMNS.has(h));
  const stageCol = header.findIndex((h) => STAGE_COLUMNS.has(h));
  const seqCol = header.findIndex((h) => SEQUENCE_COLUMNS.has(h));

  if (targetCols.length === 0) fileErrors.push('No product or formula column — add a "product_code" (or "formula_code") column.');
  if (materialCols.length === 0) {
    fileErrors.push(
      floorCol >= 0
        ? 'Floor codes are not known to the Vault (they stay on the factory box). Use a "material_code" or "material_name" column instead.'
        : 'No material column — add a "material_code" (or "material_name") column.',
    );
  }
  if (pctCol < 0) fileErrors.push('No percentage column — add a "percentage" column.');
  if (table.rows.length > MAX_RECIPE_ROWS) fileErrors.push(`Too many lines (${table.rows.length}); at most ${MAX_RECIPE_ROWS} per upload.`);
  if (fileErrors.length > 0) return { delimiter, lines: [], fileErrors };

  // parseCsv keys cells by its own normalised header; read by position instead (header order).
  const rawHeader = table.header;
  const cell = (cells: Record<string, string>, i: number) => (i >= 0 ? (cells[rawHeader[i]!] ?? '').trim() : '');

  const lines: RecipeLine[] = [];
  let carried: { target: string; kind: TargetKind } | null = null;
  for (const row of table.rows) {
    const errors: string[] = [];

    let target: { target: string; kind: TargetKind } | null = null;
    for (const c of targetCols) {
      const v = cell(row.cells, c.i);
      if (v) { target = { target: v, kind: c.kind }; break; }
    }
    if (!target) {
      if (carried) target = carried;
      else errors.push('no product or formula on this line (and none above it to repeat)');
    }
    if (target) carried = target;

    let material = '';
    let materialKind: MaterialKind = 'either';
    for (const c of materialCols) {
      const v = cell(row.cells, c.i);
      if (v) { material = v; materialKind = c.kind; break; }
    }
    if (!material) errors.push('material is missing');

    const percentText = cell(row.cells, pctCol);
    const pct = parsePercent(percentText, delimiter);
    if ('error' in pct) errors.push(pct.error);

    const stage = cell(row.cells, stageCol) || null;
    let sequenceNo: number | null = null;
    const seqText = cell(row.cells, seqCol);
    if (seqText) {
      if (/^\d+$/.test(seqText) && Number(seqText) >= 1 && Number(seqText) <= 100_000) sequenceNo = Number(seqText);
      else errors.push(`sequence "${seqText}" must be a whole number from 1 to 100000`);
    }

    lines.push({
      line: row.line,
      target: target?.target ?? '',
      targetKind: target?.kind ?? 'product',
      material,
      materialKind,
      percentText,
      percentage: 'value' in pct ? pct.value : null,
      stage,
      sequenceNo,
      errors,
    });
  }
  if (lines.length === 0) fileErrors.push('No ingredient lines under the header.');
  return { delimiter, lines, fileErrors };
}

/** Sum of percentages in 1e-6 units (exact for ≤ 6 decimals), returned as a number. */
export function totalPercent(values: number[]): number {
  const micro = values.reduce((a, v) => a + Math.round(v * 1_000_000), 0);
  return micro / 1_000_000;
}

/** True when a recipe's total is 100 % (exactly, at 6 decimals). */
export function isHundred(total: number): boolean {
  return Math.round(total * 1_000_000) === 100_000_000;
}
