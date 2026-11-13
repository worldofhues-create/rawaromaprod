/**
 * IMPORT-RP — the pure half of the bulk import: the workbook reader and writer, the caps, header
 * matching, cell reading, the template and the problems sheet. No database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import {
  IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, cellDate, cellQuantity, cellSigned, cellWhole, casValid, csvCell, csvTable, decimalText, guard,
  importCommitRefusal, isExampleRow, parseDay, parseDecimal, problemsCsv, problemsXlsx, readImportFile, readImportTable,
  templateCsv, templateXlsx, writeWorkbook, type ImportKindSpec,
} from '../index.js';

const SPEC: ImportKindSpec = {
  kind: 'things', title: 'Things', permission: 'x:thing_import:write', mirrors: ['x:thing:write'], exampleKey: 'code',
  columns: [
    { key: 'code', header: 'Code', aliases: ['Thing code'], required: true, help: 'The code.', example: 'EXAMPLE-001' },
    { key: 'name', header: 'Name', aliases: [], required: true, help: 'The name.', example: 'An example' },
    { key: 'qty', header: 'Quantity', aliases: ['Qty'], required: false, help: 'How much.', example: '-2.5' },
  ],
  instructions: ['A thing has one code.'], naturalKey: 'Code', rule: 'Create only.', refuses: ['a code twice'],
};

/** A workbook made by hand, so the reader is tested against XML it did not write. */
function zipOf(files: Array<[string, string]>): Buffer {
  const parts: Buffer[] = [], dir: Buffer[] = []; let off = 0;
  for (const [name, text] of files) {
    const raw = Buffer.from(text), data = deflateRawSync(raw), nm = Buffer.from(name);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8);
    l.writeUInt32LE(crc32(raw), 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); l.copy(c, 6, 4, 30); c.writeUInt32LE(off, 42);
    parts.push(l, nm, data); dir.push(c, nm); off += 30 + nm.length + data.length;
  }
  const d = Buffer.concat(dir), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(d.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, d, e]);
}
const sheetOf = (rowsXml: string) => zipOf([
  ['xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
  ['xl/sharedStrings.xml', '<sst><si><t>Code</t></si><si><t>Name</t></si><si><t>Rose &amp; Co</t></si></sst>'],
  ['xl/worksheets/sheet1.xml', `<worksheet><sheetData>${rowsXml}</sheetData></worksheet>`],
]);

test('the template is a workbook with an Instructions sheet and a Data sheet, and reads back as its own header and example row', () => {
  const file = readImportFile(templateXlsx(SPEC));
  assert.equal(file.ok, true);
  if (!file.ok) return;
  assert.equal(file.format, 'xlsx');
  assert.deepEqual(file.table[0], ['Code', 'Name', 'Quantity']);
  // The example's "-2.5" is written guarded ('-2.5) so a spreadsheet shows text, and read back as typed.
  const table = readImportTable(SPEC, file.table);
  assert.equal(table.ok, true);
  if (!table.ok) return;
  assert.deepEqual(table.rows[0]!.values, { code: 'EXAMPLE-001', name: 'An example', qty: '-2.5' });
  assert.equal(isExampleRow(SPEC, table.rows[0]!.values), true);
  // The same template is the same bytes every time (no clock in it).
  assert.equal(templateXlsx(SPEC).equals(templateXlsx(SPEC)), true);
});

test('the CSV template carries a byte order mark and is read with it', () => {
  const bytes = templateCsv(SPEC);
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
  const file = readImportFile(bytes);
  assert.equal(file.ok && file.format === 'csv' && file.table[0]![0], 'Code');
});

test('CSV: quoted fields, a doubled quote, a line break inside quotes, CRLF, and a tab-separated paste', () => {
  assert.deepEqual(csvTable('a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",z\r\n'), [['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', 'z']]);
  assert.deepEqual(csvTable('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(csvTable('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
});

test('every download is defended against formula injection, in CSV and in xlsx', () => {
  for (const evil of ['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(A1)', '\t=1']) {
    assert.equal(guard(evil).startsWith("'"), true, evil);
    assert.equal(csvCell(evil).replace(/^"/, '').startsWith("'"), true, evil);
  }
  assert.equal(guard('Rose oil'), 'Rose oil');
  const rows = [{ cells: { Code: '=cmd|calc', Name: 'ok' }, problems: ['=2+2 is not a code'] }];
  const csv = problemsCsv(SPEC, rows).toString('utf8');
  assert.match(csv, /'=cmd\|calc/);
  assert.match(csv, /'=2\+2 is not a code/);
  // In the workbook no cell is a formula and the dangerous text is stored guarded, as an inline string.
  const back = readImportFile(problemsXlsx(SPEC, rows));
  assert.equal(back.ok, true);
  if (back.ok) { assert.equal(back.table[1]![0], "'=cmd|calc"); assert.deepEqual(back.table[0], ['Code', 'Name', 'Quantity', 'Problem']); }
});

test('the problems sheet is read back past its Problem column', () => {
  const back = readImportFile(problemsXlsx(SPEC, [{ cells: { Code: 'T-1', Name: 'One', Quantity: '3' }, problems: ['too many'] }]));
  assert.equal(back.ok, true);
  if (!back.ok) return;
  const table = readImportTable(SPEC, back.table);
  assert.equal(table.ok, true);
  if (table.ok) { assert.deepEqual(table.rows[0]!.values, { code: 'T-1', name: 'One', qty: '3' }); assert.deepEqual(table.ignoredColumns, []); }
});

test('a cell holding a formula is refused in a sentence and never worked out', () => {
  const file = readImportFile(sheetOf('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><f>1+1</f><v>2</v></c></row>'));
  assert.equal(file.ok, false);
  if (!file.ok) assert.match(file.problem, /Cell A2 holds a formula.*never worked out/);
  // In a CSV there are no formula cells, only text a spreadsheet would run: refused by the table reader.
  const csv = readImportFile(Buffer.from('Code,Name\n=1+1,x\n'));
  assert.equal(csv.ok, true);
  if (csv.ok) { const t = readImportTable(SPEC, csv.table); assert.equal(t.ok, false); if (!t.ok) assert.match(t.fileProblems[0]!, /Row 2, "Code": the cell holds a formula/); }
});

test('the caps: bytes, rows, columns, a row number in the millions, and a file that inflates past the limit', () => {
  const big = readImportFile(Buffer.alloc(IMPORT_MAX_BYTES + 1, 0x41));
  assert.equal(big.ok, false);
  if (!big.ok) assert.match(big.problem, /The most a file may be is 5 MB/);

  const far = readImportFile(sheetOf('<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="999999999"><c r="A999999999"><v>1</v></c></row>'));
  assert.equal(far.ok, false);
  if (!far.ok) assert.match(far.problem, /something on row 999999999/);

  const wide = readImportFile(sheetOf('<row r="1"><c r="CA1"><v>1</v></c></row>'));
  assert.equal(wide.ok, false);
  if (!wide.ok) assert.match(wide.problem, /more than 60 columns/);

  const lines = ['Code,Name', ...Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `T-${i},n`)].join('\n');
  const many = readImportFile(Buffer.from(lines));
  assert.equal(many.ok, true);
  if (many.ok) { const t = readImportTable(SPEC, many.table); assert.equal(t.ok, false); if (!t.ok) assert.match(t.fileProblems[0]!, /more than 5000 rows/); }

  // A zip bomb: 60 MB of one character deflates to about 60 KB and is stopped inside the inflate.
  const bomb = sheetOf(`<row r="1"><c r="A1" t="inlineStr"><is><t>${'A'.repeat(60 * 1024 * 1024)}</t></is></c></row>`);
  assert.ok(bomb.length < 200_000);
  const stopped = readImportFile(bomb);
  assert.equal(stopped.ok, false);
  if (!stopped.ok) assert.match(stopped.problem, /too large once it is opened/);
});

test('binary that is not a workbook, and a CSV that is not UTF-8, are refused in words', () => {
  const xls = readImportFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]));
  assert.equal(xls.ok, false);
  if (!xls.ok) assert.match(xls.problem, /older \.xls file must be saved as \.xlsx/);
  const latin = readImportFile(Buffer.from([0x43, 0x6f, 0x64, 0x65, 0x0a, 0xe9, 0x0a]));
  assert.equal(latin.ok, false);
  if (!latin.ok) assert.match(latin.problem, /not saved as UTF-8/);
  const junk = readImportFile(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40, 1)]));
  assert.equal(junk.ok, false);
  if (!junk.ok) assert.match(junk.problem, /could not be read as an Excel workbook/);
});

test('headers: any order, any case, punctuation ignored, other names accepted; a missing one names itself; an unknown one is listed', () => {
  const t = readImportTable(SPEC, [['my notes', 'NAME', 'thing_code', 'QTY'], [], ['x', 'One', 'T-1', '2'], ['', '', '', '']]);
  assert.equal(t.ok, true);
  if (t.ok) {
    assert.deepEqual(t.ignoredColumns, ['my notes']);
    assert.equal(t.rows.length, 1);
    assert.equal(t.rows[0]!.row, 3); // the spreadsheet's own row number, blank row counted
    assert.deepEqual(t.rows[0]!.values, { code: 'T-1', name: 'One', qty: '2' });
  }
  const missing = readImportTable(SPEC, [['Code'], ['T-1']]);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.fileProblems[0]!, /The column "Name" is missing/);
  const twice = readImportTable(SPEC, [['Code', 'Thing code', 'Name'], ['a', 'b', 'c']]);
  assert.equal(twice.ok, false);
  if (!twice.ok) assert.match(twice.fileProblems[0]!, /Two columns are both "Code"/);
  assert.equal(readImportTable(SPEC, [[], []]).ok, false);
});

test('dates: day first, ISO, a month name, an Excel serial; a month-first date is not guessed at', () => {
  assert.equal(parseDay('03/04/2026'), '2026-04-03');
  assert.equal(parseDay('3-4-2026'), '2026-04-03');
  assert.equal(parseDay('2026-04-03'), '2026-04-03');
  assert.equal(parseDay('03-Apr-2026'), '2026-04-03');
  assert.equal(parseDay('3 April 2026'), '2026-04-03');
  assert.equal(parseDay('46115'), '2026-04-03'); // what a real date cell holds
  assert.equal(parseDay('04/13/2026'), null); // month 13: never read as the 13th of April
  assert.equal(parseDay('31/02/2026'), null);
  assert.equal(parseDay('next week'), null);
  const bad = cellDate('04/13/2026', 'Expiry');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.problem, /"Expiry": "04\/13\/2026" is not a date/);
  assert.deepEqual(cellDate('', 'Expiry'), { ok: true, value: null });
});

test('quantities are exact decimals, never doubles; a zero change and a negative quantity are refused', () => {
  assert.equal(decimalText(parseDecimal('1,250.50')!), '1250.5');
  assert.equal(decimalText(parseDecimal('0.1')!), '0.1');
  assert.equal(decimalText(parseDecimal('-0.0300')!), '-0.03');
  assert.equal(parseDecimal('1.23456789', 4), null);
  assert.equal(parseDecimal('1e3'), null);
  assert.equal(parseDecimal('twelve'), null);
  assert.equal(cellQuantity('0', 'Quantity').ok, false);
  assert.equal(cellQuantity('-1', 'Quantity').ok, false);
  const q = cellQuantity('12.5', 'Quantity');
  assert.equal(q.ok && q.value && decimalText(q.value), '12.5');
  assert.equal(cellSigned('0', 'Change').ok, false);
  const s = cellSigned('-2.5', 'Change');
  assert.equal(s.ok && s.value?.negative, true);
  assert.equal(cellWhole('1,200', 'Line').ok, true);
  assert.equal(cellWhole('1.5', 'Line').ok, false);
});

test('a CAS number is checked by its check digit', () => {
  assert.equal(casValid('119-61-9'), true); // benzophenone
  assert.equal(casValid('64-17-5'), true); // ethanol
  assert.equal(casValid('119-61-8'), false);
  assert.equal(casValid('benzophenone'), false);
});

test('all-or-nothing is the default refusal; valid rows only is a choice; a file that would write nothing is refused either way', () => {
  const mixed = { rows: 3, create: 2, update: 0, skip: 0, refuse: 1 };
  assert.match(importCommitRefusal(mixed, 'all_or_nothing')!, /1 row has a problem, so nothing is imported/);
  assert.equal(importCommitRefusal(mixed, 'valid_only'), null);
  assert.match(importCommitRefusal({ rows: 2, create: 0, update: 0, skip: 2, refuse: 0 }, 'valid_only')!, /already on file/);
  assert.match(importCommitRefusal({ rows: 2, create: 0, update: 0, skip: 0, refuse: 2 }, 'valid_only')!, /Every row that would be written has a problem/);
  assert.match(importCommitRefusal({ rows: 0, create: 0, update: 0, skip: 0, refuse: 0 }, 'all_or_nothing')!, /no rows/);
});

test('a workbook of our own writing opens: the zip directory and CRCs are sound', () => {
  const wb = writeWorkbook([{ name: 'Data', rows: [['a', 'b'], ['1', 'é ₹ 中']] }]);
  const back = readImportFile(wb);
  assert.equal(back.ok, true);
  if (back.ok) assert.deepEqual(back.table, [['a', 'b'], ['1', 'é ₹ 中']]);
});
