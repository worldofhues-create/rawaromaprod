/**
 * WorkerModule — composition root for the `worker` process (outbox drain + schedulers).
 * Wires the @core foundation (iam + platform) + the RA dictionary clusters as each is built;
 * each cluster's outbox is registered so the publisher drains it onto the in-proc bus.
 *
 * NO formula-schema job runs here. `formula.outbox` lives in the Vault database, which this box
 * (main.ts's in-process worker, or worker.ts) has no network path to; the publisher used to poll it
 * every 2 s through FormulaModule's own pool and time out on vault-pg:5432 each time. Nothing on
 * this box subscribes to a formula event (the in-proc bus's only subscriber is the flags snapshot,
 * and the email notifier reads outboxes from the main database only), so FormulaModule and the
 * formula outbox source are simply not composed here. Production reaches the Vault through
 * `VaultPortModule` (ProductionModule imports it).
 */
import { Module } from '@nestjs/common';
import {
  BackendKernelModule,
  IAM_DB,
  PLATFORM_DB,
  provideOutboxSources,
} from '@core/backend-kernel';
import { PlatformModule } from '@core/cluster-platform';
import { ClusterMasterdataModule, MASTERDATA_DB } from '@ra/cluster-masterdata';
import { ClusterProcurementModule, PROCUREMENT_DB } from '@ra/cluster-procurement';
import { ClusterInventoryModule, INVENTORY_DB } from '@ra/cluster-inventory';
import { QualityModule, QUALITY_DB } from '@ra/cluster-quality';
import { ProductionModule, PRODUCTION_DB } from '@ra/cluster-production';
import { PackagingModule, PACKAGING_DB } from '@ra/cluster-packaging';
import { SalesModule, SALES_DB } from '@ra/cluster-sales';
import { outbox as iamOutbox } from '@core/data-iam';
import { outbox as platformOutbox } from '@core/data-platform';
import { outbox as masterdataOutbox } from '@ra/data-masterdata';
import { outbox as procurementOutbox } from '@ra/data-procurement';
import { outbox as inventoryOutbox } from '@ra/data-inventory';
import { outbox as qualityOutbox } from '@ra/data-quality';
import { outbox as productionOutbox } from '@ra/data-production';
import { outbox as packagingOutbox } from '@ra/data-packaging';
import { outbox as salesOutbox } from '@ra/data-sales';
import { NotifyModule } from './notify/notify.module.js';
import { ConsumptionModule } from './consumption/consumption.module.js';
import { BridgeModule } from './bridge/bridge.module.js';
import { AutomationModule } from './automation/automation.module.js';

@Module({
  imports: [
    BackendKernelModule.forRoot({
      outbox: {
        withPublisher: true,
        sourcesProvider: provideOutboxSources([
          { cluster: 'iam', dbToken: IAM_DB, table: iamOutbox },
          { cluster: 'platform', dbToken: PLATFORM_DB, table: platformOutbox },
          { cluster: 'masterdata', dbToken: MASTERDATA_DB, table: masterdataOutbox },
          { cluster: 'procurement', dbToken: PROCUREMENT_DB, table: procurementOutbox },
          { cluster: 'inventory', dbToken: INVENTORY_DB, table: inventoryOutbox },
          { cluster: 'quality', dbToken: QUALITY_DB, table: qualityOutbox },
          { cluster: 'production', dbToken: PRODUCTION_DB, table: productionOutbox },
          { cluster: 'packaging', dbToken: PACKAGING_DB, table: packagingOutbox },
          { cluster: 'sales', dbToken: SALES_DB, table: salesOutbox },
        ]),
      },
      enableScheduling: true,
    }),
    PlatformModule,
    ClusterMasterdataModule,
    ClusterProcurementModule,
    ClusterInventoryModule,
    QualityModule,
    ProductionModule,
    PackagingModule,
    SalesModule,
    NotifyModule,
    ConsumptionModule,
    BridgeModule,
    AutomationModule,
  ],
})
export class WorkerModule {}
