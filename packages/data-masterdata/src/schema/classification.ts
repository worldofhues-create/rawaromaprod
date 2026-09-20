/**
 * Material classification masters (Phase-1A Data Dictionary, schema `masterdata`):
 * MATERIAL_TYPE_MASTER, MATERIAL_CATEGORY_MASTER, MATERIAL_SUBCATEGORY_MASTER,
 * MATERIAL_GROUP. The chain category→type, subcategory→category, group→subcategory is
 * all in-schema, so each parent ref is a real FK.
 */
import { index, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { masterdata } from "./_schema.js";

/** MATERIAL_TYPE_MASTER */
export const materialTypeMaster = masterdata.table(
  "material_type_master",
  {
    materialTypeId: dictPk("material_type_id"),
    typeCode: varchar("type_code", { length: 50 }),
    typeName: varchar("type_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("material_type_master_code_uq").on(t.typeCode)],
);

/** MATERIAL_CATEGORY_MASTER — material_type_id is an in-schema FK to MATERIAL_TYPE_MASTER. */
export const materialCategoryMaster = masterdata.table(
  "material_category_master",
  {
    materialCategoryId: dictPk("material_category_id"),
    materialTypeId: uuid("material_type_id").references(() => materialTypeMaster.materialTypeId),
    categoryCode: varchar("category_code", { length: 50 }),
    categoryName: varchar("category_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("material_category_master_code_uq").on(t.categoryCode),
    index("material_category_master_type_idx").on(t.materialTypeId),
  ],
);

/** MATERIAL_SUBCATEGORY_MASTER — material_category_id is an in-schema FK. */
export const materialSubcategoryMaster = masterdata.table(
  "material_subcategory_master",
  {
    materialSubcategoryId: dictPk("material_subcategory_id"),
    materialCategoryId: uuid("material_category_id").references(
      () => materialCategoryMaster.materialCategoryId,
    ),
    subCategoryCode: varchar("sub_category_code", { length: 50 }),
    subCategoryName: varchar("sub_category_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("material_subcategory_master_code_uq").on(t.subCategoryCode),
    index("material_subcategory_master_category_idx").on(t.materialCategoryId),
  ],
);

/** MATERIAL_GROUP — material_subcategory_id is an in-schema FK. */
export const materialGroup = masterdata.table(
  "material_group",
  {
    materialGroupId: dictPk("material_group_id"),
    materialSubcategoryId: uuid("material_subcategory_id").references(
      () => materialSubcategoryMaster.materialSubcategoryId,
    ),
    groupCode: varchar("group_code", { length: 50 }),
    groupName: varchar("group_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("material_group_code_uq").on(t.groupCode),
    index("material_group_subcategory_idx").on(t.materialSubcategoryId),
  ],
);
