/** PROD-B — production floor P2 (receiving, payment release, QC gate, lot hold/recall, putaway label). */
import { Module } from '@nestjs/common';
import { PolicyModule } from '../policy/policy.module.js';
import { ProdfloorController } from './prodfloor.controller.js';
import { ReceivingService } from './receiving.service.js';
import { PaymentReleaseService } from './payment-release.service.js';
import { QcFloorService } from './qc-floor.service.js';
import { LotTraceService } from './lot-trace.service.js';

@Module({
  imports: [PolicyModule],
  controllers: [ProdfloorController],
  providers: [ReceivingService, PaymentReleaseService, QcFloorService, LotTraceService],
})
export class ProdfloorModule {}
