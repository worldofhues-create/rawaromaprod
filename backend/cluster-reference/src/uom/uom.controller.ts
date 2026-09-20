/**
 * UomController — REST over the uom + brand reference masters. Reads require
 * `platform:<table>:read`, writes `:write`. Per-arg ZodValidationPipe; principal from token.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { UomService } from './uom.service.js';
import {
  createBrand,
  createUom,
  createUomConversion,
  createUomType,
  listQuery,
  type CreateBrand,
  type CreateUom,
  type CreateUomConversion,
  type CreateUomType,
  type ListQuery,
} from '../reference.dtos.js';

@Controller()
export class UomController {
  constructor(private readonly uom: UomService) {}

  /* ── uom type ─────────────────────────────────────────────────────── */

  @Permissions('platform:uom_type_master:read')
  @Get('v1/uom-types')
  listUomTypes(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.uom.listUomTypes(query);
  }

  @Permissions('platform:uom_type_master:read')
  @Get('v1/uom-types/:id')
  getUomType(@Param('id') id: string) {
    return this.uom.getUomType(id);
  }

  @Permissions('platform:uom_type_master:write')
  @Post('v1/uom-types')
  createUomType(
    @Body(new ZodValidationPipe(createUomType)) body: CreateUomType,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.uom.createUomType(body, principal);
  }

  /* ── uom ──────────────────────────────────────────────────────────── */

  @Permissions('platform:uom_master:read')
  @Get('v1/uoms')
  listUoms(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.uom.listUoms(query);
  }

  @Permissions('platform:uom_master:read')
  @Get('v1/uoms/:id')
  getUom(@Param('id') id: string) {
    return this.uom.getUom(id);
  }

  @Permissions('platform:uom_master:write')
  @Post('v1/uoms')
  createUom(
    @Body(new ZodValidationPipe(createUom)) body: CreateUom,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.uom.createUom(body, principal);
  }

  /* ── uom conversion ───────────────────────────────────────────────── */

  @Permissions('platform:uom_conversion_master:read')
  @Get('v1/uom-conversions')
  listUomConversions(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.uom.listUomConversions(query);
  }

  @Permissions('platform:uom_conversion_master:read')
  @Get('v1/uom-conversions/:id')
  getUomConversion(@Param('id') id: string) {
    return this.uom.getUomConversion(id);
  }

  @Permissions('platform:uom_conversion_master:write')
  @Post('v1/uom-conversions')
  createUomConversion(
    @Body(new ZodValidationPipe(createUomConversion)) body: CreateUomConversion,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.uom.createUomConversion(body, principal);
  }

  /* ── brand ────────────────────────────────────────────────────────── */

  @Permissions('platform:brand_master:read')
  @Get('v1/brands')
  listBrands(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.uom.listBrands(query);
  }

  @Permissions('platform:brand_master:read')
  @Get('v1/brands/:id')
  getBrand(@Param('id') id: string) {
    return this.uom.getBrand(id);
  }

  @Permissions('platform:brand_master:write')
  @Post('v1/brands')
  createBrand(
    @Body(new ZodValidationPipe(createBrand)) body: CreateBrand,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.uom.createBrand(body, principal);
  }
}
