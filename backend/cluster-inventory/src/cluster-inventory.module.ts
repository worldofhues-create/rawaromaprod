/**
 * ClusterInventoryModule — the RAW AROMACHEM inventory cluster (inventory schema). Mints its
 * own `INVENTORY_DB` Drizzle client off the shared `PG_CLIENT` pool (bound to the
 * @ra/data-inventory schema barrel), wires the five CRUD feature services + their controllers
 * (gate / grn / batch / inventory ledger / stock) and the receiving + release + ledger flows,
 * and exports the `INVENTORY_LOOKUP` cold-read port. The GRN flow emits
 * `inventory.grn.created` + one `inventory.batch.created` per batch (drained by the shared
 * OutboxPublisher).
 */
import { Global, Module } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { GateController } from './gate/gate.controller.js';
import { GateService } from './gate/gate.service.js';
import { GrnController } from './grn/grn.controller.js';
import { GrnService } from './grn/grn.service.js';
import { BatchController } from './batch/batch.controller.js';
import { BatchService } from './batch/batch.service.js';
import { InventoryController } from './inventory/inventory.controller.js';
import { InventoryService } from './inventory/inventory.service.js';
import { StockController } from './stock/stock.controller.js';
import { StockService } from './stock/stock.service.js';
import { InventoryLookupService } from './inventory-lookup.service.js';
import { INVENTORY_DB, drizzle, inventorySchema } from './cluster-inventory.tokens.js';
import { INVENTORY_LOOKUP } from './public-api.js';

@Global()
@Module({
  controllers: [
    GateController,
    GrnController,
    BatchController,
    InventoryController,
    StockController,
  ],
  providers: [
    {
      provide: INVENTORY_DB,
      inject: [PG_CLIENT],
      useFactory: (client: Sql) => drizzle(client, { schema: inventorySchema }),
    },
    GateService,
    GrnService,
    BatchService,
    InventoryService,
    StockService,
    InventoryLookupService,
    { provide: INVENTORY_LOOKUP, useExisting: InventoryLookupService },
  ],
  exports: [INVENTORY_DB, INVENTORY_LOOKUP],
})
export class ClusterInventoryModule {}
