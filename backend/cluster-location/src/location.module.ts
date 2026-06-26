/**
 * LocationModule — the location cluster (location schema). Owns CRUD over the Phase-1A
 * site + warehouse-hierarchy + storage-location masters. Binds its own `LOCATION_DB`
 * Drizzle client off the kernel's shared `PG_CLIENT` pool (the kernel only wires iam +
 * platform, so foundation clusters provide their own schema client here). Exports the
 * `LocationLookup` cold-read port under `LOCATION_LOOKUP`.
 */
import { Module } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { SitesController } from './sites/sites.controller.js';
import { SitesService } from './sites/sites.service.js';
import { WarehouseController } from './warehouse/warehouse.controller.js';
import { WarehouseService } from './warehouse/warehouse.service.js';
import { StorageController } from './storage/storage.controller.js';
import { StorageService } from './storage/storage.service.js';
import { LocationLookupService } from './location-lookup.service.js';
import { LOCATION_DB, drizzle, locationSchema } from './location.tokens.js';
import { LOCATION_LOOKUP } from './public-api.js';

@Module({
  controllers: [SitesController, WarehouseController, StorageController],
  providers: [
    {
      provide: LOCATION_DB,
      inject: [PG_CLIENT],
      useFactory: (client: Sql) => drizzle(client, { schema: locationSchema }),
    },
    SitesService,
    WarehouseService,
    StorageService,
    LocationLookupService,
    { provide: LOCATION_LOOKUP, useExisting: LocationLookupService },
  ],
  exports: [LOCATION_DB, LOCATION_LOOKUP],
})
export class LocationModule {}
