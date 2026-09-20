/**
 * ReferenceModule — the reference cluster (platform schema, Phase-1A reference masters).
 * CRUD over the 13 masters; no events (foundation config — no outbox). Provides its own
 * `REFERENCE_DB` Drizzle client off the shared `PG_CLIENT` pool, the per-domain services +
 * controllers, and the `REFERENCE_LOOKUP` cold-read port. Exports `REFERENCE_DB` +
 * `REFERENCE_LOOKUP`.
 */
import { Module } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';
import { GeoController } from './geo/geo.controller.js';
import { GeoService } from './geo/geo.service.js';
import { DocumentController } from './document/document.controller.js';
import { DocumentService } from './document/document.service.js';
import { UomController } from './uom/uom.controller.js';
import { UomService } from './uom/uom.service.js';
import { ReferenceLookupService } from './reference-lookup.service.js';
import { REFERENCE_LOOKUP } from './public-api.js';
import { REFERENCE_DB, drizzle, referenceSchema } from './reference.tokens.js';

@Module({
  controllers: [GeoController, DocumentController, UomController],
  providers: [
    {
      provide: REFERENCE_DB,
      inject: [PG_CLIENT],
      useFactory: (client: Sql) => drizzle(client, { schema: referenceSchema }),
    },
    GeoService,
    DocumentService,
    UomService,
    ReferenceLookupService,
    { provide: REFERENCE_LOOKUP, useExisting: ReferenceLookupService },
  ],
  exports: [REFERENCE_DB, REFERENCE_LOOKUP],
})
export class ReferenceModule {}
