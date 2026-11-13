/**
 * IMPORT-RP — uploaded bytes into a table of text, and a table of text into a workbook, with no
 * dependency. The repository has no spreadsheet library (checked: no xlsx, exceljs or csv package in
 * any package.json) and an .xlsx is a zip of a few small XML files, so `node:zlib` reads and writes it.
 *
 * READING. An upload is the one input that arrives from a stranger's spreadsheet program, so every
 * limit is checked BEFORE the work it protects against: the byte count before anything is parsed, the
 * inflated size inside the inflate (the size the zip directory declares is whatever the file claims,
 * and is not consulted), the row and column numbers as they are read. Each refusal is a sentence the
 * person can act on, and none is a truncation.
 *
 * NOTHING IS EVALUATED. A cell holding a formula is refused in words; its cached value is not read,
 * because a cached value is whatever the file says it is.
 *
 * WRITING. Every cell is an inline string: never a number, never a date, never a formula. The file
 * carries text, the importer reads text, and a cell this writes cannot be run by the program that
 * opens it. `guard()` (below) is the formula-injection defence every download passes through.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { IMPORT_MAX_BYTES, IMPORT_MAX_COLUMNS, IMPORT_MAX_INFLATED_BYTES, IMPORT_MAX_ROWS } from './model.js';

/** A file refused for what it is, in a sentence a person can act on. */
export class SheetRefused extends Error {
  constructor(message: string) { super(message); this.name = 'SheetRefused'; }
}

/* ── formula-injection defence (OWASP "CSV Injection") ───────────────────────────────────── */

/** Text that a spreadsheet would run (it starts with = + - @, or a tab / carriage return before one)
 *  is prefixed with an apostrophe, so it opens as text. Applied to every cell of every download. */
export function guard(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
}
/** One guarded CSV field, quoted when it has to be. */
export function csvCell(cell: string): string {
  const g = guard(cell);
  return /[",\r\n]/.test(g) ? `"${g.replace(/"/g, '""')}"` : g;
}
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map((c) => csvCell(c)).join(',')).join('\r\n') + '\r\n';
}

/* ── CSV in ───────────────────────────────────────────────────────────────────────────────── */

/** RFC 4180: quoted fields, "" for a quote, a line break inside quotes, CRLF or LF, a byte order mark
 *  tolerated. A tab- or semicolon-separated header (a spreadsheet's copy, a European export) is read
 *  as such. Blank lines are kept so a row number is the one the person sees. */
export function csvTable(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const delimiter = first.includes('\t') ? '\t' : !first.includes(',') && first.includes(';') ? ';' : ',';
  const rows: string[][] = [];
  let field = '', fields: string[] = [], quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) { fields.push(field); field = ''; }
    else if (c === '\r') continue;
    else if (c === '\n') { fields.push(field); rows.push(fields); fields = []; field = ''; }
    else field += c;
  }
  if (field !== '' || fields.length) { fields.push(field); rows.push(fields); }
  return rows;
}

/* ── zip ──────────────────────────────────────────────────────────────────────────────────── */

const tooBig = () => new SheetRefused('The workbook is too large once it is opened. Remove unused sheets and formatting, or split the file.');

/** The named entries of a zip, read through the central directory. Only entries `only` accepts are
 *  inflated, each under a hard output limit, and the total is counted against `maxInflated`. */
function unzip(buf: Buffer, only: (name: string) => boolean, budget: { left: number }): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || !only(name)) continue;
    if (local + 30 > buf.length) throw new Error('corrupt zip local header');
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    let body: Buffer;
    if (method === 0) body = Buffer.from(raw);
    else if (method === 8) {
      try { body = inflateRawSync(raw, { maxOutputLength: Math.max(1, budget.left) }); }
      catch (err) { if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw tooBig(); throw err; }
    } else throw new Error(`zip entry uses compression method ${method}`);
    if (body.length > budget.left) throw tooBig();
    budget.left -= body.length;
    out.set(name, body);
  }
  return out;
}

function zip(files: readonly (readonly [string, string])[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const raw = Buffer.from(text, 'utf8');
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    // A fixed timestamp (1 Jan 2026): the same template is the same bytes every time, and nothing
    // here reads a clock.
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(((2026 - 1980) << 9) | (1 << 5) | 1, 12);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 30); // version needed .. extra length, as the local header has them
    central.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, data);
    directory.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/* ── xlsx in ──────────────────────────────────────────────────────────────────────────────── */

const unescapeXml = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function textOf(xml: string): string {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let text = '';
  for (const m of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) text += unescapeXml(m[1] ?? '');
  return text;
}
const colIndex = (ref: string) => [...ref.replace(/\d+$/, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export const DATA_SHEET = 'Data';
export const INSTRUCTIONS_SHEET = 'Instructions';

/** Which sheet of an uploaded workbook holds the rows: the one named "Data", else the first that is
 *  not "Instructions". A person's own workbook has one sheet with any name, and that is read. */
export function dataSheetIndex(names: readonly string[]): number {
  const fold = (n: string) => n.trim().toLowerCase();
  const data = names.findIndex((n) => fold(n) === fold(DATA_SHEET));
  if (data >= 0) return data;
  const other = names.findIndex((n) => fold(n) !== fold(INSTRUCTIONS_SHEET));
  return other >= 0 ? other : 0;
}

/* Room for the header, and for the blank rows a person leaves between blocks; the row cap proper is
   on rows that hold something (table.ts). */
const MAX_ROW_NUMBER = IMPORT_MAX_ROWS * 2 + 1;

function xlsxTable(buf: Buffer): string[][] {
  const budget = { left: IMPORT_MAX_INFLATED_BYTES };
  // Two passes: the workbook's own index first, then only the shared strings and the one sheet.
  const index = unzip(buf, (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels', budget);
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = index.get('xl/workbook.xml')?.toString('utf8');
  const rels = index.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  const sheets = wb ? [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({
    name: unescapeXml(/\bname="([^"]*)"/.exec(m[1]!)?.[1] ?? ''), rid: /\br:id="([^"]+)"/.exec(m[1]!)?.[1] })) : [];
  const chosen = sheets.length ? sheets[Math.min(Math.max(0, dataSheetIndex(sheets.map((x) => x.name))), sheets.length - 1)] : undefined;
  if (chosen?.rid && rels) {
    const rel = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => m[1]!).find((a) => a.includes(`Id="${chosen.rid}"`));
    const target = rel ? /Target="([^"]+)"/.exec(rel)?.[1] : undefined;
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  const files = unzip(buf, (n) => n === 'xl/sharedStrings.xml' || n === sheetPath, budget);
  const shared: string[] = [];
  const sst = files.get('xl/sharedStrings.xml');
  if (sst) for (const m of sst.toString('utf8').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(textOf(m[1] ?? ''));
  const sheet = files.get(sheetPath);
  if (!sheet) throw new Error('the workbook has no worksheet');
  const rows: string[][] = [];
  for (const rm of sheet.toString('utf8').matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const line = Number(/\br="(\d+)"/.exec(rm[1]!)?.[1] ?? rows.length + 1);
    if (line > MAX_ROW_NUMBER) {
      throw new SheetRefused(`The sheet has something on row ${line}. The most a file may have is ${IMPORT_MAX_ROWS} rows; delete the rows below your data, or split the file.`);
    }
    while (rows.length < line - 1) rows.push([]);
    const cells: string[] = [];
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]!;
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      const inner = cm[2] ?? '';
      if (/<f[\s>/]/.test(inner)) {
        throw new SheetRefused(`Cell ${ref ?? `on row ${line}`} holds a formula. Replace it with its value (copy, then paste values); a formula is never worked out here.`);
      }
      const at = ref ? colIndex(ref) : cells.length;
      if (at >= IMPORT_MAX_COLUMNS) throw new SheetRefused(`Row ${line} uses more than ${IMPORT_MAX_COLUMNS} columns. The most a file may have is ${IMPORT_MAX_COLUMNS}.`);
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 's') value = v === undefined ? '' : shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
      else if (type === 'str' || type === 'b' || type === 'e') value = unescapeXml(v ?? '');
      // A number cell: a spreadsheet stores 1.1 as 1.1000000000000001. The shortest decimal that is
      // the same number is what the person typed.
      else value = v === undefined ? '' : (/e/i.test(v) || v.includes('.') ? String(Number(v)) : v);
      cells[at] = value;
    }
    rows.push(Array.from(cells, (c) => c ?? ''));
  }
  return rows;
}

export type ImportFile =
  | { readonly ok: true; readonly format: 'csv' | 'xlsx'; readonly table: string[][] }
  | { readonly ok: false; readonly format: 'csv' | 'xlsx'; readonly problem: string };

/** The uploaded bytes as a table of text, or the sentence that says why not. */
export function readImportFile(bytes: Buffer): ImportFile {
  const xlsx = bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
  const format = xlsx ? 'xlsx' : 'csv';
  const no = (problem: string): ImportFile => ({ ok: false, format, problem });
  if (bytes.length === 0) return no('The file is empty.');
  if (bytes.length > IMPORT_MAX_BYTES) {
    return no(`The file is ${(bytes.length / 1048576).toFixed(1)} MB. The most a file may be is ${IMPORT_MAX_BYTES / 1048576} MB; split it into smaller files.`);
  }
  if (xlsx) {
    try { return { ok: true, format, table: xlsxTable(bytes) }; }
    catch (err) {
      if (err instanceof SheetRefused) return no(err.message);
      return no('The file could not be read as an Excel workbook (.xlsx). Save it again as .xlsx or as CSV and upload that.');
    }
  }
  // An old .xls, a PDF, an image: binary that is not a zip. A NUL byte does not occur in a UTF-8 CSV.
  if (bytes.subarray(0, 4096).includes(0)) return no('This is not a CSV or an .xlsx workbook. An older .xls file must be saved as .xlsx first.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return no('The CSV is not saved as UTF-8. In Excel choose "CSV UTF-8 (Comma delimited)" when you save it.'); }
  const table = csvTable(text);
  if (table.length > MAX_ROW_NUMBER) return no(`The file has ${table.length} lines. The most a file may have is ${IMPORT_MAX_ROWS} rows; split it.`);
  return { ok: true, format, table };
}

/* ── xlsx out ─────────────────────────────────────────────────────────────────────────────── */

export interface WorkbookSheet { readonly name: string; readonly rows: readonly (readonly string[])[] }

/* XML 1.0 cannot carry most control characters, escaped or not; a workbook holding one does not
   open. They are dropped, tab and newline kept. */
const xml = (s: string): string => s
  .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i: number): string => {
  let n = i + 1, out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
};
function sheetXml(sheet: WorkbookSheet): string {
  const width = Math.max(1, ...sheet.rows.map((r) => r.length));
  const cols = Array.from({ length: width }, (_, i) => {
    const longest = Math.max(0, ...sheet.rows.map((r) => (r[i] ?? '').length));
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(12, longest + 2))}" customWidth="1"/>`;
  }).join('');
  const rows = sheet.rows.map((r, n) => {
    const cells = r.map((c, i) => (c === '' ? '' :
      `<c r="${colName(i)}${n + 1}" t="inlineStr"${n === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(guard(c))}</t></is></c>`)).join('');
    return `<row r="${n + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${rows}</sheetData></worksheet>`;
}
/* Sheet names: at most 31 characters and none of : \ / ? * [ ]. */
const sheetName = (s: string): string => s.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'Sheet';

/** The sheets as one .xlsx. The first row of each sheet is bold. Every cell is guarded text. */
export function writeWorkbook(sheets: readonly WorkbookSheet[]): Buffer {
  const head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const pkg = 'http://schemas.openxmlformats.org/package/2006';
  const files: [string, string][] = [
    ['[Content_Types].xml', `${head}<Types xmlns="${pkg}/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
      + `<Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + `</Types>`],
    ['_rels/.rels', `${head}<Relationships xmlns="${pkg}/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${head}<workbook xmlns="${main}" xmlns:r="${rel}"><sheets>`
      + sheets.map((s, i) => `<sheet name="${xml(sheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + `</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${head}<Relationships xmlns="${pkg}/relationships">`
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="${rel}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `${head}<styleSheet xmlns="${main}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>`
      + `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`
      + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
      + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
      + `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>`
      + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zip(files);
}
