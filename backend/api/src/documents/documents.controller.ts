/** DocumentsController — M01 document registry. Gated by the existing platform document perms. */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { DocumentsService } from './documents.service.js';

@Controller()
export class DocumentsController {
  constructor(private readonly svc: DocumentsService) {}

  @Permissions('platform:document_master:read')
  @Get('v1/document-registry')
  list(@Query('limit') limit?: string, @Query('entityType') entityType?: string, @Query('entityId') entityId?: string) {
    return this.svc.list({ limit: limit ? Number(limit) : 100, entityType, entityId });
  }

  @Permissions('platform:document_master:read')
  @Get('v1/document-registry/:id')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Permissions('platform:document_master:write')
  @Post('v1/document-registry')
  create(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.svc.create(body, principal);
  }
}
