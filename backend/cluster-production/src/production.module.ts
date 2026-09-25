/**
 * ProductionModule — the production cluster (production schema, Phase-1A production tables).
 * CRUD over all 15 tables (planning, picking, mixing, oil batch genealogy, production QC), the
 * order/picking/mixing/batch flows, and the transactional-outbox emit of
 * production.order.created / production.materials.issued / production.oil_batch.created /
 * production.qc.recorded. Provides its own `PRODUCTION_DB` Drizzle client off the shared
 * `PG_CLIENT` pool, the per-domain services + controllers, and the `PRODUCTION_LOOKUP`
 * cold-read port.
 *
 * Every formula read goes to the Formula Vault over the signed internal channel, never a
 * formula-DB connection of this box's own (the app box can reach only the Vault API port, not
 * vault-pg). `VAULT_PORT` is `ProductionVaultPort` (vault/production-vault-port.ts): it calls the
 * Vault through `VaultPortModule`'s `VaultApiClient` and maps the Vault's keyed material references
 * to this box's own masterdata rows:
 *   - `PlanningService.createOrder` — the order's bill of materials (`resolvePickList`).
 *   - `PickingService` / `WeighingService` — the §109.7 coded manufacturing instruction.
 * `FormulaModule` is NOT imported. Exports `PRODUCTION_DB` + `PRODUCTION_LOOKUP`.
 */
import { Global, Module } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';
import { VAULT_PORT, VaultPortModule } from '@ra/cluster-formula';
import { PlanningController } from './planning/planning.controller.js';
import { PlanningService } from './planning/planning.service.js';
import { PickingController } from './picking/picking.controller.js';
import { PickingService } from './picking/picking.service.js';
import { MixingController } from './mixing/mixing.controller.js';
import { MixingService } from './mixing/mixing.service.js';
import { BatchController } from './batch/batch.controller.js';
import { BatchService } from './batch/batch.service.js';
import { WeighingController } from './weighing/weighing.controller.js';
import { WeighingService } from './weighing/weighing.service.js';
import { ProductionLookupService } from './production-lookup.service.js';
import { PRODUCTION_LOOKUP } from './public-api.js';
import { ProductionVaultPort } from './vault/production-vault-port.js';
import { PRODUCTION_DB, drizzle, productionSchema } from './production.tokens.js';

@Global()
@Module({
  imports: [VaultPortModule],
  controllers: [
    PlanningController,
    PickingController,
    MixingController,
    BatchController,
    WeighingController,
  ],
  providers: [
    {
      provide: PRODUCTION_DB,
      inject: [PG_CLIENT],
      useFactory: (client: Sql) => drizzle(client, { schema: productionSchema }),
    },
    { provide: VAULT_PORT, useClass: ProductionVaultPort },
    PlanningService,
    PickingService,
    MixingService,
    BatchService,
    WeighingService,
    ProductionLookupService,
    { provide: PRODUCTION_LOOKUP, useExisting: ProductionLookupService },
  ],
  exports: [PRODUCTION_DB, PRODUCTION_LOOKUP],
})
export class ProductionModule {}
