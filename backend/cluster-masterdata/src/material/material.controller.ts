/**
 * MaterialController — REST over the material master + its dependents (rm_alias, qc
 * specifications, storage rules, ageing). Reads require `masterdata:<table>:read`, writes
 * `:write`. Per-arg ZodValidationPipe; principal from the token on writes.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { MaterialService } from './material.service.js';
import {
  createMaterial,
  createMaterialAgeing,
  createMaterialQcSpecification,
  createMaterialStorageRule,
  createRmAlias,
  listQuery,
  type CreateMaterial,
  type CreateMaterialAgeing,
  type CreateMaterialQcSpecification,
  type CreateMaterialStorageRule,
  type CreateRmAlias,
  type ListQuery,
} from '../cluster-masterdata.dtos.js';

@Controller()
export class MaterialController {
  constructor(private readonly materials: MaterialService) {}

  /* ── material ───────────────────────────────────────────────────────── */

  @Permissions('masterdata:material:read')
  @Get('v1/materials')
  listMaterials(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.materials.listMaterials(query);
  }

  @Permissions('masterdata:material:read')
  @Get('v1/materials/:id')
  getMaterial(@Param('id') id: string) {
    return this.materials.getMaterial(id);
  }

  @Permissions('masterdata:material:write')
  @Post('v1/materials')
  createMaterial(
    @Body(new ZodValidationPipe(createMaterial)) body: CreateMaterial,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.materials.createMaterial(body, principal);
  }

  /* ── rm_alias ───────────────────────────────────────────────────────── */

  @Permissions('masterdata:rm_alias:read')
  @Get('v1/rm-aliases')
  listRmAliases(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.materials.listRmAliases(query);
  }

  @Permissions('masterdata:rm_alias:read')
  @Get('v1/rm-aliases/:id')
  getRmAlias(@Param('id') id: string) {
    return this.materials.getRmAlias(id);
  }

  @Permissions('masterdata:rm_alias:write')
  @Post('v1/rm-aliases')
  createRmAlias(
    @Body(new ZodValidationPipe(createRmAlias)) body: CreateRmAlias,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.materials.createRmAlias(body, principal);
  }

  /* ── material_qc_specifications ─────────────────────────────────────── */

  @Permissions('masterdata:material_qc_specifications:read')
  @Get('v1/material-qc-specifications')
  listMaterialQcSpecifications(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.materials.listMaterialQcSpecifications(query);
  }

  @Permissions('masterdata:material_qc_specifications:read')
  @Get('v1/material-qc-specifications/:id')
  getMaterialQcSpecification(@Param('id') id: string) {
    return this.materials.getMaterialQcSpecification(id);
  }

  @Permissions('masterdata:material_qc_specifications:write')
  @Post('v1/material-qc-specifications')
  createMaterialQcSpecification(
    @Body(new ZodValidationPipe(createMaterialQcSpecification))
    body: CreateMaterialQcSpecification,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.materials.createMaterialQcSpecification(body, principal);
  }

  /* ── material_storage_rules ─────────────────────────────────────────── */

  @Permissions('masterdata:material_storage_rules:read')
  @Get('v1/material-storage-rules')
  listMaterialStorageRules(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.materials.listMaterialStorageRules(query);
  }

  @Permissions('masterdata:material_storage_rules:read')
  @Get('v1/material-storage-rules/:id')
  getMaterialStorageRule(@Param('id') id: string) {
    return this.materials.getMaterialStorageRule(id);
  }

  @Permissions('masterdata:material_storage_rules:write')
  @Post('v1/material-storage-rules')
  createMaterialStorageRule(
    @Body(new ZodValidationPipe(createMaterialStorageRule)) body: CreateMaterialStorageRule,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.materials.createMaterialStorageRule(body, principal);
  }

  /* ── material_ageing ────────────────────────────────────────────────── */

  @Permissions('masterdata:material_ageing:read')
  @Get('v1/material-ageings')
  listMaterialAgeings(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.materials.listMaterialAgeings(query);
  }

  @Permissions('masterdata:material_ageing:read')
  @Get('v1/material-ageings/:id')
  getMaterialAgeing(@Param('id') id: string) {
    return this.materials.getMaterialAgeing(id);
  }

  @Permissions('masterdata:material_ageing:write')
  @Post('v1/material-ageings')
  createMaterialAgeing(
    @Body(new ZodValidationPipe(createMaterialAgeing)) body: CreateMaterialAgeing,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.materials.createMaterialAgeing(body, principal);
  }
}
