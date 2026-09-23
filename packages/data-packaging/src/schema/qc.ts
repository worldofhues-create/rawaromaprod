/**
 * PACKAGING_QC (Phase-1A Data Dictionary revision, doc 10 Phase-1B — see
 * docs/PHASE1B_SCHEMA_PROPOSAL.md §3): the finished-good packaging QC gate (leakage/label/carton
 * checks + overall disposition) on a `finished_good_batch_master` row. Read by six call sites
 * across four clusters (packaging-lookup, reservation, cluster-sales dispatch, fg-stock,
 * dashboard, plus the dedicated packaging-qc CRUD route) to zero out available-to-promise the
 * instant a batch FAILs QC (master directive §28-§34: "QC outcome must automatically change
 * inventory availability"). In-schema FK: packaging_qc -> finished_good_batch_master.
 * inspected_by is an id-only SOFT ref to iam.user_master (cross-schema, never a FK — same
 * pattern as po_approval_order.approver_user_id).
 */
import { index, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { packaging } from "./_schema.js";
import { finishedGoodBatchMaster } from "./batch.js";

export const packagingQc = packaging.table(
  "packaging_qc",
  {
    packagingQcId: dictPk("packaging_qc_id"),
    finishedGoodBatchId: uuid("finished_good_batch_id").references(
      () => finishedGoodBatchMaster.finishedGoodBatchId,
    ),
    leakageCheck: varchar("leakage_check", { length: 30 }),
    labelCheck: varchar("label_check", { length: 30 }),
    cartonCheck: varchar("carton_check", { length: 30 }),
    overallResult: varchar("overall_result", { length: 30 }),
    inspectedBy: uuid("inspected_by"), // soft ref → iam.user_master
    inspectionDt: timestamp("inspection_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [index("packaging_qc_batch_idx").on(t.finishedGoodBatchId)],
);
