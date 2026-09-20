/**
 * Production QC tables (Phase-1A Data Dictionary): PRODUCTION_QC, OIL_BATCH_QC_HISTORY.
 * oil_batch_qc_history.oil_batch_id is an in-schema FK→oil_batch_master; production_qc.oil_batch_id
 * and oil_batch_qc_history.production_qc_id are id-only soft refs per the locked dictionary;
 * qc_parameter / user refs are soft refs to other schemas (no cross-schema FK).
 */
import { index, numeric, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { production } from "./_schema.js";
import { oilBatchMaster } from "./batch.js";

/** PRODUCTION_QC */
export const productionQc = production.table(
  "production_qc",
  {
    productionQcId: dictPk("production_qc_id"),
    oilBatchId: uuid("oil_batch_id"), // soft ref → oil_batch_master (per locked dictionary)
    qcParameterId: uuid("qc_parameter_id"), // soft ref → quality.qc_parameter_master
    observedValue: numeric("observed_value", { precision: 18, scale: 4 }),
    result: varchar("result", { length: 255 }),
    inspectedBy: uuid("inspected_by"), // soft ref → iam.user_master
    inspectionDt: timestamp("inspection_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [
    index("production_qc_oil_batch_idx").on(t.oilBatchId),
    index("production_qc_parameter_idx").on(t.qcParameterId),
  ],
);

/** OIL_BATCH_QC_HISTORY */
export const oilBatchQcHistory = production.table(
  "oil_batch_qc_history",
  {
    oilBatchQcHistoryId: dictPk("oil_batch_qc_history_id"),
    oilBatchId: uuid("oil_batch_id").references(() => oilBatchMaster.oilBatchId),
    productionQcId: uuid("production_qc_id"), // soft ref → production_qc (per locked dictionary)
    recordedDt: timestamp("recorded_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [
    index("oil_batch_qc_history_oil_batch_idx").on(t.oilBatchId),
    index("oil_batch_qc_history_qc_idx").on(t.productionQcId),
  ],
);
