/**
 * GeoController — the geographic hierarchy below Country. Reads are auth-only (edge guard);
 * writes are permission-checked inside GeoService (platform:geo_location_master:write), mirroring
 * the EditController pattern where a static @Permissions can't express the per-op rule cleanly.
 */
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthPrincipal } from '@core/backend-kernel';
import { GeoService } from './geo.service.js';

@Controller()
export class GeoController {
  constructor(private readonly svc: GeoService) {}

  @Get('v1/geo-region-types')
  listRegionTypes() {
    return this.svc.listRegionTypes();
  }

  @Post('v1/geo-region-types')
  createRegionType(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.svc.createRegionType(body, principal);
  }

  @Get('v1/geo-regions')
  listRegions(@Query('typeKey') typeKey?: string, @Query('limit') limit?: string) {
    return this.svc.listRegions(typeKey, limit ? Number(limit) : 200);
  }

  @Post('v1/geo-regions')
  createRegion(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.svc.createRegion(body, principal);
  }

  @Patch('v1/geo-regions/:id')
  updateRegion(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.svc.updateRegion(id, body, principal);
  }
}
