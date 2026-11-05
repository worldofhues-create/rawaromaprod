/**
 * Packing and logistics stations (lane pf-c, plan section 6 stations 5-6, section 9, 12.6;
 * migration scripts/migrations/2026-11-05-pfc-floor.sql). Weights are integer milligrams.
 *
 *   shipment          one order's packing + dispatch: lots, cartons, AWB, handover.
 *   shipment_carton   carton i of N; closed with its gross weight; checked at logistics.
 *   shipment_unit     one filled, sealed, labelled unit, scanned into a carton.
 *   courier_connector off / test / live, credentials sealed (never returned).
 */
import { bigint, boolean, index, integer, jsonb, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { dictPk } from "@core/data-kernel";
import { sales } from "./_schema.js";

export const shipment = sales.table(
  "shipment",
  {
    shipmentId: dictPk("shipment_id"),
    shipmentNo: varchar("shipment_no", { length: 30 }).notNull().unique(),
    salesOrderId: uuid("sales_order_id").notNull(),
    status: varchar("status", { length: 14 }).notNull().default("PACKING"),
    lots: uuid("lots").array().notNull(),
    cartonCount: integer("carton_count"),
    docs: jsonb("docs"),
    courierCode: varchar("courier_code", { length: 40 }),
    awb: varchar("awb", { length: 60 }),
    awbSource: varchar("awb_source", { length: 6 }),
    awbAt: timestamp("awb_at", { withTimezone: true }),
    dispatchId: uuid("dispatch_id"),
    handedOverAt: timestamp("handed_over_at", { withTimezone: true }),
    handedOverTo: varchar("handed_over_to", { length: 120 }),
    handedOverBy: uuid("handed_over_by"),
    holdReason: text("hold_reason"),
    packedAt: timestamp("packed_at", { withTimezone: true }),
    packedBy: uuid("packed_by"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shipment_awb_uq").on(sql`upper(${t.awb})`).where(sql`${t.awb} is not null`),
    index("shipment_status_idx").on(t.status, t.createdAt),
  ],
);

export const shipmentCarton = sales.table(
  "shipment_carton",
  {
    cartonId: dictPk("carton_id"),
    shipmentId: uuid("shipment_id").notNull().references(() => shipment.shipmentId),
    seq: integer("seq").notNull(),
    cartonCode: varchar("carton_code", { length: 40 }).notNull().unique(),
    status: varchar("status", { length: 8 }).notNull().default("OPEN"),
    grossMg: bigint("gross_mg", { mode: "number" }),
    weightSource: varchar("weight_source", { length: 6 }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    checkedBy: uuid("checked_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.shipmentId, t.seq)],
);

export const shipmentUnit = sales.table(
  "shipment_unit",
  {
    unitId: dictPk("unit_id"),
    unitCode: varchar("unit_code", { length: 40 }).notNull().unique(),
    shipmentId: uuid("shipment_id").notNull().references(() => shipment.shipmentId),
    salesOrderId: uuid("sales_order_id").notNull(),
    salesOrderItemId: uuid("sales_order_item_id"),
    finishedGoodBatchId: uuid("finished_good_batch_id").notNull(),
    batchNumber: varchar("batch_number", { length: 50 }),
    targetMg: bigint("target_mg", { mode: "number" }).notNull(),
    toleranceMg: bigint("tolerance_mg", { mode: "number" }).notNull(),
    netMg: bigint("net_mg", { mode: "number" }).notNull(),
    weightSource: varchar("weight_source", { length: 6 }).notNull(),
    scaleReadingId: uuid("scale_reading_id"),
    sealed: boolean("sealed").notNull(),
    cartonId: uuid("carton_id").references(() => shipmentCarton.cartonId),
    cartonScannedAt: timestamp("carton_scanned_at", { withTimezone: true }),
    packedBy: uuid("packed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shipment_unit_shipment_idx").on(t.shipmentId)],
);

export const courierConnector = sales.table("courier_connector", {
  provider: varchar("provider", { length: 40 }).primaryKey(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  mode: varchar("mode", { length: 5 }).notNull().default("off"),
  credentialsSealed: text("credentials_sealed"),
  awbPattern: varchar("awb_pattern", { length: 200 }),
  trackingUrlTemplate: varchar("tracking_url_template", { length: 300 }),
  health: varchar("health", { length: 12 }).notNull().default("unknown"),
  healthNote: text("health_note"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
