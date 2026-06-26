/**
 * Material master + its dependents (Phase-1A Data Dictionary, schema `masterdata`):
 * MATERIAL, RM_ALIAS, MATERIAL_QC_SPECIFICATIONS, MATERIAL_STORAGE_RULES, MATERIAL_AGEING.
 *
 * In-schema FKs: material→material_group + material_type_master + material_category_master,
 * and rm_alias / material_qc_specifications / material_storage_rules / material_ageing →
 * material. Cross-schema refs (uom_id→platform.uom_master, qc_parameter_id→
 * quality.qc_parameter_master, storage_location_type_id→location.storage_location_type_master,
 * inventory_batch_id→inventory.inventory_batch, storage_location_id→
 * location.storage_location_master) are plain id-only SOFT refs — no FK.
 */
import { date, index, integer, numeric, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { masterdata } from "./_schema.js";
import {
  materialCategoryMaster,
  materialGroup,
  materialTypeMaster,
} from "./classification.js";

/**
 * MATERIAL — material_group_id, material_type_id, material_category_id are in-schema FKs;
 * uom_id is a soft ref to platform.uom_master.
 */
export const material = masterdata.table(
  "material",
  {
    materialId: dictPk("material_id"),
    materialGroupId: uuid("material_group_id").references(() => materialGroup.materialGroupId),
    materialTypeId: uuid("material_type_id").references(() => materialTypeMaster.materialTypeId),
    materialCategoryId: uuid("material_category_id").references(
      () => materialCategoryMaster.materialCategoryId,
    ),
    materialCode: varchar("material_code", { length: 50 }),
    materialName: varchar("material_name", { length: 200 }),
    uomId: uuid("uom_id"),
    description: text("description"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("material_code_uq").on(t.materialCode),
    index("material_group_idx").on(t.materialGroupId),
    index("material_type_idx").on(t.materialTypeId),
    index("material_category_idx").on(t.materialCategoryId),
    index("material_uom_idx").on(t.uomId),
  ],
);

/** RM_ALIAS — material_id is an in-schema FK. (alias masking: ING-A001 etc.) */
export const rmAlias = masterdata.table(
  "rm_alias",
  {
    rmAliasId: dictPk("rm_alias_id"),
    materialId: uuid("material_id").references(() => material.materialId),
    aliasName: varchar("alias_name", { length: 200 }),
    aliasType: varchar("alias_type", { length: 30 }),
    ...metaColumns(),
  },
  (t) => [index("rm_alias_material_idx").on(t.materialId)],
);

/**
 * MATERIAL_QC_SPECIFICATIONS — material_id is an in-schema FK; qc_parameter_id is a soft
 * ref to quality.qc_parameter_master.
 */
export const materialQcSpecifications = masterdata.table(
  "material_qc_specifications",
  {
    materialQcSpecificationId: dictPk("material_qc_specification_id"),
    materialId: uuid("material_id").references(() => material.materialId),
    qcParameterId: uuid("qc_parameter_id"),
    minValue: numeric("min_value", { precision: 18, scale: 4 }),
    maxValue: numeric("max_value", { precision: 18, scale: 4 }),
    targetValue: numeric("target_value", { precision: 18, scale: 4 }),
    ...metaColumns(),
  },
  (t) => [
    index("material_qc_specifications_material_idx").on(t.materialId),
    index("material_qc_specifications_qc_parameter_idx").on(t.qcParameterId),
  ],
);

/**
 * MATERIAL_STORAGE_RULES — material_id is an in-schema FK; storage_location_type_id is a
 * soft ref to location.storage_location_type_master.
 */
export const materialStorageRules = masterdata.table(
  "material_storage_rules",
  {
    materialStorageRuleId: dictPk("material_storage_rule_id"),
    materialId: uuid("material_id").references(() => material.materialId),
    storageLocationTypeId: uuid("storage_location_type_id"),
    minTemperature: varchar("min_temperature", { length: 255 }),
    maxTemperature: varchar("max_temperature", { length: 255 }),
    storageCondition: varchar("storage_condition", { length: 255 }),
    ...metaColumns(),
  },
  (t) => [
    index("material_storage_rules_material_idx").on(t.materialId),
    index("material_storage_rules_storage_location_type_idx").on(t.storageLocationTypeId),
  ],
);

/**
 * MATERIAL_AGEING — material_id is an in-schema FK; inventory_batch_id (inventory.inventory_batch),
 * storage_location_id (location.storage_location_master) and uom_id are soft refs.
 */
export const materialAgeing = masterdata.table(
  "material_ageing",
  {
    materialAgeingId: dictPk("material_ageing_id"),
    materialId: uuid("material_id").references(() => material.materialId),
    inventoryBatchId: uuid("inventory_batch_id"),
    storageLocationId: uuid("storage_location_id"),
    quantityOnHand: numeric("quantity_on_hand", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    receiptDate: date("receipt_date"),
    snapshotDate: date("snapshot_date"),
    ageingDays: integer("ageing_days"),
    ageingBucket: varchar("ageing_bucket", { length: 50 }),
    ...metaColumns(),
  },
  (t) => [
    index("material_ageing_material_idx").on(t.materialId),
    index("material_ageing_inventory_batch_idx").on(t.inventoryBatchId),
    index("material_ageing_storage_location_idx").on(t.storageLocationId),
  ],
);
