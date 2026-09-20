/** PlanningModule — M04 reorder/shortage planning. Uses the shared PG_CLIENT (global). */
import { Module } from '@nestjs/common';
import { PlanningController } from './planning.controller.js';
import { PlanningService } from './planning.service.js';

@Module({
  controllers: [PlanningController],
  providers: [PlanningService],
})
export class PlanningModule {}
