/**
 * packaging cluster DTOs — zod create bodies (one per packaging table) + the flow action
 * bodies (create package order with optional BOM expansion, record filling, produce FG batch)
 * + the generic cursor list query. Bodies carry only the Data Dictionary columns; the service
 * fills the meta tail (status, created_by / updated_by from the principal). Numerics arrive as
 * numbers and are stringified at insert; timestamps as ISO datetime strings; dates as plain
 * strings; cross-schema / dict-soft refs are plain uuids.
 */
import { z } from 'zod';

/** Generic cursor list query shared by every table. */
export const listQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListQuery = z.infer<typeof listQuery>;

/* ── catalog: product category master ─────────────────────────────────── */

export const createProductCategory = z.object({
  categoryCode: z.string(),
  categoryName: z.string(),
});
export type CreateProductCategory = z.infer<typeof createProductCategory>;

/* ── catalog: product master ──────────────────────────────────────────── */

export const createProduct = z.object({
  formulaId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  productCategoryId: z.string().uuid().optional(),
  productCode: z.string(),
  productName: z.string(),
});
export type CreateProduct = z.infer<typeof createProduct>;

/* ── catalog: product sku ─────────────────────────────────────────────── */

export const createProductSku = z.object({
  productId: z.string().uuid().optional(),
  skuCode: z.string(),
  packSize: z.string().optional(),
  uomId: z.string().uuid().optional(),
});
export type CreateProductSku = z.infer<typeof createProductSku>;

/* ── catalog: packaging material master ───────────────────────────────── */

export const createPackagingMaterial = z.object({
  packagingMaterialCode: z.string(),
  packagingMaterialName: z.string(),
  uomId: z.string().uuid().optional(),
});
export type CreatePackagingMaterial = z.infer<typeof createPackagingMaterial>;

/* ── catalog: packaging bom master ────────────────────────────────────── */

export const createPackagingBom = z.object({
  productSkuId: z.string().uuid().optional(),
  packagingMaterialId: z.string().uuid().optional(),
  requiredQty: z.number().optional(),
  uomId: z.string().uuid().optional(),
});
export type CreatePackagingBom = z.infer<typeof createPackagingBom>;

/* ── orders: package order (flow create) ──────────────────────────────── */

export const createPackageOrder = z.object({
  productSkuId: z.string().uuid(),
  oilBatchId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  orderQty: z.number(),
  uomId: z.string().uuid().optional(),
  plannedStartDt: z.string().datetime().optional(),
  plannedEndDt: z.string().datetime().optional(),
});
export type CreatePackageOrder = z.infer<typeof createPackageOrder>;

/* ── orders: package order item ───────────────────────────────────────── */

export const createPackageOrderItem = z.object({
  packageOrderId: z.string().uuid(),
  packagingMaterialId: z.string().uuid().optional(),
  requiredQty: z.number().optional(),
  issuedQty: z.boolean().optional(),
  uomId: z.string().uuid().optional(),
});
export type CreatePackageOrderItem = z.infer<typeof createPackageOrderItem>;

/* ── orders: filling session (flow start/end) ─────────────────────────── */

export const createFillingSession = z.object({
  packageOrderId: z.string().uuid().optional(),
  operatorId: z.string().uuid().optional(),
  sessionStartDt: z.string().datetime().optional(),
});
export type CreateFillingSession = z.infer<typeof createFillingSession>;

/** Flow body for POST /v1/filling-sessions/:id/end — close the session. */
export const endFillingSession = z.object({
  sessionEndDt: z.string().datetime().optional(),
});
export type EndFillingSession = z.infer<typeof endFillingSession>;

/* ── orders: filling session details (flow record) ────────────────────── */

export const recordFilling = z.object({
  filledQty: z.number().optional(),
  rejectedQty: z.number().optional(),
  uomId: z.string().uuid().optional(),
  recordedDt: z.string().datetime().optional(),
});
export type RecordFilling = z.infer<typeof recordFilling>;

/* ── batch: finished-good batch (flow produce) ────────────────────────── */

export const consumptionLine = z.object({
  consumedForDocumentId: z.string().uuid().optional(),
  consumedQty: z.number().optional(),
  uomId: z.string().uuid().optional(),
});
export type ConsumptionLine = z.infer<typeof consumptionLine>;

export const produceFinishedGoodBatch = z.object({
  packageOrderId: z.string().uuid(),
  productSkuId: z.string().uuid(),
  batchNumber: z.string(),
  producedQty: z.number(),
  uomId: z.string().uuid().optional(),
  manufacturingDate: z.string().optional(),
  expiryDate: z.string().optional(),
  consumption: z.array(consumptionLine).optional(),
});
export type ProduceFinishedGoodBatch = z.infer<typeof produceFinishedGoodBatch>;

/* ── batch: finished-goods batch consumption (plain create) ───────────── */

export const createBatchConsumption = z.object({
  finishedGoodBatchId: z.string().uuid(),
  consumedForDocumentId: z.string().uuid().optional(),
  consumedQty: z.number().optional(),
  uomId: z.string().uuid().optional(),
  consumedDt: z.string().datetime().optional(),
});
export type CreateBatchConsumption = z.infer<typeof createBatchConsumption>;
