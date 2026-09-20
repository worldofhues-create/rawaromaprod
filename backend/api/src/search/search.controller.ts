/**
 * SearchController — GET /v1/search?resource=<endpoint>&q=<text>. Auth required (edge guard);
 * only whitelisted resources are searchable, EACH gated by that resource's own read permission
 * (so search can't bypass function-level auth — audit H-S3), and masking still applies.
 */
import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser, type AuthPrincipal } from '@core/backend-kernel';
import { SearchService } from './search.service.js';

@Controller()
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get('v1/search')
  search(
    @CurrentUser() principal: AuthPrincipal,
    @Query('resource') resource: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.search(resource, q ?? '', limit ? Number(limit) : 100, principal);
  }
}
