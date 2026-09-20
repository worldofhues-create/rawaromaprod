/**
 * masterdata schema barrel — every table in the masterdata cluster (Phase-1A Data
 * Dictionary, schema `masterdata`). drizzle.config.ts points `schema` here.
 *
 * Tables: material_type_master, material_category_master, material_subcategory_master,
 *   material_group (classification chain); material, rm_alias, material_qc_specifications,
 *   material_storage_rules, material_ageing; + outbox, audit_events (cross-cutting).
 */
export { masterdata } from "./_schema.js";

export {
  materialTypeMaster,
  materialCategoryMaster,
  materialSubcategoryMaster,
  materialGroup,
} from "./classification.js";
export {
  material,
  rmAlias,
  materialQcSpecifications,
  materialStorageRules,
  materialAgeing,
} from "./material.js";
export { outbox, auditEvents } from "./crosscutting.js";
