/**
 * UOM + brand reference masters (Phase-1A Data Dictionary): UOM_TYPE_MASTER,
 * UOM_MASTER, UOM_CONVERSION_MASTER, BRAND_MASTER. UOM_CONVERSION_MASTER references
 * UOM_TYPE_MASTER and UOM_MASTER (in-schema FKs).
 */
import { boolean, index, numeric, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { platform } from "./_schema.js";

/** UOM_TYPE_MASTER */
export const uomTypeMaster = platform.table(
  "uom_type_master",
  {
    uomTypeId: dictPk("uom_type_id"),
    typeCode: varchar("type_code", { length: 50 }),
    typeName: varchar("type_name", { length: 200 }),
    description: text("description"),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("uom_type_master_code_uq").on(t.typeCode)],
);

/** UOM_MASTER */
export const uomMaster = platform.table(
  "uom_master",
  {
    uomId: dictPk("uom_id"),
    uomCode: varchar("uom_code", { length: 50 }),
    uomName: varchar("uom_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("uom_master_code_uq").on(t.uomCode)],
);

/** UOM_CONVERSION_MASTER — uom_type_id + from_uom_id + to_uom_id are in-schema FKs. */
export const uomConversionMaster = platform.table(
  "uom_conversion_master",
  {
    uomConversionId: dictPk("uom_conversion_id"),
    uomTypeId: uuid("uom_type_id").references(() => uomTypeMaster.uomTypeId),
    fromUomId: uuid("from_uom_id").references(() => uomMaster.uomId),
    toUomId: uuid("to_uom_id").references(() => uomMaster.uomId),
    conversionFactor: numeric("conversion_factor", { precision: 18, scale: 8 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...metaColumns(),
  },
  (t) => [
    index("uom_conversion_master_type_idx").on(t.uomTypeId),
    index("uom_conversion_master_from_idx").on(t.fromUomId),
    index("uom_conversion_master_to_idx").on(t.toUomId),
  ],
);

/** BRAND_MASTER */
export const brandMaster = platform.table(
  "brand_master",
  {
    brandId: dictPk("brand_id"),
    brandCode: varchar("brand_code", { length: 50 }),
    brandName: varchar("brand_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("brand_master_code_uq").on(t.brandCode)],
);
