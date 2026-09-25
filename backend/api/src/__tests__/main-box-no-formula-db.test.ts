/**
 * The main app box never holds a formula-database connection (RawProd release blocker, lane
 * vaultport-rp). The Vault isolation lets the app box reach only the Vault API port, not
 * vault-pg:5432; `POST /v1/production-orders` used to read the pick list through FormulaModule's
 * own pool and fail with CONNECT_TIMEOUT, and the in-process worker polled formula.outbox through
 * it every 2 s.
 *
 * This walks the REAL composition roots' module graphs (`AppModule` for main.ts, `WorkerModule` for
 * the in-process worker / worker.ts) the way Nest's scanner does — static `@Module` metadata plus
 * every dynamic module's own imports/providers — and proves no provider that would create or use
 * that pool exists anywhere in them: no FormulaModule, no FORMULA_PG_CLIENT / FORMULA_DB /
 * FORMULA_LOOKUP binding, no factory that injects FORMULA_DB (the old formula outbox source). The
 * Vault is reached only through VaultPortModule's signed HTTP client (VAULT_PORT is
 * ProductionVaultPort over it), which is also where the edge guards' SECURITY_AUDIT_SINK now
 * comes from. The runtime half (a real main.ts with
 * FORMULA_DATABASE_URL on a watched port that must see zero connections) is
 * vault-isolation-harness.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { SECURITY_AUDIT_SINK } from '@core/backend-kernel';
import {
  FORMULA_DB,
  FORMULA_LOOKUP,
  FORMULA_PG_CLIENT,
  FormulaModule,
  VAULT_PORT,
  VaultApiClient,
  VaultPortModule,
  VaultSecurityAuditClient,
} from '@ra/cluster-formula';
import { ProductionVaultPort } from '../../../cluster-production/src/vault/production-vault-port.js';
import { AppModule } from '../app.module.js';
import { WorkerModule } from '../worker.module.js';

type AnyProvider = { provide?: unknown; inject?: unknown[]; useClass?: unknown; useExisting?: unknown } | (new (...a: never[]) => unknown);

interface Graph {
  /** Every module CLASS reached. */
  modules: Set<unknown>;
  providers: AnyProvider[];
}

/** Nest's own scan, statically: `@Module` imports/providers, plus each dynamic module's own. */
function walk(root: unknown): Graph {
  const seen = new Set<unknown>();
  const modules = new Set<unknown>();
  const providers: AnyProvider[] = [];
  const visit = (entry: unknown): void => {
    if (!entry || seen.has(entry)) return;
    seen.add(entry);
    if (typeof entry === 'object' && 'forwardRef' in entry && typeof (entry as { forwardRef: unknown }).forwardRef === 'function') {
      visit((entry as { forwardRef: () => unknown }).forwardRef());
      return;
    }
    if (typeof entry === 'object' && 'module' in entry) {
      const dyn = entry as { module: unknown; imports?: unknown[]; providers?: AnyProvider[] };
      providers.push(...(dyn.providers ?? []));
      for (const imp of dyn.imports ?? []) visit(imp);
      visit(dyn.module);
      return;
    }
    modules.add(entry);
    providers.push(...((Reflect.getMetadata('providers', entry as object) as AnyProvider[] | undefined) ?? []));
    for (const imp of (Reflect.getMetadata('imports', entry as object) as unknown[] | undefined) ?? []) visit(imp);
  };
  visit(root);
  return { modules, providers };
}

const tokenOf = (p: AnyProvider): unknown => (typeof p === 'function' ? p : p.provide);
const FORMULA_TOKENS = [FORMULA_PG_CLIENT, FORMULA_DB, FORMULA_LOOKUP];

for (const [name, root] of [['AppModule (main.ts)', AppModule], ['WorkerModule (in-process worker / worker.ts)', WorkerModule]] as const) {
  test(`${name}: FormulaModule is not in the module graph`, () => {
    const { modules } = walk(root);
    assert.ok(modules.size > 10, 'the walk reached the real graph');
    assert.equal(modules.has(FormulaModule), false, 'FormulaModule opens the formula-DB pool; the main box must not compose it');
  });

  test(`${name}: nothing provides or injects the formula-DB pool (FORMULA_PG_CLIENT / FORMULA_DB / FORMULA_LOOKUP)`, () => {
    const { providers } = walk(root);
    const provided = providers.map(tokenOf).filter((t) => FORMULA_TOKENS.includes(t as symbol));
    assert.deepEqual(provided, []);
    const injecting = providers.filter(
      (p) => typeof p === 'object' && Array.isArray(p.inject) && p.inject.some((t) => FORMULA_TOKENS.includes(t as symbol)),
    );
    assert.deepEqual(injecting.map(tokenOf), [], 'e.g. the old formula outbox source injected FORMULA_DB');
  });

  test(`${name}: the Vault is reached only through VaultPortModule's signed HTTP client`, () => {
    const { modules, providers } = walk(root);
    assert.ok(modules.has(VaultPortModule));
    assert.ok(providers.map(tokenOf).includes(VaultApiClient));
    const port = providers.filter((p) => tokenOf(p) === VAULT_PORT);
    assert.equal(port.length, 1);
    assert.equal((port[0] as { useClass?: unknown }).useClass, ProductionVaultPort);
  });
}

test('AppModule: the edge guards\' SECURITY_AUDIT_SINK is the Vault API client, not a formula-DB writer', () => {
  const { providers } = walk(AppModule);
  const sinks = providers.filter((p) => tokenOf(p) === SECURITY_AUDIT_SINK);
  assert.equal(sinks.length, 1);
  assert.equal((sinks[0] as { useExisting?: unknown }).useExisting, VaultSecurityAuditClient);
});
