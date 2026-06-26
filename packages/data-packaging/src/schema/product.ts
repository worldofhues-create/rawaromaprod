/**
 * Product + SKU + packaging-material tables (Phase-1A Data Dictionary): PRODUCT_CATEGORY_MASTER,
 * PRODUCT_MASTER, PRODUCT_SKU, PACKAGING_MATERIAL_MASTER, PACKAGING_BOM_MASTER.
 *
 * In-schema FKs: product_category → product → product_sku. Per the dictionary, the BOM and
 * downstream order tables reference product_sku as a SOFT ref (id-only), as do formula/brand/
 * location/oil_batch/uom — all cross-schema soft refs (no cross-schema FK).
 */
import { index, numeric, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { packaging } from "./_schema.js";

/** PRODUCT_CATEGORY_MASTER */
export const productCategoryMaster = packaging.table(
  "product_category_master",
  {
    productCategoryId: dictPk("product_category_id"),
    categoryCode: varchar("category_code", { length: 50 }),
    categoryName: varchar("category_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("product_category_master_code_uq").on(t.categoryCode)],
);

/** PRODUCT_MASTER — formula/brand are cross-schema soft refs; product_category is in-schema FK. */
export const productMaster = packaging.table(
  "product_master",
  {
    productId: dictPk("product_id"),
    // soft refs → formula / platform schemas
    formulaId: uuid("formula_id"),
    brandId: uuid("brand_id"),
    productCategoryId: uuid("product_category_id").references(
      () => productCategoryMaster.productCategoryId,
    ),
    productCode: varchar("product_code", { length: 50 }),
    productName: varchar("product_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("product_master_code_uq").on(t.productCode),
    index("product_master_category_idx").on(t.productCategoryId),
    index("product_master_formula_idx").on(t.formulaId),
    index("product_master_brand_idx").on(t.brandId),
  ],
);

/** PRODUCT_SKU — product is in-schema FK; uom is a cross-schema soft ref. */
export const productSku = packaging.table(
  "product_sku",
  {
    productSkuId: dictPk("product_sku_id"),
    productId: uuid("product_id").references(() => productMaster.productId),
    skuCode: varchar("sku_code", { length: 50 }),
    packSize: varchar("pack_size", { length: 255 }),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("product_sku_code_uq").on(t.skuCode),
    index("product_sku_product_idx").on(t.productId),
  ],
);

/** PACKAGING_MATERIAL_MASTER — uom is a cross-schema soft ref. */
export const packagingMaterialMaster = packaging.table(
  "packaging_material_master",
  {
    packagingMaterialId: dictPk("packaging_material_id"),
    packagingMaterialCode: varchar("packaging_material_code", { length: 50 }),
    packagingMaterialName: varchar("packaging_material_name", { length: 200 }),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    ...metaColumns(),
  },
  (t) => [uniqueIndex("packaging_material_master_code_uq").on(t.packagingMaterialCode)],
);

/**
 * PACKAGING_BOM_MASTER — packaging bill of materials per SKU. Per the dictionary, both
 * product_sku_id and packaging_material_id are soft refs (id-only, no FK).
 */
export const packagingBomMaster = packaging.table(
  "packaging_bom_master",
  {
    packagingBomId: dictPk("packaging_bom_id"),
    productSkuId: uuid("product_sku_id"), // soft ref → product_sku (dict marks soft)
    packagingMaterialId: uuid("packaging_material_id"), // soft ref → packaging_material_master
    requiredQty: numeric("required_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    ...metaColumns(),
  },
  (t) => [
    index("packaging_bom_master_sku_idx").on(t.productSkuId),
    index("packaging_bom_master_material_idx").on(t.packagingMaterialId),
  ],
);
