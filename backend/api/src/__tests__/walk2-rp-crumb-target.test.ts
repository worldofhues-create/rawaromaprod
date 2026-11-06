/** WALK2-RP-2: the breadcrumb link was a 15px touch target on phones and tablets (WALK_STANDARD: 44px). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web/shell.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
test('breadcrumb links are 44px tall on a coarse pointer', () => {
  assert.match(js, /@media \(pointer:coarse\)\{\.screen-intro \.crumbs a\{[^}]*min-height:44px/);
});
