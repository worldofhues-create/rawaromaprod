/**
 * FlagsModule — global, single-instance FlagsService. The platform cluster populates it
 * (load on boot, set on change); the edge FlagGuard consumes it. Global so the guard and
 * any cluster share the one snapshot.
 */
import { Global, Module } from '@nestjs/common';
import { FlagsService } from './flags.service.js';

@Global()
@Module({
  providers: [FlagsService],
  exports: [FlagsService],
})
export class FlagsModule {}
