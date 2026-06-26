/**
 * masterdata cluster DTOs — zod create bodies (one per masterdata table) plus the generic
 * cursor list query. Bodies carry only the Data Dictionary columns; the service fills the
 * meta tail (status default "ACTIVE", created_by/updated_by from the principal). Numerics
 * are accepted as numbers and stringified at insert; dates as ISO strings.
 */
import { z } from 'zod';

/** Generic cursor list query shared by every table. */
export const listQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListQuery = z.infer<typeof listQuery>;

/** A page of rows + the cursor to fetch the next page (null when exhausted). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/* ── classification chain ─────────────────────────────────────────────── */

export const createMaterialType = z.object({
  typeCode: z.string(),
  typeName: z.string(),
});
export type CreateMaterialType = z.infer<typeof createMaterialType>;

export const createMaterialCategory = z.object({
  materialTypeId: z.string().uuid().optional(),
  categoryCode: z.string(),
  categoryName: z.string(),
});
export type CreateMaterialCategory = z.infer<typeof createMaterialCategory>;

export const createMaterialSubcategory = z.object({
  materialCategoryId: z.string().uuid().optional(),
  subCategoryCode: z.string(),
  subCategoryName: z.string(),
});
export type CreateMaterialSubcategory = z.infer<typeof createMaterialSubcategory>;

export const createMaterialGroup = z.object({
  materialSubcategoryId: z.string().uuid().optional(),
  groupCode: z.string(),
  groupName: z.string(),
});
export type CreateMaterialGroup = z.infer<typeof createMaterialGroup>;

/* ── material + dependents ────────────────────────────────────────────── */

export const createMaterial = z.object({
  materialGroupId: z.string().uuid().optional(),
  materialTypeId: z.string().uuid().optional(),
  materialCategoryId: z.string().uuid().optional(),
  materialCode: z.string(),
  materialName: z.string(),
  uomId: z.string().uuid().optional(),
  description: z.string().optional(),
});
export type CreateMaterial = z.infer<typeof createMaterial>;

export const createRmAlias = z.object({
  materialId: z.string().uuid(),
  aliasName: z.string(),
  aliasType: z.string().optional(),
});
export type CreateRmAlias = z.infer<typeof createRmAlias>;

export const createMaterialQcSpecification = z.object({
  materialId: z.string().uuid(),
  qcParameterId: z.string().uuid().optional(),
  minValue: z.number().optional(),
  maxValue: z.number().optional(),
  targetValue: z.number().optional(),
});
export type CreateMaterialQcSpecification = z.infer<typeof createMaterialQcSpecification>;

export const createMaterialStorageRule = z.object({
  materialId: z.string().uuid(),
  storageLocationTypeId: z.string().uuid().optional(),
  minTemperature: z.string().optional(),
  maxTemperature: z.string().optional(),
  storageCondition: z.string().optional(),
});
export type CreateMaterialStorageRule = z.infer<typeof createMaterialStorageRule>;

export const createMaterialAgeing = z.object({
  materialId: z.string().uuid(),
  inventoryBatchId: z.string().uuid().optional(),
  storageLocationId: z.string().uuid().optional(),
  quantityOnHand: z.number().optional(),
  uomId: z.string().uuid().optional(),
  receiptDate: z.string().optional(),
  snapshotDate: z.string().optional(),
  ageingDays: z.number().int().optional(),
  ageingBucket: z.string().optional(),
});
export type CreateMaterialAgeing = z.infer<typeof createMaterialAgeing>;
