/**
 * FloorModule (PROD-A-4..6) — floor codes, lot barcodes, scan-resolve, the floor queue and the
 * Picker / Verifier / Mixer stations. Uses the rules engine (PolicyModule) for `floor.queue` and
 * the production cluster's own services for the pick -> issue -> mixing -> oil batch flow.
 */
import { Module } from '@nestjs/common';
import { ProductionModule } from '@ra/cluster-production';
import { PolicyModule } from '../policy/policy.module.js';
import { FloorController } from './floor.controller.js';
import { FloorCodeService } from './floor-code.service.js';
import { FloorStationService } from './floor-station.service.js';
import { FloorQueueService } from './floor-queue.service.js';
import { LotSplitService } from './lot-split.service.js';
import { MaterialImportService } from './material-import.service.js';

@Module({
  imports: [ProductionModule, PolicyModule],
  controllers: [FloorController],
  providers: [FloorCodeService, FloorStationService, FloorQueueService, LotSplitService, MaterialImportService],
  exports: [FloorCodeService, FloorQueueService],
})
export class FloorModule {}
