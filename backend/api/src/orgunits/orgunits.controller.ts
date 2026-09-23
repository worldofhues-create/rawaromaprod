/**
 * OrgUnitsController — Organization Management (M01). Reads require
 * iam:business_unit_master:read (guard fail-closed pass — was auth-only with no permission
 * check at all); writes checked in service.
 */
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, DynamicPermission, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { OrgUnitsService } from './orgunits.service.js';

@Controller()
export class OrgUnitsController {
  constructor(private readonly svc: OrgUnitsService) {}

  @Permissions('iam:business_unit_master:read')
  @Get('v1/organizations')
  list(@Query('limit') limit?: string) {
    return this.svc.list(limit ? Number(limit) : 200);
  }

  @DynamicPermission('iam:business_unit_master:write checked in OrgUnitsService.assertWrite')
  @Post('v1/organizations')
  create(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.svc.create(body, principal);
  }

  @DynamicPermission('iam:business_unit_master:write checked in OrgUnitsService.assertWrite')
  @Patch('v1/organizations/:id')
  update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.svc.update(id, body, principal);
  }
}
