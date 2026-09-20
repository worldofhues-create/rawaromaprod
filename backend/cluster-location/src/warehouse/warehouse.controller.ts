/**
 * WarehouseController — REST CRUD for the warehouse-hierarchy masters
 * (warehouse_type/warehouse/floor/zone_type/zone/rack/shelf/bin). Reads gated by
 * `location:<table>:read`, writes by `:write`. Per-arg ZodValidationPipe; writes read the
 * verified actor off `@CurrentUser()`.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { WarehouseService } from './warehouse.service.js';
import {
  createBinBody,
  createFloorBody,
  createRackBody,
  createShelfBody,
  createWarehouseBody,
  createWarehouseTypeBody,
  createZoneBody,
  createZoneTypeBody,
  listQuery,
  type CreateBinBody,
  type CreateFloorBody,
  type CreateRackBody,
  type CreateShelfBody,
  type CreateWarehouseBody,
  type CreateWarehouseTypeBody,
  type CreateZoneBody,
  type CreateZoneTypeBody,
  type ListQuery,
} from '../location.dtos.js';

@Controller()
export class WarehouseController {
  constructor(private readonly warehouse: WarehouseService) {}

  /* ── warehouse_type_master ────────────────────────────────────────────────── */

  @Permissions('location:warehouse_type_master:read')
  @Get('v1/warehouse-types')
  listWarehouseTypes(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.warehouse.listWarehouseTypes(query);
  }

  @Permissions('location:warehouse_type_master:read')
  @Get('v1/warehouse-types/:id')
  getWarehouseType(@Param('id') id: string) {
    return this.warehouse.getWarehouseType(id);
  }

  @Permissions('location:warehouse_type_master:write')
  @Post('v1/warehouse-types')
  createWarehouseType(
    @Body(new ZodValidationPipe(createWarehouseTypeBody)) body: CreateWarehouseTypeBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.warehouse.createWarehouseType(body, principal);
  }

  /* ── warehouse_master ─────────────────────────────────────────────────────── */

  @Permissions('location:warehouse_master:read')
  @Get('v1/warehouses')
  listWarehouses(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.warehouse.listWarehouses(query);
  }

  @Permissions('location:warehouse_master:read')
  @Get('v1/warehouses/:id')
  getWarehouse(@Param('id') id: string) {
    return this.warehouse.getWarehouse(id);
  }

  @Permissions('location:warehouse_master:write')
  @Post('v1/warehouses')
  createWarehouse(
    @Body(new ZodValidationPipe(createWarehouseBody)) body: CreateWarehouseBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.warehouse.createWarehouse(body, principal);
  }

  /* ── floor_master ─────────────────────────────────────────────────────────── */

  @Permissions('location:floor_master:read')
  @Get('v1/floors')
  listFloors(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.warehouse.listFloors(query);
  }

  @Permissions('location:floor_master:read')
  @Get('v1/floors/:id')
  getFloor(@Param('id') id: string) {
    return this.warehouse.getFloor(id);
  }

  @Permissions('location:floor_master:write')
  @Post('v1/floors')
  createFloor(
    @Body(new ZodValidationPipe(createFloorBody)) body: CreateFloorBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.warehouse.createFloor(body, principal);
  }

  /* ── zone_type_master ─────────────────────────────────────────────────────── */

  @Permissions('location:zone_type_master:read')
  @Get('v1/zone-types')
  listZoneTypes(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.warehouse.listZoneTypes(query);
  }

  @Permissions('location:zone_type_master:read')
  @Get('v1/zone-types/:id')
  getZoneType(@Param('id') id: string) {
    return this.warehouse.getZoneType(id);
  }

  @Permissions('location:zone_type_master:write')
  @Post('v1/zone-types')
  createZoneType(
    @Body(new ZodValidationPipe(createZoneTypeBody)) body: CreateZoneTypeBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.warehouse.createZoneType(body, principal);
  }

  /* ── zone_master ──────────────────────────────────────────────────────────── */

  @Permissions('location:zone_master:read')
  @Get('v1/zones')
  listZones(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.warehouse.listZones(query);
  }

  @Permissions('location:zone_master:read')
  @Get('v1/zones/:id')
  getZone(@Param('id') id: string) {
    return this.warehouse.getZone(id);
  }

  @Permissions('location:zone_master:write')
  @Post('v1/zones')
  createZone(
    @Body(new ZodValidationPipe(createZoneBody)) body: CreateZoneBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.warehouse.createZone(body, principal);
  }

  /* ── rack_master ──────────────────────────────────────────────────────────── */

  @Permissions('location:rack_master:read')
  @Get('v1/racks')
  listRacks(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.warehouse.listRacks(query);
  }

  @Permissions('location:rack_master:read')
  @Get('v1/racks/:id')
  getRack(@Param('id') id: string) {
    return this.warehouse.getRack(id);
  }

  @Permissions('location:rack_master:write')
  @Post('v1/racks')
  createRack(
    @Body(new ZodValidationPipe(createRackBody)) body: CreateRackBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.warehouse.createRack(body, principal);
  }

  /* ── shelf_master ─────────────────────────────────────────────────────────── */

  @Permissions('location:shelf_master:read')
  @Get('v1/shelves')
  listShelves(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.warehouse.listShelves(query);
  }

  @Permissions('location:shelf_master:read')
  @Get('v1/shelves/:id')
  getShelf(@Param('id') id: string) {
    return this.warehouse.getShelf(id);
  }

  @Permissions('location:shelf_master:write')
  @Post('v1/shelves')
  createShelf(
    @Body(new ZodValidationPipe(createShelfBody)) body: CreateShelfBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.warehouse.createShelf(body, principal);
  }

  /* ── bin_master ───────────────────────────────────────────────────────────── */

  @Permissions('location:bin_master:read')
  @Get('v1/bins')
  listBins(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.warehouse.listBins(query);
  }

  @Permissions('location:bin_master:read')
  @Get('v1/bins/:id')
  getBin(@Param('id') id: string) {
    return this.warehouse.getBin(id);
  }

  @Permissions('location:bin_master:write')
  @Post('v1/bins')
  createBin(
    @Body(new ZodValidationPipe(createBinBody)) body: CreateBinBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.warehouse.createBin(body, principal);
  }
}
