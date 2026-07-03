/** ProcAnalyticsModule — vendor rate history + performance + negotiation. Shared PG_CLIENT. */
import { Module } from '@nestjs/common';
import { ProcAnalyticsController } from './procanalytics.controller.js';
import { ProcAnalyticsService } from './procanalytics.service.js';

@Module({
  controllers: [ProcAnalyticsController],
  providers: [ProcAnalyticsService],
})
export class ProcAnalyticsModule {}
