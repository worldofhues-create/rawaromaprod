/** ConsumptionModule (H-C3) — the production→inventory consumption subscriber. Imported by the
 * worker so it runs alongside the outbox publisher. PG_CLIENT comes from the kernel (global). */
import { Module } from '@nestjs/common';
import { ConsumptionService } from './consumption.service.js';

@Module({
  providers: [ConsumptionService],
})
export class ConsumptionModule {}
