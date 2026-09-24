/**
 * PB-03 remainder — `isVaultMode` pure-function tests (no module-decoration-time side effects,
 * unlike `formula-module-vault-mode-*.test.ts`, which must each be its own process because
 * `formula.module.ts` reads `process.env.VAULT_MODE` exactly once, at import time).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVaultMode } from '../formula.module.js';

test('isVaultMode is true only for the literal string "true"', () => {
  assert.equal(isVaultMode({ VAULT_MODE: 'true' }), true);
  assert.equal(isVaultMode({ VAULT_MODE: 'false' }), false);
  assert.equal(isVaultMode({}), false);
  assert.equal(isVaultMode({ VAULT_MODE: 'TRUE' }), false);
  assert.equal(isVaultMode({ VAULT_MODE: '1' }), false);
});
