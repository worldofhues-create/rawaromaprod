/**
 * PlatformOpsModule — wires PlatformOpsController/Service. Imports `ClusterOrgModule` (for
 * `OrgService`, re-exported by that module for exactly this reuse — see its doc comment) and
 * `BridgeModule` (for `BRIDGE_DB`, already `@Global()` but listed explicitly for clarity).
 * `PG_CLIENT`/`ConfigService` come from the globally-registered kernel modules.
 */
import { Module } from '@nestjs/common';
import { ClusterOrgModule } from '@ra/cluster-org';
import { BridgeModule } from '../bridge/bridge.module.js';
import { PlatformOpsController, PlatformOutboxController } from './platform-ops.controller.js';
import { PlatformOpsService } from './platform-ops.service.js';
import { BridgeHealthService } from './bridge-health.service.js';
import { PlatformReadsService } from './platform-reads.service.js';
import { HealthSamplerService } from './health-sampler.service.js';
import { ShelfModule } from '../shelf/shelf.module.js';

@Module({
  imports: [ClusterOrgModule, BridgeModule, ShelfModule],
  controllers: [PlatformOpsController, PlatformOutboxController],
  /* B09: PlatformReadsService (vault link, outbox list, audit chain and its verify) and the
     in-memory health sampler behind the tiles' history. */
  providers: [PlatformOpsService, BridgeHealthService, PlatformReadsService, HealthSamplerService],
})
export class PlatformOpsModule {}
