/**
 * StorageController — REST CRUD for the storage-location masters
 * (storage_location_type/status/master). Reads gated by `location:<table>:read`, writes by
 * `:write`. Per-arg ZodValidationPipe; writes read the verified actor off `@CurrentUser()`.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { StorageService } from './storage.service.js';
import {
  createStorageLocationBody,
  createStorageLocationStatusBody,
  createStorageLocationTypeBody,
  listQuery,
  type CreateStorageLocationBody,
  type CreateStorageLocationStatusBody,
  type CreateStorageLocationTypeBody,
  type ListQuery,
} from '../location.dtos.js';

@Controller()
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  /* ── storage_location_type_master ─────────────────────────────────────────── */

  @Permissions('location:storage_location_type_master:read')
  @Get('v1/storage-location-types')
  listStorageLocationTypes(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.storage.listStorageLocationTypes(query);
  }

  @Permissions('location:storage_location_type_master:read')
  @Get('v1/storage-location-types/:id')
  getStorageLocationType(@Param('id') id: string) {
    return this.storage.getStorageLocationType(id);
  }

  @Permissions('location:storage_location_type_master:write')
  @Post('v1/storage-location-types')
  createStorageLocationType(
    @Body(new ZodValidationPipe(createStorageLocationTypeBody))
    body: CreateStorageLocationTypeBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.storage.createStorageLocationType(body, principal);
  }

  /* ── storage_location_status_master ───────────────────────────────────────── */

  @Permissions('location:storage_location_status_master:read')
  @Get('v1/storage-location-statuses')
  listStorageLocationStatuses(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.storage.listStorageLocationStatuses(query);
  }

  @Permissions('location:storage_location_status_master:read')
  @Get('v1/storage-location-statuses/:id')
  getStorageLocationStatus(@Param('id') id: string) {
    return this.storage.getStorageLocationStatus(id);
  }

  @Permissions('location:storage_location_status_master:write')
  @Post('v1/storage-location-statuses')
  createStorageLocationStatus(
    @Body(new ZodValidationPipe(createStorageLocationStatusBody))
    body: CreateStorageLocationStatusBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.storage.createStorageLocationStatus(body, principal);
  }

  /* ── storage_location_master ──────────────────────────────────────────────── */

  @Permissions('location:storage_location_master:read')
  @Get('v1/storage-locations')
  listStorageLocations(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.storage.listStorageLocations(query);
  }

  @Permissions('location:storage_location_master:read')
  @Get('v1/storage-locations/:id')
  getStorageLocation(@Param('id') id: string) {
    return this.storage.getStorageLocation(id);
  }

  @Permissions('location:storage_location_master:write')
  @Post('v1/storage-locations')
  createStorageLocation(
    @Body(new ZodValidationPipe(createStorageLocationBody))
    body: CreateStorageLocationBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.storage.createStorageLocation(body, principal);
  }
}
