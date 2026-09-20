/**
 * Expiry-tracking table (Phase-1A Data Dictionary, schema `inventory`): EXPIRY_TRACKER.
 * All batch/material/user refs are dict-soft → plain uuid. batch_type is NOT NULL.
 */
import { date, index, integer, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { inventory } from "./_schema.js";

/** EXPIRY_TRACKER */
export const expiryTracker = inventory.table(
  "expiry_tracker",
  {
    expiryTrackerId: dictPk("expiry_tracker_id"),
    batchType: varchar("batch_type", { length: 30 }).notNull(),
    rmBatchId: uuid("rm_batch_id"),
    oilBatchId: uuid("oil_batch_id"),
    finishedGoodBatchId: uuid("finished_good_batch_id"),
    materialId: uuid("material_id"),
    manufacturingDate: date("manufacturing_date"),
    expiryDate: date("expiry_date"),
    remainingDays: integer("remaining_days"),
    alertThresholdDays: integer("alert_threshold_days"),
    alertSentDt: timestamp("alert_sent_dt", { withTimezone: true }),
    alertSentTo: uuid("alert_sent_to"),
    ...metaColumns(),
  },
  (t) => [
    index("expiry_tracker_rm_batch_idx").on(t.rmBatchId),
    index("expiry_tracker_oil_batch_idx").on(t.oilBatchId),
    index("expiry_tracker_fg_batch_idx").on(t.finishedGoodBatchId),
    index("expiry_tracker_material_idx").on(t.materialId),
    index("expiry_tracker_alert_sent_to_idx").on(t.alertSentTo),
  ],
);
