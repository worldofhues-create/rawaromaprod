/**
 * ProduceController — the Factory's "Produce next" surface (lane produce, owner requirement
 * 2026-09-29). See produce-queue.service.ts / produce-plan.service.ts.
 *
 *   GET  /v1/produce/queue                     ranked queue + counters      production:production_order:read
 *   POST /v1/produce/requirements/:id/plan     one-click create/extend run  production:production_plan_items:write
 *                                                                            + production:production_order:write
 *   GET  /v1/produce/alerts?after=<seq>        the live alert feed          any signed-in caller, role-filtered
 *   GET  /v1/produce/formula-needs             products with no approved    formula:formula_version:read
 *                                              formula (the Vault console)  (formulator / vault_approver / owner)
 */
import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AnyAuthenticated, CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { ProduceQueueService } from './produce-queue.service.js';
import { ProducePlanService } from './produce-plan.service.js';

@Controller()
export class ProduceController {
  constructor(private readonly queue: ProduceQueueService, private readonly plan: ProducePlanService) {}

  @Permissions('production:production_order:read')
  @Get('v1/produce/queue')
  list(@Query('limit') limit?: string) {
    return this.queue.queue(limit ? Number(limit) : 200);
  }

  @Permissions('production:production_plan_items:write', 'production:production_order:write')
  @Post('v1/produce/requirements/:id/plan')
  planRequirement(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.plan.planRequirement(id, principal);
  }

  @AnyAuthenticated('every console polls its own alerts; ProduceQueueService.alerts filters them to the caller\'s roles')
  @Get('v1/produce/alerts')
  alerts(@CurrentUser() principal: AuthPrincipal, @Query('after') after?: string, @Query('limit') limit?: string) {
    const a = after !== undefined && /^\d+$/.test(after) ? Number(after) : null;
    return this.queue.alerts(principal, a, limit ? Number(limit) : 50);
  }

  @Permissions('formula:formula_version:read')
  @Get('v1/produce/formula-needs')
  formulaNeeds() {
    return this.queue.formulaNeeds();
  }
}
