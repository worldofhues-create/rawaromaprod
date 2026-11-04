/**
 * WALK-RP-7: on a phone, Approve recipes' toolbar (Select all, the count, Approve selected) was one
 * row that could not wrap, so the count broke as "0 selecte / d" and the Approve selected button ran
 * off the card, its label cut to "Approve selecte". The row now wraps and its items keep their words.
 * Comments are stripped before matching.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web-vault/vault.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

test('the Approve recipes toolbar wraps and keeps its words', () => {
  const s = js.indexOf('async function screenReview(');
  const body = js.slice(s, js.indexOf('\n  }\n', s));
  assert.match(body, /countEl = h\('span', \{ style: '[^']*white-space:nowrap/);
  assert.match(body, /h\('div', \{ style: 'display:flex;flex-wrap:wrap;[^']*' \}, \[h\('label', \{ style: '[^']*white-space:nowrap[^']*' \}, \[all, 'Select all'\]\), countEl, approveBtn\]\)/);
});
