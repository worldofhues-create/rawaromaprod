/**
 * Lane vaultsetup — the recipe file reader (setup/recipe-csv.ts). Pure: no database, no network,
 * no AI. The same text always gives the same lines and the same errors.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDelimiter, isHundred, parsePercent, parseRecipeFile, totalPercent } from '../setup/recipe-csv.js';

test('comma CSV: header aliases, quoting, trailing %, CRLF, BOM and blank lines', () => {
  const text = '﻿Product Code,Material Name,Percentage (%),Stage,Seq\r\n'
    + 'OUD-1,"Linalool, natural",12.5%,Top,1\r\n'
    + '\r\n'
    + 'OUD-1,Hedione,87.5,Heart,2\r\n';
  const r = parseRecipeFile(text);
  assert.equal(r.delimiter, ',');
  assert.deepEqual(r.fileErrors, []);
  assert.equal(r.lines.length, 2);
  assert.deepEqual(
    r.lines.map((l) => [l.line, l.target, l.targetKind, l.material, l.materialKind, l.percentage, l.stage, l.sequenceNo, l.errors]),
    [
      [2, 'OUD-1', 'product', 'Linalool, natural', 'name', 12.5, 'Top', 1, []],
      [4, 'OUD-1', 'product', 'Hedione', 'name', 87.5, 'Heart', 2, []],
    ],
  );
});

test('tab-separated text pasted from a spreadsheet: decimal comma accepted, blank target repeats the row above', () => {
  const text = 'formula_code\tmaterial_code\tpct\n'
    + 'F-OUD-1\tRM-001\t33,3\n'
    + '\tRM-002\t66,7\n';
  const r = parseRecipeFile(text);
  assert.equal(r.delimiter, '\t');
  assert.deepEqual(r.fileErrors, []);
  assert.deepEqual(r.lines.map((l) => [l.target, l.targetKind, l.material, l.materialKind, l.percentage]), [
    ['F-OUD-1', 'formula', 'RM-001', 'code', 33.3],
    ['F-OUD-1', 'formula', 'RM-002', 'code', 66.7],
  ]);
});

test('semicolon-separated export (European spreadsheets)', () => {
  assert.equal(detectDelimiter('product;material;percentage\nA;B;1'), ';');
  const r = parseRecipeFile('product;material;percentage\nA;B;100,0\n');
  assert.deepEqual(r.fileErrors, []);
  assert.equal(r.lines[0]!.percentage, 100);
  assert.equal(r.lines[0]!.materialKind, 'either');
});

test('percentages: ≤ 0 blocks, > 100 blocks, not-a-number blocks, too many decimals blocks, a decimal comma in a comma file is a column break', () => {
  assert.deepEqual(parsePercent('0', ','), { error: 'percentage must be greater than 0 (got 0)' });
  assert.deepEqual(parsePercent('-2.5', ','), { error: 'percentage must be greater than 0 (got -2.5)' });
  assert.deepEqual(parsePercent('100.0001', ','), { error: 'percentage cannot exceed 100 (got 100.0001)' });
  assert.deepEqual(parsePercent('abc', ','), { error: 'percentage "abc" is not a number' });
  assert.deepEqual(parsePercent('1e2', ','), { error: 'percentage "1e2" is not a number' });
  assert.deepEqual(parsePercent('', ','), { error: 'percentage is missing' });
  assert.deepEqual(parsePercent('1.1234567', ','), { error: 'percentage "1.1234567" has more than 6 decimals' });
  assert.deepEqual(parsePercent('12,5', ','), { error: 'percentage "12,5" is not a number' });
  assert.deepEqual(parsePercent(' 7.25 % ', ','), { value: 7.25 });
  assert.deepEqual(parsePercent('.5', '\t'), { value: 0.5 });
  assert.deepEqual(parsePercent('100', ','), { value: 100 });

  const r = parseRecipeFile('product_code,material_code,percentage\nA,M1,0\nA,M2,-1\nA,M3,x\n');
  assert.deepEqual(r.fileErrors, []);
  assert.deepEqual(r.lines.map((l) => l.errors), [
    ['percentage must be greater than 0 (got 0)'],
    ['percentage must be greater than 0 (got -1)'],
    ['percentage "x" is not a number'],
  ]);
});

test('missing cells and bad sequence numbers are per-line errors; the first line cannot be blank-down', () => {
  const r = parseRecipeFile('product_code,material_code,percentage,sequence\n,M1,10,1\nA,,10,2\nA,M3,,x\n');
  assert.deepEqual(r.lines.map((l) => l.errors), [
    ['no product or formula on this line (and none above it to repeat)'],
    ['material is missing'],
    ['percentage is missing', 'sequence "x" must be a whole number from 1 to 100000'],
  ]);
});

test('file-level problems: empty file, missing columns, floor codes are refused (they never reach the Vault)', () => {
  assert.deepEqual(parseRecipeFile('').fileErrors, ['The file is empty — paste a header row and at least one ingredient line.']);
  assert.deepEqual(parseRecipeFile('material_code,percentage\nM,1').fileErrors, [
    'No product or formula column — add a "product_code" (or "formula_code") column.',
  ]);
  assert.deepEqual(parseRecipeFile('product_code,floor_code,percentage\nA,RM-07,100').fileErrors, [
    'Floor codes are not known to the Vault (they stay on the factory box). Use a "material_code" or "material_name" column instead.',
  ]);
  assert.deepEqual(parseRecipeFile('product_code,material_code\nA,M').fileErrors, ['No percentage column — add a "percentage" column.']);
  assert.deepEqual(parseRecipeFile('product_code,material_code,percentage\n').fileErrors, ['No ingredient lines under the header.']);
});

test('when both product and formula columns exist, the first non-empty one on the row wins', () => {
  const r = parseRecipeFile('product_code,formula_code,material_code,percentage\nP1,,M,50\n,F-9,M,50\n');
  assert.deepEqual(r.lines.map((l) => [l.target, l.targetKind]), [['P1', 'product'], ['F-9', 'formula']]);
});

test('totals are exact at 6 decimals (no floating-point drift), and only exactly 100 counts as 100', () => {
  assert.equal(totalPercent([33.333333, 33.333333, 33.333334]), 100);
  assert.equal(isHundred(totalPercent([33.333333, 33.333333, 33.333334])), true);
  assert.equal(isHundred(totalPercent([0.1, 0.2, 99.7])), true);
  assert.equal(isHundred(totalPercent([50, 49.999999])), false);
  assert.equal(totalPercent([12.5, 80]), 92.5);
});

test('deterministic: the same text parses to the same result every time', () => {
  const text = 'product,ingredient,%\nA,Rose oxide,1.5\n,Iso E Super,98.5\n';
  assert.deepEqual(parseRecipeFile(text), parseRecipeFile(text));
  assert.deepEqual(parseRecipeFile(text).lines.map((l) => [l.target, l.material, l.percentage]), [
    ['A', 'Rose oxide', 1.5],
    ['A', 'Iso E Super', 98.5],
  ]);
});
