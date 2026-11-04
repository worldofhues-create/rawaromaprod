/**
 * WALK-RP-20: on the Owner dashboard at 1024 px the Chain of custody stage names broke mid-word
 * ("Procureme / nt"), because the vendored card style lets text wrap anywhere and five stage cards
 * share a row. A stage name now keeps whole words; the count moves under it when the card is narrow.
 * Comments are stripped before matching.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web/shell.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

test('stage names keep whole words', () => {
  assert.match(js, /<span style="font:var\(--w-med\) var\(--t-cap\)\/1\.15 var\(--font-ui\);flex:1 1 auto;min-width:min-content;overflow-wrap:normal">' \+ name \+ '<\/span>/);
});
