/**
 * PlatformModule — the platform cluster (platform schema). Owns the control-plane flags
 * (kill-switches), geo suggest, and master data. Depends on the (global)
 * BackendKernelModule for `PLATFORM_DB`, the in-memory `FlagsService`, and the `EventBus`.
 * Exports the `PlatformLookup` cold-read port.
 */
import { Module } from '@nestjs/common';
import { FlagsController } from './flags/flags.controller.js';
import { PlatformFlagsService } from './flags/flags.service.js';
import { GeoController } from './geo/geo.controller.js';
import { GeoService } from './geo/geo.service.js';
import { MastersController } from './masters/masters.controller.js';
import { MastersService } from './masters/masters.service.js';
import { PlatformLookupService } from './platform-lookup.service.js';
import { PLATFORM_LOOKUP } from './public-api.js';

@Module({
  controllers: [FlagsController, GeoController, MastersController],
  providers: [
    PlatformFlagsService,
    GeoService,
    MastersService,
    PlatformLookupService,
    { provide: PLATFORM_LOOKUP, useExisting: PlatformLookupService },
  ],
  exports: [PLATFORM_LOOKUP, PlatformFlagsService],
})
export class PlatformModule {}
