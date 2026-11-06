/**
 * WALK2-RP-7: Maceration per product asked for a typed formula uuid and listed settings by uuid.
 * WALK2-RP-8: print-job chips printed wire words (queued, browser, parked), "label(s)", "rule(s)",
 * "1 batches", a raw alert kind, and offered Print in browser on a cancelled job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ops = strip(readFileSync(join(root, 'web/ws-floor-ops.js'), 'utf8'));
const floor = strip(readFileSync(join(root, 'web/ws-floor.js'), 'utf8'));
test('RP-7: the maceration setting picks a formula by name', () => {
  assert.doesNotMatch(ops, /Formula id/);
  assert.match(ops, /<select id="fo-ms-f"/);
  assert.match(ops, /\/v1\/maceration\/setting-products/); // WALK2-RP-15: not the Vault directory an admin cannot read
  assert.doesNotMatch(ops, /escHtml\(s\.formulaId\)/);
  assert.doesNotMatch(ops, /r\.batchNumber \|\| r\.oilBatchId/);
});
test('RP-8: plain words and plurals', () => {
  assert.match(ops, /WORD\[j\.status\] \|\| j\.status/);
  assert.doesNotMatch(ops + floor, /\(s\)'/);
  assert.doesNotMatch(ops, /list\.length \+ ' batches/);
  assert.doesNotMatch(ops, /chip\('bad', a\.kind\.replace/);
  assert.match(ops, /j\.status !== 'cancelled' \? btn\(/);
});
test('RP-9: packing chooses the order and lots by number; shipment words', () => {
  assert.doesNotMatch(ops, /Sales order id|Lot ids/);
  assert.match(ops, /\/v1\/packing\/candidates/);
  assert.doesNotMatch(ops, /l\.slice\(0, 8\)/);
  assert.doesNotMatch(ops, /s\.status\.replace\('_', ' '\)/);
  assert.doesNotMatch(ops, /s\.soNumber \|\| s\.salesOrderId/);
  assert.match(ops, /d\.blanks\.map\(fieldWords\)/);
});
