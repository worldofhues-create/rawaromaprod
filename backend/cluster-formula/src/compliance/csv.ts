/**
 * Minimal RFC-4180 CSV reader for the Vault's compliance-data imports: comma-separated, optional
 * double-quoted fields ("" escapes a quote), CRLF or LF, first row = header (case-insensitive,
 * trimmed, spaces → underscores). Pure; no dependency.
 */
export interface CsvTable {
  readonly header: string[];
  /** Each row keyed by normalised header name, plus its 1-based source line number. */
  readonly rows: { line: number; cells: Record<string, string> }[];
}

export const MAX_IMPORT_ROWS = 5000;

export function parseCsv(text: string): CsvTable {
  const records: { line: number; fields: string[] }[] = [];
  let field = '';
  let fields: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { fields.push(field); field = ''; }
    else if (c === '\r') continue;
    else if (c === '\n') {
      fields.push(field); records.push({ line: recordLine, fields }); fields = []; field = '';
      line++; recordLine = line;
    } else field += c;
  }
  if (field !== '' || fields.length > 0) { fields.push(field); records.push({ line: recordLine, fields }); }
  const nonEmpty = records.filter((r) => r.fields.some((f) => f.trim() !== ''));
  const [head, ...body] = nonEmpty;
  const header = (head?.fields ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return {
    header,
    rows: body.map((r) => ({
      line: r.line,
      cells: Object.fromEntries(header.map((h, i) => [h, (r.fields[i] ?? '').trim()])),
    })),
  };
}
