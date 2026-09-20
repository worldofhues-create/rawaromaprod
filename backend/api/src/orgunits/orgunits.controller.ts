/** OrgUnitsController — Organization Management (M01). Reads auth-only; writes checked in service. */
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthPrincipal } from '@core/backend-kernel';
import { OrgUnitsService } from './orgunits.service.js';

@Controller()
export class OrgUnitsController {
  constructor(private readonly svc: OrgUnitsService) {}

  @Get('v1/organizations')
  list(@Query('limit') limit?: string) {
    return this.svc.list(limit ? Number(limit) : 200);
  }

  @Post('v1/organizations')
  create(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.svc.create(body, principal);
  }

  @Patch('v1/organizations/:id')
  update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.svc.update(id, body, principal);
  }
}
