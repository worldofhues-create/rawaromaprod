/**
 * ClassificationController — REST over the material classification chain. Reads require
 * `masterdata:<table>:read`, writes `:write`. Per-arg ZodValidationPipe; principal from the
 * token on writes.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { ClassificationService } from './classification.service.js';
import {
  createMaterialCategory,
  createMaterialGroup,
  createMaterialSubcategory,
  createMaterialType,
  listQuery,
  type CreateMaterialCategory,
  type CreateMaterialGroup,
  type CreateMaterialSubcategory,
  type CreateMaterialType,
  type ListQuery,
} from '../cluster-masterdata.dtos.js';

@Controller()
export class ClassificationController {
  constructor(private readonly classification: ClassificationService) {}

  /* ── material_type_master ───────────────────────────────────────────── */

  @Permissions('masterdata:material_type_master:read')
  @Get('v1/material-types')
  listMaterialTypes(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.classification.listMaterialTypes(query);
  }

  @Permissions('masterdata:material_type_master:read')
  @Get('v1/material-types/:id')
  getMaterialType(@Param('id') id: string) {
    return this.classification.getMaterialType(id);
  }

  @Permissions('masterdata:material_type_master:write')
  @Post('v1/material-types')
  createMaterialType(
    @Body(new ZodValidationPipe(createMaterialType)) body: CreateMaterialType,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.classification.createMaterialType(body, principal);
  }

  /* ── material_category_master ───────────────────────────────────────── */

  @Permissions('masterdata:material_category_master:read')
  @Get('v1/material-categories')
  listMaterialCategories(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.classification.listMaterialCategories(query);
  }

  @Permissions('masterdata:material_category_master:read')
  @Get('v1/material-categories/:id')
  getMaterialCategory(@Param('id') id: string) {
    return this.classification.getMaterialCategory(id);
  }

  @Permissions('masterdata:material_category_master:write')
  @Post('v1/material-categories')
  createMaterialCategory(
    @Body(new ZodValidationPipe(createMaterialCategory)) body: CreateMaterialCategory,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.classification.createMaterialCategory(body, principal);
  }

  /* ── material_subcategory_master ────────────────────────────────────── */

  @Permissions('masterdata:material_subcategory_master:read')
  @Get('v1/material-subcategories')
  listMaterialSubcategories(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.classification.listMaterialSubcategories(query);
  }

  @Permissions('masterdata:material_subcategory_master:read')
  @Get('v1/material-subcategories/:id')
  getMaterialSubcategory(@Param('id') id: string) {
    return this.classification.getMaterialSubcategory(id);
  }

  @Permissions('masterdata:material_subcategory_master:write')
  @Post('v1/material-subcategories')
  createMaterialSubcategory(
    @Body(new ZodValidationPipe(createMaterialSubcategory)) body: CreateMaterialSubcategory,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.classification.createMaterialSubcategory(body, principal);
  }

  /* ── material_group ─────────────────────────────────────────────────── */

  @Permissions('masterdata:material_group:read')
  @Get('v1/material-groups')
  listMaterialGroups(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.classification.listMaterialGroups(query);
  }

  @Permissions('masterdata:material_group:read')
  @Get('v1/material-groups/:id')
  getMaterialGroup(@Param('id') id: string) {
    return this.classification.getMaterialGroup(id);
  }

  @Permissions('masterdata:material_group:write')
  @Post('v1/material-groups')
  createMaterialGroup(
    @Body(new ZodValidationPipe(createMaterialGroup)) body: CreateMaterialGroup,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.classification.createMaterialGroup(body, principal);
  }
}
