/**
 * WALK-RP-6: the Vault's tables broke words mid-word at every width below 1440: "2026", "formula" and
 * batch codes in Access audit, Production audit, Compliance data, Certificates and Approve recipes at
 * 1024 and 768, and "sealed", "calculate", "instruction" in the phone label/value stacks at 375. The
 * vendored card style lets text wrap anywhere, so a table column or a stacked value shrank to a few
 * letters. vault.css now wraps cells at spaces, and the phone stack keeps its label whole. Comments are
 * stripped before matching.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const css = readFileSync(join(root, 'web-vault/vault.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('vault table cells wrap at spaces, not anywhere', () => {
  assert.match(css, /\.card td,\s*\.card th\s*\{[^}]*overflow-wrap:\s*break-word/);
});
test('the phone stack keeps its label whole', () => {
  const phone = css.slice(css.indexOf('@media (max-width:767px){\n  .card table'));
  assert.match(phone, /\.card tbody td::before\s*\{[^}]*flex:\s*none/);
});

// WALK-RP-8: a mono cell (Product, Formula, Action, Entity) set its phone-stack label in the code font,
// so "Product" and "Formula" read as codes beside "Kind" and "Status" in the same card.
test('the phone-stack label is always in the UI font', () => {
  const phone = css.slice(css.indexOf('@media (max-width:767px){\n  .card table'));
  assert.match(phone, /\.card tbody td::before\s*\{[^}]*font-family:\s*var\(--ui\)/);
});
