/**
 * Oil batch tables (Phase-1A Data Dictionary): OIL_BATCH_MASTER, OIL_BATCH_CONSUMPTION,
 * OIL_BATCH_EVENT_HISTORY. The direct header->line refs (consumption/event_history->oil_batch_master)
 * are in-schema FKs; oil_batch_master's refs to production_order / secure_mixing_session and the
 * uom / user / consumed-document refs are id-only soft refs per the locked dictionary.
 */
import {
  index,
  numeric,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { production } from "./_schema.js";

/** OIL_BATCH_MASTER */
export const oilBatchMaster = production.table(
  "oil_batch_master",
  {
    oilBatchId: dictPk("oil_batch_id"),
    productionOrderId: uuid("production_order_id"), // soft ref → production_order (per locked dictionary)
    secureMixingSessionId: uuid("secure_mixing_session_id"), // soft ref → secure_mixing_session (per locked dictionary)
    batchNumber: varchar("batch_number", { length: 50 }),
    producedQty: numeric("produced_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    producedDt: timestamp("produced_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [
    index("oil_batch_master_order_idx").on(t.productionOrderId),
    index("oil_batch_master_session_idx").on(t.secureMixingSessionId),
    index("oil_batch_master_batch_number_idx").on(t.batchNumber),
  ],
);

/** OIL_BATCH_CONSUMPTION */
export const oilBatchConsumption = production.table(
  "oil_batch_consumption",
  {
    oilBatchConsumptionId: dictPk("oil_batch_consumption_id"),
    oilBatchId: uuid("oil_batch_id").references(() => oilBatchMaster.oilBatchId),
    consumedForDocumentId: uuid("consumed_for_document_id"), // soft ref
    consumedQty: numeric("consumed_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    consumedDt: timestamp("consumed_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [index("oil_batch_consumption_batch_idx").on(t.oilBatchId)],
);

/** OIL_BATCH_EVENT_HISTORY */
export const oilBatchEventHistory = production.table(
  "oil_batch_event_history",
  {
    oilBatchEventHistoryId: dictPk("oil_batch_event_history_id"),
    oilBatchId: uuid("oil_batch_id").references(() => oilBatchMaster.oilBatchId),
    eventType: varchar("event_type", { length: 30 }),
    eventDt: timestamp("event_dt", { withTimezone: true }),
    performedBy: uuid("performed_by"), // soft ref → iam.user_master
    remarks: text("remarks"),
    ...metaColumns(),
  },
  (t) => [index("oil_batch_event_history_batch_idx").on(t.oilBatchId)],
);
