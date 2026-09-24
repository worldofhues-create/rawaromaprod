/**
 * PB-03 remainder — VAULT_MODE unset/false (the main app box's default: main.ts's AppModule,
 * worker.ts's WorkerModule) shape of `FormulaModule`. See
 * `formula-module-vault-mode-true.test.ts` for why this needs its own process — this file must
 * NOT set VAULT_MODE at all (proving the DEFAULT, not an explicit "false").
 *
 * This is the other half of "the main API must not expose formula plaintext routes when
 * running in main mode".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { ClusterMasterdataModule, MASTERDATA_LOOKUP } from '@ra/cluster-masterdata';
import { FormulaModule, isVaultMode } from '../formula.module.js';

test('VAULT_MODE is NOT in effect by default for this process', () => {
  assert.equal(isVaultMode(), false);
  assert.equal(process.env.VAULT_MODE, undefined);
});

test('VAULT_MODE=false (default): FormulaModule mounts NO controllers — no formula plaintext HTTP routes on the main app box', () => {
  const controllers = Reflect.getMetadata('controllers', FormulaModule) as unknown[];
  assert.deepEqual(controllers, []);
});

test('VAULT_MODE=false (default): FormulaModule imports ClusterMasterdataModule (local, PG_CLIENT-backed) — unchanged main-mode behaviour', () => {
  const imports = Reflect.getMetadata('imports', FormulaModule) as unknown[];
  assert.ok(imports.includes(ClusterMasterdataModule));
});

test('VAULT_MODE=false (default): FormulaModule does not itself provide a MASTERDATA_LOOKUP binding — it comes from ClusterMasterdataModule', () => {
  const providers = Reflect.getMetadata('providers', FormulaModule) as Array<
    { provide?: unknown } | unknown
  >;
  const binding = providers.find(
    (p) => typeof p === 'object' && p !== null && 'provide' in p && (p as { provide: unknown }).provide === MASTERDATA_LOOKUP,
  );
  assert.equal(binding, undefined);
});
