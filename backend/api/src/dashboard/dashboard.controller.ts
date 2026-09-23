/**
 * DashboardController — `GET v1/dashboard` (the rich role dashboards) + `GET v1/trace/...`
 * (reverse traceability). Both are authenticated-only and self-mask per caller.
 *
 * `trace` used to be gated by `@Permissions('formula:actual:read')` — that was correct back
 * when `formula:actual:read` was implicit for `owner`/`super_admin`, but §107 (this lane)
 * makes it a real, narrow Vault-authority grant held only by `formulator`/`vault_approver`.
 * Left gated here, EVERY factory role — owner included — would 403 on Traceability
 * (web/ws-vault.REMOVE.md flagged exactly this). The route is unguarded at the edge on
 * purpose: `DashboardService.traceFinishedGood` already computes its own per-caller
 * `seeProduct`/`seeMaterial` flags from the caller's REAL permissions
 * (`formula:actual:read` / `masterdata:material:reveal`) and returns the coded/masked
 * alias + 'Protected ◆' fallback otherwise — the same masking guarantee §109.7 requires of
 * `VaultPort.resolveManufacturingInstruction`, just applied to the traceability view.
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

  @Get('v1/trace/finished-good/:id')
  trace(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.dashboard.traceFinishedGood(id, principal);
  }
}
