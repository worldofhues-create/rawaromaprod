/**
 * FormulaModule — the formula vault cluster (formula schema, Phase-1A 13 tables). Unlike the
 * other @ra clusters it opens its OWN postgres-js connection (FORMULA_DATABASE_URL / ra_vault
 * role) instead of sharing PG_CLIENT — the role-isolation wall + the in-house-extraction seam.
 *
 * Wires: the dedicated FORMULA_DB client, the KMS port (EnvKmsAdapter over FORMULA_KEK), the
 * VaultService crypto engine, the three domain service/controller pairs (catalog, formulas,
 * approvals), and the FORMULA_LOOKUP cold-read port (floor view = alias only). Imports
 * ClusterMasterdataModule to resolve material → RM_ALIAS for the floor view. Closes its pool
 * on shutdown. Exports FORMULA_DB (for the worker's outbox source) + FORMULA_LOOKUP.
 */
import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import type { Sql } from 'postgres';
import { ConfigService, SECURITY_AUDIT_SINK } from '@core/backend-kernel';
import { ClusterMasterdataModule } from '@ra/cluster-masterdata';
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
  imports: [ClusterMasterdataModule],
  controllers: [CatalogController, FormulasController, ApprovalsController],
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
    VaultService,
    CatalogService,
    FormulasService,
    ApprovalsService,
    FormulaLookupService,
    { provide: FORMULA_LOOKUP, useExisting: FormulaLookupService },
    VaultSecurityAuditSink,
    { provide: SECURITY_AUDIT_SINK, useExisting: VaultSecurityAuditSink },
  ],
  exports: [FORMULA_DB, FORMULA_LOOKUP, SECURITY_AUDIT_SINK],
})
export class FormulaModule implements OnModuleDestroy {
  constructor(@Inject(FORMULA_PG_CLIENT) private readonly client: Sql) {}

  /** Close the vault's dedicated pool on shutdown so the process exits cleanly. */
  async onModuleDestroy(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}
