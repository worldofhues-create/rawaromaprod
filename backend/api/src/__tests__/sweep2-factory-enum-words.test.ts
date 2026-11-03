/**
 * SWEEP2-O7: the Factory's New, Edit and line-item forms printed status options as the stored code
 * (IN_PROGRESS, PARTIALLY_RECEIVED). The option text now goes through statusWord, the same words the
 * tables use, and the value stays the code the API expects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const shell = readFileSync(join(root, 'web/shell.js'), 'utf8');

test('no form prints an enum code as its option text', () => {
  assert.doesNotMatch(shell, /'<option value="' \+ v \+ '">' \+ v \+ '<\/option>'/);
  assert.doesNotMatch(shell, /'<option>' \+ v \+ '<\/option>'/);
  const n = (shell.match(/'<option value="' \+ escHtml\(v\) \+ '">' \+ escHtml\(statusWord\(v\)\) \+ '<\/option>'/g) || []).length;
  assert.equal(n, 3, 'create, edit and line-item forms');
});
