/**
 * QualityModule — the quality cluster (quality schema, Phase-1A QC tables). CRUD over all 7
 * tables (qc_parameter_master, qc_inspections, qc_result_details, qc_attachments,
 * qc_disposition, qc_sample_retention, qc_capa), the inspection flow (results → disposition),
 * and the transactional-outbox emit of quality.qc.passed / quality.qc.failed. Provides its
 * own `QUALITY_DB` Drizzle client off the shared `PG_CLIENT` pool, the per-domain services +
 * controllers, and the `QUALITY_LOOKUP` cold-read port. Exports `QUALITY_DB` + `QUALITY_LOOKUP`.
 */
import { Global, Module } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';
import { CatalogController } from './catalog/catalog.controller.js';
import { CatalogService } from './catalog/catalog.service.js';
import { InspectionsController } from './inspections/inspections.controller.js';
import { InspectionsService } from './inspections/inspections.service.js';
import { RetentionController } from './retention/retention.controller.js';
import { RetentionService } from './retention/retention.service.js';
import { CapaController } from './capa/capa.controller.js';
import { CapaService } from './capa/capa.service.js';
import { QualityLookupService } from './quality-lookup.service.js';
import { QUALITY_LOOKUP } from './public-api.js';
import { QUALITY_DB, drizzle, qualitySchema } from './quality.tokens.js';

@Global()
@Module({
  controllers: [
    CatalogController,
    InspectionsController,
    RetentionController,
    CapaController,
  ],
  providers: [
    {
      provide: QUALITY_DB,
      inject: [PG_CLIENT],
      useFactory: (client: Sql) => drizzle(client, { schema: qualitySchema }),
    },
    CatalogService,
    InspectionsService,
    RetentionService,
    CapaService,
    QualityLookupService,
    { provide: QUALITY_LOOKUP, useExisting: QualityLookupService },
  ],
  exports: [QUALITY_DB, QUALITY_LOOKUP],
})
export class QualityModule {}
