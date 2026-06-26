/**
 * SalesModule — the sales cluster (sales schema, Phase-1A sales tables). CRUD over all 6
 * tables (customer_master, transporter_master, sales_order, sales_order_items,
 * dispatch_master, dispatch_items), the sales order flow (create-with-items → confirm), the
 * dispatch flow, and the transactional-outbox emit of sales.order.created /
 * sales.order.confirmed / sales.dispatch.created. Provides its own `SALES_DB` Drizzle client
 * off the shared `PG_CLIENT` pool, the per-domain services + controllers, and the
 * `SALES_LOOKUP` cold-read port. Exports `SALES_DB` + `SALES_LOOKUP`.
 */
import { Global, Module } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';
import { MastersController } from './masters/masters.controller.js';
import { MastersService } from './masters/masters.service.js';
import { OrdersController } from './orders/orders.controller.js';
import { OrdersService } from './orders/orders.service.js';
import { DispatchController } from './dispatch/dispatch.controller.js';
import { DispatchService } from './dispatch/dispatch.service.js';
import { SalesLookupService } from './sales-lookup.service.js';
import { SALES_LOOKUP } from './public-api.js';
import { SALES_DB, drizzle, salesSchema } from './sales.tokens.js';

@Global()
@Module({
  controllers: [MastersController, OrdersController, DispatchController],
  providers: [
    {
      provide: SALES_DB,
      inject: [PG_CLIENT],
      useFactory: (client: Sql) => drizzle(client, { schema: salesSchema }),
    },
    MastersService,
    OrdersService,
    DispatchService,
    SalesLookupService,
    { provide: SALES_LOOKUP, useExisting: SalesLookupService },
  ],
  exports: [SALES_DB, SALES_LOOKUP],
})
export class SalesModule {}
