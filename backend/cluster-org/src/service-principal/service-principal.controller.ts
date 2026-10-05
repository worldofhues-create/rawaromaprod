/**
 * ServicePrincipalController — the "Let Ruh draft formulas" card's two routes (lane vaultsetup).
 *
 *   GET  /v1/service-principals/ruh                     status: account, the formulator grant
 *                                                       (none / pending + who may approve / active)
 *                                                       iam:user_role_mapping:read
 *   POST /v1/service-principals/ruh/formulator-request  CLICK 1 — create the account if needed and
 *                                                       open the PENDING two-person grant request
 *                                                       iam:user_role_mapping:write
 *
 * CLICK 2 is the existing POST /v1/vault-role-grant-requests/:id/approve, by a different owner/admin
 * — there is no Ruh-specific approval route, so nothing here can shortcut the two-person rule.
 */
import { Controller, Get, Post } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { ServicePrincipalService } from './service-principal.service.js';

@Controller()
export class ServicePrincipalController {
  constructor(private readonly principals: ServicePrincipalService) {}

  @Permissions('iam:user_role_mapping:read')
  @Get('v1/service-principals/ruh')
  status(@CurrentUser() principal: AuthPrincipal) {
    return this.principals.ruhStatus(principal);
  }

  @Permissions('iam:user_role_mapping:write')
  @Post('v1/service-principals/ruh/formulator-request')
  request(@CurrentUser() principal: AuthPrincipal) {
    return this.principals.requestFormulator(principal);
  }
}
