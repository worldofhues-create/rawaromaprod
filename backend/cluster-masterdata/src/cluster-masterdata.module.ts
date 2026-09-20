/**
 * ClusterMasterdataModule — the RAW AROMACHEM masterdata cluster (masterdata schema).
 * Mints its own `MASTERDATA_DB` Drizzle client off the shared `PG_CLIENT` pool (bound to
 * the @ra/data-masterdata schema barrel), wires the two CRUD feature services + their
 * controllers (classification chain; material master + dependents), and exports the
 * `MASTERDATA_LOOKUP` cold-read port. material/rm_alias creates record outbox events
 * (`masterdata.material.created`, `masterdata.alias.created`) drained by the shared
 * OutboxPublisher.
 */
import { Global, Module } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { ClassificationController } from './classification/classification.controller.js';
import { ClassificationService } from './classification/classification.service.js';
import { MaterialController } from './material/material.controller.js';
import { MaterialService } from './material/material.service.js';
import { MasterdataLookupService } from './masterdata-lookup.service.js';
import {
  MASTERDATA_DB,
  drizzle,
  masterdataSchema,
} from './cluster-masterdata.tokens.js';
import { MASTERDATA_LOOKUP } from './public-api.js';

@Global()
@Module({
  controllers: [ClassificationController, MaterialController],
  providers: [
    {
      provide: MASTERDATA_DB,
      inject: [PG_CLIENT],
      useFactory: (client: Sql) => drizzle(client, { schema: masterdataSchema }),
    },
    ClassificationService,
    MaterialService,
    MasterdataLookupService,
    { provide: MASTERDATA_LOOKUP, useExisting: MasterdataLookupService },
  ],
  exports: [MASTERDATA_DB, MASTERDATA_LOOKUP],
})
export class ClusterMasterdataModule {}
