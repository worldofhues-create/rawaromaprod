/**
 * CatalogController — REST over the packaging master catalog (5 tables). Reads require
 * `packaging:<table>:read`, writes `:write`. Plain CRUD: list (cursor) + get + create per
 * table. Per-arg ZodValidationPipe; principal from the token.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { CatalogService } from './catalog.service.js';
import {
  createPackagingBom,
  createPackagingMaterial,
  createProduct,
  createProductCategory,
  createProductSku,
  listQuery,
  type CreatePackagingBom,
  type CreatePackagingMaterial,
  type CreateProduct,
  type CreateProductCategory,
  type CreateProductSku,
  type ListQuery,
} from '../packaging.dtos.js';

@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /* ── product category master ──────────────────────────────────────── */

  @Permissions('packaging:product_category_master:read')
  @Get('v1/product-categories')
  listProductCategories(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.catalog.listProductCategories(query);
  }

  @Permissions('packaging:product_category_master:read')
  @Get('v1/product-categories/:id')
  getProductCategory(@Param('id') id: string) {
    return this.catalog.getProductCategory(id);
  }

  @Permissions('packaging:product_category_master:write')
  @Post('v1/product-categories')
  createProductCategory(
    @Body(new ZodValidationPipe(createProductCategory)) body: CreateProductCategory,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.catalog.createProductCategory(body, principal);
  }

  /* ── product master ───────────────────────────────────────────────── */

  @Permissions('packaging:product_master:read')
  @Get('v1/products')
  listProducts(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.catalog.listProducts(query);
  }

  @Permissions('packaging:product_master:read')
  @Get('v1/products/:id')
  getProduct(@Param('id') id: string) {
    return this.catalog.getProduct(id);
  }

  @Permissions('packaging:product_master:write')
  @Post('v1/products')
  createProduct(
    @Body(new ZodValidationPipe(createProduct)) body: CreateProduct,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.catalog.createProduct(body, principal);
  }

  /* ── product sku ──────────────────────────────────────────────────── */

  @Permissions('packaging:product_sku:read')
  @Get('v1/product-skus')
  listProductSkus(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.catalog.listProductSkus(query);
  }

  @Permissions('packaging:product_sku:read')
  @Get('v1/product-skus/:id')
  getProductSku(@Param('id') id: string) {
    return this.catalog.getProductSku(id);
  }

  @Permissions('packaging:product_sku:write')
  @Post('v1/product-skus')
  createProductSku(
    @Body(new ZodValidationPipe(createProductSku)) body: CreateProductSku,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.catalog.createProductSku(body, principal);
  }

  /* ── packaging material master ────────────────────────────────────── */

  @Permissions('packaging:packaging_material_master:read')
  @Get('v1/packaging-materials')
  listPackagingMaterials(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.catalog.listPackagingMaterials(query);
  }

  @Permissions('packaging:packaging_material_master:read')
  @Get('v1/packaging-materials/:id')
  getPackagingMaterial(@Param('id') id: string) {
    return this.catalog.getPackagingMaterial(id);
  }

  @Permissions('packaging:packaging_material_master:write')
  @Post('v1/packaging-materials')
  createPackagingMaterial(
    @Body(new ZodValidationPipe(createPackagingMaterial)) body: CreatePackagingMaterial,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.catalog.createPackagingMaterial(body, principal);
  }

  /* ── packaging bom master ─────────────────────────────────────────── */

  @Permissions('packaging:packaging_bom_master:read')
  @Get('v1/packaging-boms')
  listPackagingBoms(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.catalog.listPackagingBoms(query);
  }

  @Permissions('packaging:packaging_bom_master:read')
  @Get('v1/packaging-boms/:id')
  getPackagingBom(@Param('id') id: string) {
    return this.catalog.getPackagingBom(id);
  }

  @Permissions('packaging:packaging_bom_master:write')
  @Post('v1/packaging-boms')
  createPackagingBom(
    @Body(new ZodValidationPipe(createPackagingBom)) body: CreatePackagingBom,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.catalog.createPackagingBom(body, principal);
  }
}
