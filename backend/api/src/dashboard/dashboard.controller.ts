/**
 * DashboardController — `GET v1/dashboard`, the single read behind every role's rich dashboard.
 * No `@Permissions` → authenticated-only (JwtAuthGuard still applies); the service masks the
 * payload by the caller's permissions so identity never leaks to a role that shouldn't see it.
 */
import { Controller, Get } from '@nestjs/common';
import { CurrentUser, type AuthPrincipal } from '@core/backend-kernel';
import { DashboardService } from './dashboard.service.js';

@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('v1/dashboard')
  snapshot(@CurrentUser() principal: AuthPrincipal) {
    return this.dashboard.snapshot(principal);
  }
}
