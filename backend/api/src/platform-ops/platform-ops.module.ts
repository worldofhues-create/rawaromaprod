/**
 * PlatformOpsModule — wires PlatformOpsController/Service. Imports `ClusterOrgModule` (for
 * `OrgService`, re-exported by that module for exactly this reuse — see its doc comment) and
 * `BridgeModule` (for `BRIDGE_DB`, already `@Global()` but listed explicitly for clarity).
 * `PG_CLIENT`/`ConfigService` come from the globally-registered kernel modules.
 */
import { Module } from '@nestjs/common';
import { ClusterOrgModule } from '@ra/cluster-org';
import { BridgeModule } from '../bridge/bridge.module.js';
import { PlatformOpsController } from './platform-ops.controller.js';
import { PlatformOpsService } from './platform-ops.service.js';
import { BridgeHealthService } from './bridge-health.service.js';
import { ShelfModule } from '../shelf/shelf.module.js';

@Module({
  imports: [ClusterOrgModule, BridgeModule, ShelfModule],
  controllers: [PlatformOpsController],
  providers: [PlatformOpsService, BridgeHealthService],
})
export class PlatformOpsModule {}
