/** PROD-B — production floor P2 (receiving, payment release, QC gate, lot hold/recall, putaway label);
 *  PROD-D-5 the QC review decision. */
import { Module } from '@nestjs/common';
import { PolicyModule } from '../policy/policy.module.js';
import { FloorModule } from '../floor/floor.module.js';
import { FloorOpsModule } from '../floor-ops/floor-ops.module.js';
import { ProdfloorController } from './prodfloor.controller.js';
import { ReceivingService } from './receiving.service.js';
import { PaymentReleaseService } from './payment-release.service.js';
import { QcFloorService } from './qc-floor.service.js';
import { LotTraceService } from './lot-trace.service.js';
import { QcReviewController } from './qc-review.controller.js';
import { QcReviewService } from './qc-review.service.js';
import { ReferenceStandardController } from './reference-standard.controller.js';
import { ReferenceStandardService } from './reference-standard.service.js';

@Module({
  imports: [PolicyModule, FloorModule, FloorOpsModule], // SCAN-5: FloorCodeService mints the raw-lot label's L- code; FLOOR-FIX-2: PrintService queues it
  controllers: [ProdfloorController, QcReviewController, ReferenceStandardController], // PROM-3: the retained reference
  providers: [ReceivingService, PaymentReleaseService, QcFloorService, LotTraceService, QcReviewService, ReferenceStandardService],
})
export class ProdfloorModule {}
