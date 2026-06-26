/**
 * Formula core masters (Phase-1A Data Dictionary, schema `formula`):
 * FORMULA_TYPE_MASTER, FORMULA_MASTER, FORMULA_VERSION.
 * In-schema FKs: formula_master.formula_type_id → formula_type_master;
 * formula_version.formula_id → formula_master. current_version_id, formula_owner_user_id,
 * approved_by are soft refs (plain uuid, no FK).
 */
import { index, integer, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { formula } from "./_schema.js";

/** FORMULA_TYPE_MASTER */
export const formulaTypeMaster = formula.table(
  "formula_type_master",
  {
    formulaTypeId: dictPk("formula_type_id"),
    typeCode: varchar("type_code", { length: 50 }),
    typeName: varchar("type_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("formula_type_master_code_uq").on(t.typeCode)],
);

/** FORMULA_MASTER — formula_type_id is an in-schema FK; owner/current-version are soft. */
export const formulaMaster = formula.table(
  "formula_master",
  {
    formulaId: dictPk("formula_id"),
    formulaTypeId: uuid("formula_type_id").references(() => formulaTypeMaster.formulaTypeId),
    formulaCode: varchar("formula_code", { length: 50 }),
    formulaName: varchar("formula_name", { length: 200 }),
    formulaOwnerUserId: uuid("formula_owner_user_id"),
    currentVersionId: uuid("current_version_id"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("formula_master_code_uq").on(t.formulaCode),
    index("formula_master_type_idx").on(t.formulaTypeId),
    index("formula_master_owner_idx").on(t.formulaOwnerUserId),
    index("formula_master_current_version_idx").on(t.currentVersionId),
  ],
);

/** FORMULA_VERSION — formula_id is an in-schema FK; approved_by is soft. */
export const formulaVersion = formula.table(
  "formula_version",
  {
    formulaVersionId: dictPk("formula_version_id"),
    formulaId: uuid("formula_id").references(() => formulaMaster.formulaId),
    versionNumber: integer("version_number"),
    approvedBy: uuid("approved_by"),
    approvedDt: timestamp("approved_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [
    index("formula_version_formula_idx").on(t.formulaId),
    index("formula_version_approved_by_idx").on(t.approvedBy),
  ],
);
