/**
 * DashboardController — `GET v1/dashboard` (the rich role dashboards) + `GET v1/trace/...`
 * (reverse traceability). The dashboard is authenticated-only and self-masks; the trace reveals a
 * product's full material/vendor sources (the recipe secret), so it's owner-gated by the
 * `formula:actual:read` permission.
 */
import { Controller, Get, Param } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { DashboardService } from './dashboard.service.js';

@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('v1/dashboard')
  snapshot(@CurrentUser() principal: AuthPrincipal) {
    return this.dashboard.snapshot(principal);
  }

  @Get('v1/alerts')
  alerts(@CurrentUser() principal: AuthPrincipal) {
    return this.dashboard.alerts(principal);
  }

  @Permissions('formula:actual:read')
  @Get('v1/trace/finished-good/:id')
  trace(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.dashboard.traceFinishedGood(id, principal);
  }
}
