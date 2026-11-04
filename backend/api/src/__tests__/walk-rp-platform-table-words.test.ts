/**
 * WALK-RP-11: Platform's tables broke words mid-word below 1440 ("rawaroma" in every Sign-in history
 * email at 1024, "admin" and "approver" at 768, the connector table), from the vendored
 * `.card{overflow-wrap:anywhere}`; and the phone stack set mono cells' labels in the code font. Same
 * fix as the Vault (WALK-RP-6, WALK-RP-8). Comments are stripped before matching.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const css = readFileSync(join(root, 'web-platform/platform.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('platform table cells wrap at spaces, not anywhere', () => {
  assert.match(css, /\.card td,\s*\.card th\s*\{[^}]*overflow-wrap:\s*break-word/);
});
test('the phone-stack label stays whole and in the UI font', () => {
  const phone = css.slice(css.indexOf('@media (max-width:767px){\n  .card table'));
  assert.match(phone, /\.card tbody td::before\s*\{[^}]*flex:\s*none[^}]*font-family:\s*var\(--ui\)/);
});
