/**
 * PB-03 remainder — VAULT_MODE=true shape of `FormulaModule`, asserted via Nest's own
 * `@Module()` metadata (no DI container boot, no DB, no network — the same "unit-test the
 * decision" preference `prod-boot-guards.test.ts` states explicitly).
 *
 * MUST run in its OWN process: `formula.module.ts` reads `process.env.VAULT_MODE` exactly once,
 * at module-decoration time, so the env var has to be set BEFORE the very first import of that
 * module anywhere in this process. `backend/test-support/run-tests.mjs`'s `node --test
 * <files...>` runs every `*.test.ts` file as its own child process (confirmed empirically — a
 * module-level counter in a file shared by two test files does NOT carry over between them),
 * so this is safe — see `formula-module-vault-mode-false.test.ts` for the opposite-mode sibling.
 *
 * Sets the env var, then uses a DYNAMIC `import()` (top-level await) rather than a static
 * `import` — ESM hoists every static `import` to run before any other top-level statement in
 * the file regardless of source order, so `process.env.VAULT_MODE = 'true'` written above a
 * static `import { FormulaModule } from '../formula.module.js'` would silently run AFTER that
 * import already resolved with the OLD (unset) env — a real footgun this file avoids by
 * construction rather than by comment alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';

process.env.VAULT_MODE = 'true';

const { CatalogController } = await import('../catalog/catalog.controller.js');
const { FormulasController } = await import('../formulas/formulas.controller.js');
const { ApprovalsController } = await import('../approvals/approvals.controller.js');
const { MaterialCatalogue } = await import('../facts-bridge/material-catalogue.js');
const { FormulaModule, isVaultMode } = await import('../formula.module.js');
const { MASTERDATA_LOOKUP } = await import('@ra/cluster-masterdata');

test('VAULT_MODE=true is actually in effect for this process', () => {
  assert.equal(isVaultMode(), true);
});

test('VAULT_MODE=true: FormulaModule mounts the three formula plaintext controllers', () => {
  const controllers = Reflect.getMetadata('controllers', FormulaModule) as unknown[];
  assert.deepEqual(controllers, [CatalogController, FormulasController, ApprovalsController]);
});

test('VAULT_MODE=true: FormulaModule does NOT import ClusterMasterdataModule (no main-DB credential)', () => {
  const imports = Reflect.getMetadata('imports', FormulaModule) as unknown[];
  for (const imported of imports) {
    assert.notEqual(
      (imported as { name?: string })?.name,
      'ClusterMasterdataModule',
      'ClusterMasterdataModule (PG_CLIENT/main-DB-backed) must never be imported in vault mode',
    );
  }
});

test('VAULT_MODE=true: MASTERDATA_LOOKUP resolves to MaterialCatalogue (the catalogue the main box pushes, held in memory), not a local DB-backed service nor a call back into the main box', () => {
  const providers = Reflect.getMetadata('providers', FormulaModule) as Array<
    { provide?: unknown; useExisting?: unknown } | unknown
  >;
  const binding = providers.find(
    (p) => typeof p === 'object' && p !== null && 'provide' in p && (p as { provide: unknown }).provide === MASTERDATA_LOOKUP,
  ) as { useExisting?: unknown } | undefined;
  assert.ok(binding, 'expected an explicit MASTERDATA_LOOKUP provider in vault mode');
  assert.equal(binding?.useExisting, MaterialCatalogue);
});

test('VAULT_MODE=true: FormulaModule exports what the Vault box\'s internal controller injects (directory + catalogue)', async () => {
  const { FormulaDirectoryService } = await import('../formula-directory.service.js');
  const exported = Reflect.getMetadata('exports', FormulaModule) as unknown[];
  assert.ok(exported.includes(FormulaDirectoryService));
  assert.ok(exported.includes(MaterialCatalogue));
});
