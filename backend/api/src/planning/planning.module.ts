/** PlanningModule — M04 reorder/shortage planning, and PROD-D-4 order intelligence (stock cover,
 *  through the planning.cover policy). Uses the shared PG_CLIENT (global). */
import { Module } from '@nestjs/common';
import { PolicyModule } from '../policy/policy.module.js';
import { PlanningController } from './planning.controller.js';
import { PlanningService } from './planning.service.js';
import { CoverController } from './cover.controller.js';
import { CoverService } from './cover.service.js';

@Module({
  imports: [PolicyModule],
  controllers: [PlanningController, CoverController],
  providers: [PlanningService, CoverService],
})
export class PlanningModule {}
