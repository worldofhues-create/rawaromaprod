/**
 * FormulaModule — the formula vault cluster (formula schema, Phase-1A 13 tables). Unlike the
 * other @ra clusters it opens its OWN postgres-js connection (FORMULA_DATABASE_URL / ra_vault
 * role) instead of sharing PG_CLIENT — the role-isolation wall + the in-house-extraction seam.
 *
 * Wires: the dedicated FORMULA_DB client, the KMS port (EnvKmsAdapter over FORMULA_KEK), the
 * VaultService crypto engine, the three domain service/controller pairs (catalog, formulas,
 * approvals), and the FORMULA_LOOKUP cold-read port (floor view = alias only). Closes its pool
 * on shutdown. Exports FORMULA_DB + FORMULA_LOOKUP.
 *
 * WHO IMPORTS IT: the Vault box's `VaultAppModule` (vault-main.ts), and single-process scripts
 * and tests. NOT the main app box — `AppModule` and `WorkerModule` reach the Vault only over the
 * signed internal channel (`VaultPortModule`, vault-port.ts), so no process on that box ever
 * builds a FORMULA_PG_CLIENT pool (it has no network path to vault-pg:5432, and the pool's
 * connect attempts were what timed out creating production orders and polling formula.outbox).
 *
 * PB-03 remainder (V4 §109.1) — VAULT_MODE-gated shape. Read directly off `process.env` at
 * MODULE-DECORATION time (before Nest's DI container exists — the earliest point a plain
 * `@Module({...})` object can vary), because it decides the STATIC composition of this module
 * (which controllers exist, which sibling module gets imported) rather than a runtime value any
 * provider reads:
 *
 *   VAULT_MODE=false (default — a single-process script or test that has both databases): NO
 *   controllers (formula plaintext HTTP routes exist only on the Vault box), and
 *   `MASTERDATA_LOOKUP` resolves locally via `ClusterMasterdataModule` (shared main `PG_CLIENT`).
 *
 *   VAULT_MODE=true (vault-main.ts's VaultAppModule, ONLY): the three controllers ARE mounted
 *   (this is the one process that's allowed to serve them), and `MASTERDATA_LOOKUP` resolves via
 *   `MaterialFactsClient` — a signed HTTP call to the main app box's material-facts bridge
 *   (`facts-bridge/material-facts.client.ts`) — instead of `ClusterMasterdataModule`, which
 *   needs the shared `PG_CLIENT` (main DB) the Vault box must never hold a credential for. This
 *   is the "keeps no main-DB credentials on the vault box" design choice the lane brief asked
 *   this file to pick and document; the alternative considered (a synced local material catalog)
 *   was rejected because it needs its own replication/staleness story for no real benefit over a
 *   live read-only proxy call the Vault box already has a signed channel for (VaultPort, the
 *   opposite direction).
 */
import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import type { Sql } from 'postgres';
import { ConfigService, SECURITY_AUDIT_SINK } from '@core/backend-kernel';
import { ClusterMasterdataModule, MASTERDATA_LOOKUP } from '@ra/cluster-masterdata';
import { CatalogController } from './catalog/catalog.controller.js';
import { CatalogService } from './catalog/catalog.service.js';
import { FormulasController } from './formulas/formulas.controller.js';
import { FormulasService } from './formulas/formulas.service.js';
import { ApprovalsController } from './approvals/approvals.controller.js';
import { ApprovalsService } from './approvals/approvals.service.js';
import { VaultService } from './vault.service.js';
import { VaultSecurityAuditSink } from './security-audit-sink.adapter.js';
import { FormulaLookupService } from './formula-lookup.service.js';
import { FORMULA_LOOKUP } from './public-api.js';
import { MaterialFactsClient } from './facts-bridge/material-facts.client.js';
import { KMS_PORT, type KmsPort } from './crypto/kms.port.js';
import { EnvKmsAdapter } from './crypto/env-kms.adapter.js';
import { FileKmsAdapter } from './crypto/file-kms.adapter.js';
import { AwsKmsAdapter } from './crypto/aws-kms.adapter.js';
import {
  FORMULA_DB,
  FORMULA_PG_CLIENT,
  createFormulaClient,
  drizzle,
  formulaSchema,
} from './formula.tokens.js';

/** Exported (not inlined) so `formula-module-vault-mode.test.ts` can assert on it without
 *  booting Nest — same "unit-test the decision, not the DI container" pattern
 *  `resolveKmsAdapter`/`createFormulaClient` already follow. */
export function isVaultMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VAULT_MODE === 'true';
}

const VAULT_MODE = isVaultMode();

/**
 * PB-03 / V4 §109.2: production (APP_ENV=prod) accepts ONLY AwsKmsAdapter — a real AWS KMS
 * CMK, never the env/file KEK adapters, even if FORMULA_KEK/FORMULA_KEK_FILE happen to be set
 * in a prod environment (they are simply never consulted below). Missing FORMULA_KMS_KEY_ID in
 * prod is a boot error, not a silent downgrade to a weaker adapter — "fail CLOSED", not "fail
 * open to whatever secret is lying around" (SB-01).
 *
 * Outside prod: the OFFLINE console (FORMULA_KEK_FILE set) keeps the master key on mounted
 * media via FileKmsAdapter; everything else uses EnvKmsAdapter. Dev/test only.
 *
 * Exported (not an inline `useFactory` closure) so this exact decision can be unit-tested
 * without booting the Nest DI container — see formula-module-kms-selection.test.ts.
 */
export function resolveKmsAdapter(config: ConfigService): KmsPort {
  if (config.get('APP_ENV') === 'prod') {
    if (!config.get('FORMULA_KMS_KEY_ID')) {
      throw new Error(
        'FORMULA_KMS_KEY_ID is required when APP_ENV=prod. The Formula Vault refuses to ' +
          'boot with any adapter other than AWS KMS in production (V4 §109.2, PB-03) — ' +
          'env/file KEK adapters are dev/test only.',
      );
    }
    return new AwsKmsAdapter(config);
  }
  return config.get('FORMULA_KEK_FILE') ? new FileKmsAdapter(config) : new EnvKmsAdapter(config);
}

@Global()
@Module({
  // VAULT_MODE=true: no ClusterMasterdataModule import at all (it needs the shared main
  // PG_CLIENT) — MASTERDATA_LOOKUP is instead provided directly, below, off MaterialFactsClient.
  imports: VAULT_MODE ? [] : [ClusterMasterdataModule],
  // VAULT_MODE=false (main app box): zero formula HTTP routes exist in this process.
  controllers: VAULT_MODE ? [CatalogController, FormulasController, ApprovalsController] : [],
  providers: [
    {
      provide: FORMULA_PG_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createFormulaClient(config),
    },
    {
      provide: FORMULA_DB,
      inject: [FORMULA_PG_CLIENT],
      useFactory: (client: Sql) => drizzle(client, { schema: formulaSchema }),
    },
    {
      provide: KMS_PORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => resolveKmsAdapter(config),
    },
    // VAULT_MODE=true only — see this file's header. Harmless to construct when unused
    // (ClusterMasterdataModule's own MASTERDATA_LOOKUP binding wins via `imports` above when
    // VAULT_MODE=false; this provider is simply never registered in that case).
    ...(VAULT_MODE
      ? [MaterialFactsClient, { provide: MASTERDATA_LOOKUP, useExisting: MaterialFactsClient }]
      : []),
    VaultService,
    CatalogService,
    FormulasService,
    ApprovalsService,
    FormulaLookupService,
    { provide: FORMULA_LOOKUP, useExisting: FormulaLookupService },
    VaultSecurityAuditSink,
    { provide: SECURITY_AUDIT_SINK, useExisting: VaultSecurityAuditSink },
  ],
  // FORMULA_PG_CLIENT: needed by vault-main.ts's VaultHealthController (pings the one DB
  // connection the Vault process actually holds) — see backend/api/src/vault-bridge.
  exports: [FORMULA_DB, FORMULA_PG_CLIENT, FORMULA_LOOKUP, SECURITY_AUDIT_SINK],
})
export class FormulaModule implements OnModuleDestroy {
  constructor(@Inject(FORMULA_PG_CLIENT) private readonly client: Sql) {}

  /** Close the vault's dedicated pool on shutdown so the process exits cleanly. */
  async onModuleDestroy(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}
