/**
 * CatalogService — CRUD over the packaging master catalog: PRODUCT_CATEGORY_MASTER,
 * PRODUCT_MASTER, PRODUCT_SKU, PACKAGING_MATERIAL_MASTER, PACKAGING_BOM_MASTER. Every create
 * stamps an explicit uuidv7() PK, status "ACTIVE", and created_by/updated_by from the
 * principal; numerics are stringified at insert (num); product_category → product → product_sku
 * are in-schema FKs (stored as-is); formula/brand/uom/material refs are dict-soft uuids. List
 * is cursor-paginated by descending PK.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { PACKAGING_DB, packagingSchema, type PackagingDb } from '../packaging.tokens.js';
import { num, paginate, type Page } from '../_helpers.js';
import type {
  CreatePackagingBom,
  CreatePackagingMaterial,
  CreateProduct,
  CreateProductCategory,
  CreateProductSku,
  ListQuery,
} from '../packaging.dtos.js';

const {
  productCategoryMaster,
  productMaster,
  productSku,
  packagingMaterialMaster,
  packagingBomMaster,
} = packagingSchema;

@Injectable()
export class CatalogService {
  constructor(@Inject(PACKAGING_DB) private readonly db: PackagingDb) {}

  /* ── product category master ──────────────────────────────────────── */

  async createProductCategory(body: CreateProductCategory, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(productCategoryMaster)
        .values({
          productCategoryId: uuidv7(),
          categoryCode: body.categoryCode,
          categoryName: body.categoryName,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: product_category_master');
    return row;
  }

  async listProductCategories(
    query: ListQuery,
  ): Promise<Page<typeof productCategoryMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(productCategoryMaster)
      .where(query.cursor ? lt(productCategoryMaster.productCategoryId, query.cursor) : undefined)
      .orderBy(desc(productCategoryMaster.productCategoryId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.productCategoryId);
  }

  async getProductCategory(id: string) {
    return (
      await this.db
        .select()
        .from(productCategoryMaster)
        .where(eq(productCategoryMaster.productCategoryId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── product master ───────────────────────────────────────────────── */

  async createProduct(body: CreateProduct, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(productMaster)
        .values({
          productId: uuidv7(),
          formulaId: body.formulaId ?? null,
          brandId: body.brandId ?? null,
          productCategoryId: body.productCategoryId ?? null,
          productCode: body.productCode,
          productName: body.productName,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: product_master');
    return row;
  }

  async listProducts(query: ListQuery): Promise<Page<typeof productMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(productMaster)
      .where(query.cursor ? lt(productMaster.productId, query.cursor) : undefined)
      .orderBy(desc(productMaster.productId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.productId);
  }

  async getProduct(id: string) {
    return (
      await this.db.select().from(productMaster).where(eq(productMaster.productId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── product sku ──────────────────────────────────────────────────── */

  async createProductSku(body: CreateProductSku, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(productSku)
        .values({
          productSkuId: uuidv7(),
          productId: body.productId ?? null,
          skuCode: body.skuCode,
          packSize: body.packSize ?? null,
          uomId: body.uomId ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: product_sku');
    return row;
  }

  async listProductSkus(query: ListQuery): Promise<Page<typeof productSku.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(productSku)
      .where(query.cursor ? lt(productSku.productSkuId, query.cursor) : undefined)
      .orderBy(desc(productSku.productSkuId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.productSkuId);
  }

  async getProductSku(id: string) {
    return (
      await this.db.select().from(productSku).where(eq(productSku.productSkuId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── packaging material master ────────────────────────────────────── */

  async createPackagingMaterial(body: CreatePackagingMaterial, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(packagingMaterialMaster)
        .values({
          packagingMaterialId: uuidv7(),
          packagingMaterialCode: body.packagingMaterialCode,
          packagingMaterialName: body.packagingMaterialName,
          uomId: body.uomId ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: packaging_material_master');
    return row;
  }

  async listPackagingMaterials(
    query: ListQuery,
  ): Promise<Page<typeof packagingMaterialMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(packagingMaterialMaster)
      .where(
        query.cursor
          ? lt(packagingMaterialMaster.packagingMaterialId, query.cursor)
          : undefined,
      )
      .orderBy(desc(packagingMaterialMaster.packagingMaterialId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.packagingMaterialId);
  }

  async getPackagingMaterial(id: string) {
    return (
      await this.db
        .select()
        .from(packagingMaterialMaster)
        .where(eq(packagingMaterialMaster.packagingMaterialId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── packaging bom master ─────────────────────────────────────────── */

  async createPackagingBom(body: CreatePackagingBom, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(packagingBomMaster)
        .values({
          packagingBomId: uuidv7(),
          productSkuId: body.productSkuId ?? null,
          packagingMaterialId: body.packagingMaterialId ?? null,
          requiredQty: num(body.requiredQty),
          uomId: body.uomId ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: packaging_bom_master');
    return row;
  }

  async listPackagingBoms(
    query: ListQuery,
  ): Promise<Page<typeof packagingBomMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(packagingBomMaster)
      .where(query.cursor ? lt(packagingBomMaster.packagingBomId, query.cursor) : undefined)
      .orderBy(desc(packagingBomMaster.packagingBomId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.packagingBomId);
  }

  async getPackagingBom(id: string) {
    return (
      await this.db
        .select()
        .from(packagingBomMaster)
        .where(eq(packagingBomMaster.packagingBomId, id))
        .limit(1)
    )[0] ?? null;
  }
}
