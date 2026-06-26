/**
 * ProductionModule — the production cluster (production schema, Phase-1A production tables).
 * CRUD over all 15 tables (planning, picking, mixing, oil batch genealogy, production QC), the
 * order/picking/mixing/batch flows, and the transactional-outbox emit of
 * production.order.created / production.materials.issued / production.oil_batch.created /
 * production.qc.recorded. Provides its own `PRODUCTION_DB` Drizzle client off the shared
 * `PG_CLIENT` pool, the per-domain services + controllers, and the `PRODUCTION_LOOKUP`
 * cold-read port. Imports `FormulaModule` to inject the `FORMULA_LOOKUP` vault port (the
 * order flow expands the approved formula's pick list server-side). Exports `PRODUCTION_DB`
 * + `PRODUCTION_LOOKUP`.
 */
import { Global, Module } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';
import { FormulaModule } from '@ra/cluster-formula';
import { PlanningController } from './planning/planning.controller.js';
import { PlanningService } from './planning/planning.service.js';
import { PickingController } from './picking/picking.controller.js';
import { PickingService } from './picking/picking.service.js';
import { MixingController } from './mixing/mixing.controller.js';
import { MixingService } from './mixing/mixing.service.js';
import { BatchController } from './batch/batch.controller.js';
import { BatchService } from './batch/batch.service.js';
import { ProductionLookupService } from './production-lookup.service.js';
import { PRODUCTION_LOOKUP } from './public-api.js';
import { PRODUCTION_DB, drizzle, productionSchema } from './production.tokens.js';

@Global()
@Module({
  imports: [FormulaModule],
  controllers: [
    PlanningController,
    PickingController,
    MixingController,
    BatchController,
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
    ProductionLookupService,
    { provide: PRODUCTION_LOOKUP, useExisting: ProductionLookupService },
  ],
  exports: [PRODUCTION_DB, PRODUCTION_LOOKUP],
})
export class ProductionModule {}
