/**
 * RP-FAC — Vault boundary check (master directive §47: "never expose formula/KEK"). This lane
 * did not touch Vault crypto (backend/cluster-formula/src/crypto, backend/api/src/crypto) at all
 * — by design, per the lane brief. This test proves that STATICALLY: none of the files this lane
 * edited or added (production batch, packaging reservation/QC, sales dispatch, the generic
 * editor, the new test-support harness) import the Vault crypto module, the formula ingredient/
 * percentage columns, or the KEK/DEK material, and that none of the SQL those routes execute
 * selects a formula-schema ingredient/recipe column. A route that only ever touches oil_batch_id
 * / production_order_id / formula_version_id (an opaque soft-ref uuid, not the recipe itself)
 * cannot leak plaintext formula content, by construction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..', '..');

const TOUCHED_FILES = [
  'backend/cluster-production/src/batch/batch.service.ts',
  'backend/cluster-packaging/src/reservation/reservation.service.ts',
  'backend/cluster-sales/src/dispatch/dispatch.service.ts',
  'backend/api/src/edit/edit.service.ts',
  'backend/api/src/packaging-qc/packaging-qc.service.ts',
];

// Columns/tables that would carry actual formula plaintext (the recipe) per the formula schema —
// as opposed to formula_version_id, which is just an opaque soft-ref uuid every cluster is
// allowed to hold. Vault/KEK material is a separate, stricter check below.
const FORMULA_PLAINTEXT_PATTERN = /formula_ingredient|ingredient_percentage|\bformula_text\b|\brecipe\b|plaintext_formula/i;
const VAULT_CRYPTO_IMPORT_PATTERN = /crypto\/(vault|kek|dek)|FORMULA_KEK|formula\.crypto/i;

for (const rel of TOUCHED_FILES) {
  test(`vault boundary: ${rel} never references formula plaintext columns or Vault crypto internals`, () => {
    const src = readFileSync(join(repoRoot, rel), 'utf8');
    assert.doesNotMatch(src, FORMULA_PLAINTEXT_PATTERN, `${rel} must not touch formula ingredient/recipe data`);
    assert.doesNotMatch(src, VAULT_CRYPTO_IMPORT_PATTERN, `${rel} must not import Vault crypto / KEK material`);
  });
}

test('vault boundary: none of this lane\'s new test-support files import Vault crypto either', () => {
  const dir = join(repoRoot, 'backend', 'test-support');
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) continue;
    if (!/\.(ts|mjs)$/.test(entry)) continue;
    const src = readFileSync(full, 'utf8');
    assert.doesNotMatch(src, VAULT_CRYPTO_IMPORT_PATTERN, `${entry} must not import Vault crypto / KEK material`);
  }
});

test('vault boundary: the production cluster only exposes formula_version_id as an opaque soft ref, never formula content, via PRODUCTION_LOOKUP', () => {
  const publicApi = readFileSync(
    join(repoRoot, 'backend/cluster-production/src/public-api.ts'),
    'utf8',
  );
  assert.match(publicApi, /formulaVersionId:\s*string \| null/, 'expects an id-only soft ref');
  assert.doesNotMatch(publicApi, FORMULA_PLAINTEXT_PATTERN);
});
