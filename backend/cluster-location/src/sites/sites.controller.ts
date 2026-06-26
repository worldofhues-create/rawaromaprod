/**
 * SitesController — REST CRUD for the site masters (location:location_type_master,
 * location:location_master). Reads gated by `<schema>:<table>:read`, writes by `:write`.
 * Per-arg ZodValidationPipe; writes read the verified actor off `@CurrentUser()`.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { SitesService } from './sites.service.js';
import {
  createLocationBody,
  createLocationTypeBody,
  listQuery,
  type CreateLocationBody,
  type CreateLocationTypeBody,
  type ListQuery,
} from '../location.dtos.js';

@Controller()
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  /* ── location_type_master ─────────────────────────────────────────────────── */

  @Permissions('location:location_type_master:read')
  @Get('v1/location-types')
  listLocationTypes(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.sites.listLocationTypes(query);
  }

  @Permissions('location:location_type_master:read')
  @Get('v1/location-types/:id')
  getLocationType(@Param('id') id: string) {
    return this.sites.getLocationType(id);
  }

  @Permissions('location:location_type_master:write')
  @Post('v1/location-types')
  createLocationType(
    @Body(new ZodValidationPipe(createLocationTypeBody)) body: CreateLocationTypeBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.sites.createLocationType(body, principal);
  }

  /* ── location_master ──────────────────────────────────────────────────────── */

  @Permissions('location:location_master:read')
  @Get('v1/locations')
  listLocations(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.sites.listLocations(query);
  }

  @Permissions('location:location_master:read')
  @Get('v1/locations/:id')
  getLocation(@Param('id') id: string) {
    return this.sites.getLocation(id);
  }

  @Permissions('location:location_master:write')
  @Post('v1/locations')
  createLocation(
    @Body(new ZodValidationPipe(createLocationBody)) body: CreateLocationBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.sites.createLocation(body, principal);
  }
}
