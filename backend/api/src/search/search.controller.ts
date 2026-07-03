/**
 * SearchController — GET /v1/search?resource=<endpoint>&q=<text>. Auth required (edge guard);
 * only whitelisted resources are searchable and masking still applies, so results respect the
 * material-alias protection. (Per-resource read-permission gating is a hardening follow-up.)
 */
import { Controller, Get, Query } from '@nestjs/common';
import { SearchService } from './search.service.js';

@Controller()
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get('v1/search')
  search(@Query('resource') resource: string, @Query('q') q?: string, @Query('limit') limit?: string) {
    return this.svc.search(resource, q ?? '', limit ? Number(limit) : 100);
  }
}
