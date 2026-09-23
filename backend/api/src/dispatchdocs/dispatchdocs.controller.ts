/** DispatchDocsController — dispatch document chain (challan/invoice/e-way/packing-list/POD). */
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUser, DynamicPermission, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { DispatchDocsService } from './dispatchdocs.service.js';

@Controller()
export class DispatchDocsController {
  constructor(private readonly svc: DispatchDocsService) {}

  @Permissions('sales:dispatch_master:read')
  @Get('v1/dispatch-documents')
  list(@Query('limit') limit?: string) {
    return this.svc.list(limit ? Number(limit) : 200);
  }

  @DynamicPermission('sales:dispatch_master:write checked in DispatchDocsService.create before it throws NotImplementedException')
  @Post('v1/dispatch-documents')
  create(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.svc.create(body, principal);
  }
}
