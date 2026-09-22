/**
 * Inventory batch + transaction tables (Phase-1A Data Dictionary, schema `inventory`):
 * INVENTORY_STATUS_MASTER, INVENTORY_BATCH, INVENTORY_TRANSACTION_TYPE_MASTER,
 * INVENTORY_TRANSACTION, INVENTORY_EVENT_HISTORY. In-schema FKs:
 *   inventory_batch → inventory_status_master;
 *   inventory_transaction → inventory_batch + inventory_transaction_type_master.
 * inventory_event_history refs are dict-soft → plain uuid.
 */
import { index, numeric, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { inventory } from "./_schema.js";

/** INVENTORY_STATUS_MASTER */
export const inventoryStatusMaster = inventory.table(
  "inventory_status_master",
  {
    inventoryStatusId: dictPk("inventory_status_id"),
    statusCode: varchar("status_code", { length: 50 }),
    statusName: varchar("status_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("inventory_status_master_code_uq").on(t.statusCode)],
);

/** INVENTORY_BATCH — inventory_status_id is an in-schema FK; all else dict-soft. */
export const inventoryBatch = inventory.table(
  "inventory_batch",
  {
    inventoryBatchId: dictPk("inventory_batch_id"),
    rmBatchId: uuid("rm_batch_id"),
    materialId: uuid("material_id"),
    storageLocationId: uuid("storage_location_id"),
    inventoryStatusId: uuid("inventory_status_id").references(
      () => inventoryStatusMaster.inventoryStatusId,
    ),
    quantityOnHand: numeric("quantity_on_hand", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    ...metaColumns(),
  },
  (t) => [
    index("inventory_batch_rm_batch_idx").on(t.rmBatchId),
    index("inventory_batch_material_idx").on(t.materialId),
    index("inventory_batch_storage_location_idx").on(t.storageLocationId),
    index("inventory_batch_status_idx").on(t.inventoryStatusId),
    index("inventory_batch_uom_idx").on(t.uomId),
  ],
);

/** INVENTORY_TRANSACTION_TYPE_MASTER */
export const inventoryTransactionTypeMaster = inventory.table(
  "inventory_transaction_type_master",
  {
    inventoryTransactionTypeId: dictPk("inventory_transaction_type_id"),
    typeCode: varchar("type_code", { length: 50 }),
    typeName: varchar("type_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("inventory_transaction_type_master_code_uq").on(t.typeCode)],
);

/** INVENTORY_TRANSACTION — inventory_batch_id + inventory_transaction_type_id in-schema FKs. */
export const inventoryTransaction = inventory.table(
  "inventory_transaction",
  {
    inventoryTransactionId: dictPk("inventory_transaction_id"),
    inventoryBatchId: uuid("inventory_batch_id").references(
      () => inventoryBatch.inventoryBatchId,
    ),
    inventoryTransactionTypeId: uuid("inventory_transaction_type_id").references(
      () => inventoryTransactionTypeMaster.inventoryTransactionTypeId,
    ),
    transactionQty: numeric("transaction_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    fromLocationId: uuid("from_location_id"),
    toLocationId: uuid("to_location_id"),
    transactionDt: timestamp("transaction_dt", { withTimezone: true }),
    referenceDocumentId: uuid("reference_document_id"),
    ...metaColumns(),
  },
  (t) => [
    index("inventory_transaction_batch_idx").on(t.inventoryBatchId),
    index("inventory_transaction_type_idx").on(t.inventoryTransactionTypeId),
    index("inventory_transaction_from_location_idx").on(t.fromLocationId),
    index("inventory_transaction_to_location_idx").on(t.toLocationId),
    index("inventory_transaction_reference_document_idx").on(t.referenceDocumentId),
  ],
);

/** INVENTORY_EVENT_HISTORY — all refs dict-soft → plain uuid.
 *
 * event_qty (RP-PROD-004, additive — not part of the original locked dictionary, nullable so
 * existing rows are unaffected): the exact quantity this event moved. Added so the consumption
 * subscriber (backend/api/src/consumption/consumption.service.ts) can record a real, queryable
 * per-batch ledger of what it actually debited — previously the only record of "how much" was a
 * free-text `remarks` string, which nothing could safely reverse against. MixingService.
 * abortSession now sums this column (grouped by inventory_batch_id, filtered to this reference
 * document) to credit back exactly what was taken, instead of the order's planned required_qty. */
export const inventoryEventHistory = inventory.table(
  "inventory_event_history",
  {
    inventoryEventHistoryId: dictPk("inventory_event_history_id"),
    inventoryBatchId: uuid("inventory_batch_id"),
    eventType: varchar("event_type", { length: 50 }),
    eventDt: timestamp("event_dt", { withTimezone: true }),
    inventoryTransactionId: uuid("inventory_transaction_id"),
    referenceDocumentId: uuid("reference_document_id"),
    referenceDocumentType: varchar("reference_document_type", { length: 50 }),
    eventQty: numeric("event_qty", { precision: 18, scale: 4 }),
    performedBy: uuid("performed_by"),
    remarks: text("remarks"),
    ...metaColumns(),
  },
  (t) => [
    index("inventory_event_history_batch_idx").on(t.inventoryBatchId),
    index("inventory_event_history_transaction_idx").on(t.inventoryTransactionId),
    index("inventory_event_history_reference_document_idx").on(t.referenceDocumentId),
    index("inventory_event_history_performed_by_idx").on(t.performedBy),
  ],
);
