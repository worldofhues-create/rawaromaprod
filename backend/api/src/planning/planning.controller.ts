/** PlanningController — M04 reorder suggestions. Gated by the procurement stock-requirement read perm. */
import { Controller, Get, Query } from '@nestjs/common';
import { Permissions } from '@core/backend-kernel';
import { PlanningService } from './planning.service.js';

@Controller()
export class PlanningController {
  constructor(private readonly svc: PlanningService) {}

  @Permissions('procurement:stock_requirement:read')
  @Get('v1/reorder-suggestions')
  reorderSuggestions(@Query('limit') limit?: string) {
    return this.svc.reorderSuggestions(limit ? Number(limit) : 200);
  }
}
