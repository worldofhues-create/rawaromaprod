/**
 * WEIGHING_RECORD (OPS-GREEN Act L, lane ops-factory; migration
 * scripts/migrations/2026-09-25-factory-weighing-labels.sql). One gross/tare/net reading per
 * coded-instruction line of a secure mixing session, checked against the Vault-resolved target
 * quantity. Carries the floor CODE only (RM alias) — never a material id or name. In-schema FK
 * to secure_mixing_session; production_order / user refs are id-only soft refs.
 */
import { boolean, index, integer, numeric, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { production } from "./_schema.js";
import { secureMixingSession } from "./mixing.js";

export const weighingRecord = production.table(
  "weighing_record",
  {
    weighingRecordId: dictPk("weighing_record_id"),
    productionOrderId: uuid("production_order_id").notNull(),
    secureMixingSessionId: uuid("secure_mixing_session_id")
      .notNull()
      .references(() => secureMixingSession.secureMixingSessionId),
    sequenceNo: integer("sequence_no").notNull(),
    floorCode: varchar("floor_code", { length: 100 }).notNull(),
    targetQty: numeric("target_qty", { precision: 18, scale: 4 }).notNull(),
    uom: varchar("uom", { length: 30 }),
    grossQty: numeric("gross_qty", { precision: 18, scale: 4 }).notNull(),
    tareQty: numeric("tare_qty", { precision: 18, scale: 4 }).notNull(),
    netQty: numeric("net_qty", { precision: 18, scale: 4 }).notNull(),
    tolerancePct: numeric("tolerance_pct", { precision: 6, scale: 3 }).notNull(),
    withinTolerance: boolean("within_tolerance").notNull(),
    scaleRef: varchar("scale_ref", { length: 100 }),
    weighedBy: uuid("weighed_by"), // soft ref → iam.user_master
    weighedDt: timestamp("weighed_dt", { withTimezone: true }).notNull().defaultNow(),
    ...metaColumns(),
  },
  (t) => [
    index("weighing_record_session_idx").on(t.secureMixingSessionId),
    index("weighing_record_order_idx").on(t.productionOrderId),
  ],
);
