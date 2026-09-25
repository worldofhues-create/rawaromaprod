/**
 * ProductionModule — the production cluster (production schema, Phase-1A production tables).
 * CRUD over all 15 tables (planning, picking, mixing, oil batch genealogy, production QC), the
 * order/picking/mixing/batch flows, and the transactional-outbox emit of
 * production.order.created / production.materials.issued / production.oil_batch.created /
 * production.qc.recorded. Provides its own `PRODUCTION_DB` Drizzle client off the shared
 * `PG_CLIENT` pool, the per-domain services + controllers, and the `PRODUCTION_LOOKUP`
 * cold-read port. Imports `FormulaModule` to inject the `FORMULA_LOOKUP` vault port (the
 * order flow expands the approved formula's REAL pick list server-side —
 * `PlanningService.createOrder`, still in-process/local; real material_id is needed here for
 * inventory decrement and never crosses the wire).
 *
 * PB-03 remainder (V4 §109.1) — ALSO imports `VaultPortModule`: `PickingService`'s coded-
 * manufacturing-instruction resolution (`resolveManufacturingInstruction`, the floor-facing
 * read — RM_ALIAS + resolved quantity, never real material_id) reaches the Vault over the
 * signed internal channel (`VAULT_PORT`/`VaultPortHttpClient`) instead of this box's own
 * `FormulaModule`/`FORMULA_LOOKUP`. Deliberately narrow: only THIS one read moved to the
 * remote port today; `getPickList` above is unchanged and out of this port's scope (it needs
 * the real material_id for inventory, which the port never carries). Exports `PRODUCTION_DB`
 * + `PRODUCTION_LOOKUP`.
 */
import { Global, Module } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';
import { FormulaModule, VaultPortModule } from '@ra/cluster-formula';
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
import { PRODUCTION_DB, drizzle, productionSchema } from './production.tokens.js';

@Global()
@Module({
  imports: [FormulaModule, VaultPortModule],
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
