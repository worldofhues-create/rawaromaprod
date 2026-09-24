/**
 * MaterialFactsModule — mounts `MaterialFactsController` (main app box only; see that file's
 * header). Imported by `AppModule`. Needs no providers of its own — `MASTERDATA_LOOKUP` comes
 * from `ClusterMasterdataModule` (Global, already imported by `AppModule`).
 */
import { Module } from '@nestjs/common';
import { MaterialFactsController } from './material-facts.controller.js';

@Module({
  controllers: [MaterialFactsController],
})
export class MaterialFactsModule {}
