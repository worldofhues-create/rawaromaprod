/**
 * PackagingModule — the packaging cluster (packaging schema, Phase-1A packaging tables). CRUD
 * over all 11 tables (product category/master/SKU, packaging material + BOM, package order +
 * items, filling session + details, finished-good batch + consumption), the order / filling /
 * FG-batch flows, and the transactional-outbox emit of packaging.order.created /
 * packaging.filling.done / packaging.fg_batch.created. Provides its own `PACKAGING_DB` Drizzle
 * client off the shared `PG_CLIENT` pool, the per-domain services + controllers, and the
 * `PACKAGING_LOOKUP` cold-read port. Exports `PACKAGING_DB` + `PACKAGING_LOOKUP`.
 */
import { Global, Module } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';
import { CatalogController } from './catalog/catalog.controller.js';
import { CatalogService } from './catalog/catalog.service.js';
import { OrdersController } from './orders/orders.controller.js';
import { OrdersService } from './orders/orders.service.js';
import { BatchController } from './batch/batch.controller.js';
import { BatchService } from './batch/batch.service.js';
import { PackagingLookupService } from './packaging-lookup.service.js';
import { PACKAGING_LOOKUP } from './public-api.js';
import { PACKAGING_DB, drizzle, packagingSchema } from './packaging.tokens.js';

@Global()
@Module({
  controllers: [CatalogController, OrdersController, BatchController],
  providers: [
    {
      provide: PACKAGING_DB,
      inject: [PG_CLIENT],
      useFactory: (client: Sql) => drizzle(client, { schema: packagingSchema }),
    },
    CatalogService,
    OrdersService,
    BatchService,
    PackagingLookupService,
    { provide: PACKAGING_LOOKUP, useExisting: PackagingLookupService },
  ],
  exports: [PACKAGING_DB, PACKAGING_LOOKUP],
})
export class PackagingModule {}
