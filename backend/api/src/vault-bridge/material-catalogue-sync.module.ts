/**
 * MaterialCatalogueSyncModule — the main box's worker job that keeps the Vault console's material
 * picker supplied (`MaterialCatalogueSyncService`; see its header). Imported by `WorkerModule`.
 * `PG_CLIENT` comes from the kernel, `VaultApiClient` from the global `VaultPortModule`
 * (ProductionModule imports it).
 */
import { Module } from '@nestjs/common';
import { MaterialCatalogueSyncService } from './material-catalogue-sync.service.js';

@Module({
  providers: [MaterialCatalogueSyncService],
})
export class MaterialCatalogueSyncModule {}
