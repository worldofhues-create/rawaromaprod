/**
 * Stock-operation tables (Phase-1A Data Dictionary, schema `inventory`): STOCK_ADJUSTMENT,
 * STOCK_AUDIT, STOCK_AUDIT_DETAILS, STOCK_RESERVATION, STOCK_TRANSFER. In-schema FKs:
 *   stock_adjustment → inventory_batch;
 *   stock_audit_details → stock_audit;
 *   stock_reservation → inventory_batch;
 *   stock_transfer → inventory_batch.
 * All other refs (location/material/user) are dict-soft → plain uuid.
 */
import { index, numeric, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { inventory } from "./_schema.js";
import { inventoryBatch } from "./inventory-batch.js";

/** STOCK_ADJUSTMENT — inventory_batch_id is an in-schema FK. */
export const stockAdjustment = inventory.table(
  "stock_adjustment",
  {
    stockAdjustmentId: dictPk("stock_adjustment_id"),
    inventoryBatchId: uuid("inventory_batch_id").references(
      () => inventoryBatch.inventoryBatchId,
    ),
    adjustmentQty: numeric("adjustment_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    adjustmentReason: text("adjustment_reason"),
    adjustmentDt: timestamp("adjustment_dt", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    ...metaColumns(),
  },
  (t) => [
    index("stock_adjustment_batch_idx").on(t.inventoryBatchId),
    index("stock_adjustment_uom_idx").on(t.uomId),
    index("stock_adjustment_approved_by_idx").on(t.approvedBy),
  ],
);

/** STOCK_AUDIT — all refs dict-soft → plain uuid. */
export const stockAudit = inventory.table(
  "stock_audit",
  {
    stockAuditId: dictPk("stock_audit_id"),
    auditCode: varchar("audit_code", { length: 50 }),
    auditType: varchar("audit_type", { length: 30 }),
    locationId: uuid("location_id"),
    auditStartDt: timestamp("audit_start_dt", { withTimezone: true }),
    auditEndDt: timestamp("audit_end_dt", { withTimezone: true }),
    initiatedBy: uuid("initiated_by"),
    approvedBy: uuid("approved_by"),
    approvedDt: timestamp("approved_dt", { withTimezone: true }),
    remarks: text("remarks"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("stock_audit_code_uq").on(t.auditCode),
    index("stock_audit_location_idx").on(t.locationId),
    index("stock_audit_initiated_by_idx").on(t.initiatedBy),
    index("stock_audit_approved_by_idx").on(t.approvedBy),
  ],
);

/** STOCK_AUDIT_DETAILS — stock_audit_id is an in-schema FK; rest dict-soft. */
export const stockAuditDetails = inventory.table(
  "stock_audit_details",
  {
    stockAuditDetailId: dictPk("stock_audit_detail_id"),
    stockAuditId: uuid("stock_audit_id").references(() => stockAudit.stockAuditId),
    materialId: uuid("material_id"),
    inventoryBatchId: uuid("inventory_batch_id"),
    storageLocationId: uuid("storage_location_id"),
    systemQty: numeric("system_qty", { precision: 18, scale: 4 }),
    countedQty: numeric("counted_qty", { precision: 18, scale: 4 }),
    varianceQty: numeric("variance_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    countedBy: uuid("counted_by"),
    countedDt: timestamp("counted_dt", { withTimezone: true }),
    varianceReason: text("variance_reason"),
    ...metaColumns(),
  },
  (t) => [
    index("stock_audit_details_audit_idx").on(t.stockAuditId),
    index("stock_audit_details_material_idx").on(t.materialId),
    index("stock_audit_details_batch_idx").on(t.inventoryBatchId),
    index("stock_audit_details_storage_location_idx").on(t.storageLocationId),
    index("stock_audit_details_counted_by_idx").on(t.countedBy),
  ],
);

/** STOCK_RESERVATION — inventory_batch_id is an in-schema FK. */
export const stockReservation = inventory.table(
  "stock_reservation",
  {
    stockReservationId: dictPk("stock_reservation_id"),
    inventoryBatchId: uuid("inventory_batch_id").references(
      () => inventoryBatch.inventoryBatchId,
    ),
    reservedQty: numeric("reserved_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    reservedForDocumentId: uuid("reserved_for_document_id"),
    reservedDt: timestamp("reserved_dt", { withTimezone: true }),
    releasedDt: timestamp("released_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [
    index("stock_reservation_batch_idx").on(t.inventoryBatchId),
    index("stock_reservation_document_idx").on(t.reservedForDocumentId),
  ],
);

/** STOCK_TRANSFER — inventory_batch_id is an in-schema FK; locations/user dict-soft. */
export const stockTransfer = inventory.table(
  "stock_transfer",
  {
    stockTransferId: dictPk("stock_transfer_id"),
    inventoryBatchId: uuid("inventory_batch_id").references(
      () => inventoryBatch.inventoryBatchId,
    ),
    fromLocationId: uuid("from_location_id"),
    toLocationId: uuid("to_location_id"),
    transferQty: numeric("transfer_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    transferDt: timestamp("transfer_dt", { withTimezone: true }),
    requestedBy: uuid("requested_by"),
    ...metaColumns(),
  },
  (t) => [
    index("stock_transfer_batch_idx").on(t.inventoryBatchId),
    index("stock_transfer_from_location_idx").on(t.fromLocationId),
    index("stock_transfer_to_location_idx").on(t.toLocationId),
    index("stock_transfer_requested_by_idx").on(t.requestedBy),
  ],
);
