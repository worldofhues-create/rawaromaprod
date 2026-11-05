/**
 * PROD-A-2 — weight display (production-floor plan §12.5). web/weight.js runs in a `vm` as the page
 * loads it. Stored weights are integer mg; these are the display rules the owner set.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx: any = {};
vm.runInNewContext(readFileSync(join(ROOT, 'web/weight.js'), 'utf8'), ctx);
const W = ctx.RaWeight;

test('smart g: under 1 g, 1-999.99 g, and kg from 1000 g', () => {
  assert.equal(W.formatWeight(450), '0.45 g');
  assert.equal(W.formatWeight(125500), '125.5 g');
  assert.equal(W.formatWeight(999990), '999.99 g');
  assert.equal(W.formatWeight(1250000), '1.25 kg');
  assert.equal(W.formatWeight(1000000), '1 kg');
  assert.equal(W.formatWeight(125000), '125 g');
});

test('at most 2 decimals, rounded half away from zero, for display only', () => {
  assert.equal(W.formatWeight(125474), '125.47 g');
  assert.equal(W.formatWeight(125475), '125.48 g');
  assert.equal(W.formatWeight(1234567), '1.23 kg');
});

test('the scale resolution is respected: a 0.1 g scale never shows 125.47 g', () => {
  assert.equal(W.formatWeight(125470, 'g', 100), '125.5 g');
  assert.equal(W.formatWeight(125440, 'g', 100), '125.4 g');
  assert.equal(W.formatWeight(125440, 'g', 1000), '125 g');
});

test('explicit units, and one unit per line chosen from the target', () => {
  assert.equal(W.formatWeight(1250000, 'kg'), '1.25 kg');
  assert.equal(W.formatWeight(450, 'mg'), '450 mg');
  const u = W.lineUnit(1250000, 'g');
  assert.equal(u, 'kg');
  // the actual is shown in the target's unit even though it alone would be grams
  assert.equal(W.formatIn(999000, u), '1 kg');
  assert.equal(W.formatTolerance(125000000 / 1000, 1250, 'g'), 'target 125.00 g ± 1.25 g');
});

test('typed weights become exact integer mg, and finer-than-mg input is refused', () => {
  assert.equal(W.parseToMg('125.5', 'g'), 125500);
  assert.equal(W.parseToMg('1.25', 'kg'), 1250000);
  assert.equal(W.parseToMg('0.001', 'g'), 1);
  assert.equal(W.parseToMg('0.0001', 'g'), null);
  assert.equal(W.parseToMg('-3', 'g'), null);
  assert.equal(W.parseToMg('abc', 'g'), null);
});

test('a missing weight shows a dash, never 0', () => {
  assert.equal(W.formatWeight(null), '—');
  assert.equal(W.formatWeight(undefined), '—');
});
