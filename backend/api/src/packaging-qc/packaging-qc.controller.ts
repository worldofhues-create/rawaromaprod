/**
 * PackagingQcController — REST over packaging QC. Gated by the packaging cluster's existing
 * finished-good permissions (the packaging role + owner hold them), so no new permission seed.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { PackagingQcService } from './packaging-qc.service.js';

@Controller()
export class PackagingQcController {
  constructor(private readonly svc: PackagingQcService) {}

  @Permissions('packaging:finished_good_batch_master:read')
  @Get('v1/packaging-qc')
  list(@Query('limit') limit?: string) {
    return this.svc.list(limit ? Number(limit) : 100);
  }

  @Permissions('packaging:finished_good_batch_master:read')
  @Get('v1/packaging-qc/:id')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Permissions('packaging:finished_good_batch_master:write')
  @Post('v1/packaging-qc')
  create(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.svc.create(body, principal);
  }
}
