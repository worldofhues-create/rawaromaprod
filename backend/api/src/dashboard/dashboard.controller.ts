/**
 * DashboardController — `GET v1/dashboard` (the rich role dashboards) + `GET v1/trace/...`
 * (reverse traceability). Both are authenticated-only and self-mask per caller.
 *
 * `trace` used to be fully edge-UNGUARDED (any authenticated caller, no `@Permissions` at
 * all) — a read-only security review (item 3) rejected that: `DashboardService.
 * traceFinishedGood` walks real customer/vendor/batch data, and "any authenticated caller"
 * meant even `platform_super_admin` (a PLATFORM-operations role with zero tenant business
 * data access anywhere else) could run it. Now gated on
 * `packaging:finished_good_batch_master:read` — held by owner/admin/qc/packaging/sales
 * (scripts/ra-roles.ts), which `platform_super_admin` does NOT hold, so the edge gate alone
 * already refuses it; `DashboardService.traceFinishedGood` ALSO explicitly refuses the
 * `platform_super_admin` role as defense-in-depth ("tenant business data never to platform
 * roles" — the permission-catalogue state is not the only thing that must stay true here).
 * The per-caller MASKING inside the service (`seeProduct`/`seeMaterial`, computed from the
 * caller's REAL `formula:actual:read` / `masterdata:material:reveal` permissions) is
 * unchanged — this gate controls WHO may run a trace at all, not what a given caller sees.
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
  @Get('v1/notifications')
  notifications() {
    return this.dashboard.notifications();
  }

  @Permissions('packaging:finished_good_batch_master:read')
  @Get('v1/trace/finished-good/:id')
  trace(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.dashboard.traceFinishedGood(id, principal);
  }
}
