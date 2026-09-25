/**
 * FG_LABEL_RECORD (OPS-GREEN Act L, lane ops-factory; migration
 * scripts/migrations/2026-09-25-factory-weighing-labels.sql). The label applied to a
 * finished-good batch. `label_content` is composed server-side from the batch's own record (SKU
 * code, batch number, manufacturing/expiry dates, net quantity) — never typed in by the
 * operator, never an invented regulatory field. Packaging QC cannot pass its label check for a
 * batch with no APPLIED label. In-schema FK: fg_label_record -> finished_good_batch_master.
 */
import { index, integer, jsonb, timestamp, uuid } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { packaging } from "./_schema.js";
import { finishedGoodBatchMaster } from "./batch.js";

export const fgLabelRecord = packaging.table(
  "fg_label_record",
  {
    fgLabelRecordId: dictPk("fg_label_record_id"),
    finishedGoodBatchId: uuid("finished_good_batch_id")
      .notNull()
      .references(() => finishedGoodBatchMaster.finishedGoodBatchId),
    labelCount: integer("label_count").notNull(),
    labelContent: jsonb("label_content").notNull(),
    appliedBy: uuid("applied_by"), // soft ref → iam.user_master
    appliedDt: timestamp("applied_dt", { withTimezone: true }).notNull().defaultNow(),
    ...metaColumns(),
  },
  (t) => [index("fg_label_record_batch_idx").on(t.finishedGoodBatchId)],
);
