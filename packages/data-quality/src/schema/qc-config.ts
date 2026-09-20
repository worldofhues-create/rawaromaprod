/**
 * QC parameter catalog (Phase-1A Data Dictionary, schema `quality`): QC_PARAMETER_MASTER.
 * uom_id is a cross-schema SOFT ref (platform.uom_master) — plain uuid, no FK.
 */
import { index, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { quality } from "./_schema.js";

/** QC_PARAMETER_MASTER — qc_parameter_id PK; uom_id soft→platform.uom_master. */
export const qcParameterMaster = quality.table(
  "qc_parameter_master",
  {
    qcParameterId: dictPk("qc_parameter_id"),
    parameterCode: varchar("parameter_code", { length: 50 }),
    parameterName: varchar("parameter_name", { length: 200 }),
    uomId: uuid("uom_id"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("qc_parameter_master_code_uq").on(t.parameterCode),
    index("qc_parameter_master_uom_idx").on(t.uomId),
  ],
);
