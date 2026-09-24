/** L1 — vault-main.ts listen-host selection. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVaultBindHost, DEFAULT_VAULT_BIND_HOST } from '../vault-bind-host.js';

test('defaults to 0.0.0.0 when VAULT_BIND_HOST is unset/blank (app box reaches it across hosts)', () => {
  assert.equal(DEFAULT_VAULT_BIND_HOST, '0.0.0.0');
  assert.equal(resolveVaultBindHost(undefined), '0.0.0.0');
  assert.equal(resolveVaultBindHost(''), '0.0.0.0');
  assert.equal(resolveVaultBindHost('   '), '0.0.0.0');
});

test('uses the configured private-interface host when set', () => {
  assert.equal(resolveVaultBindHost('10.0.1.23'), '10.0.1.23');
  assert.equal(resolveVaultBindHost(' 10.0.1.23 '), '10.0.1.23');
});
