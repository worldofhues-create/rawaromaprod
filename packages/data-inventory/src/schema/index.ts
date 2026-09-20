/**
 * inventory schema barrel — every table in the inventory cluster (Phase-1A Data Dictionary,
 * schema `inventory`). drizzle.config.ts points `schema` here.
 *
 * 19 dictionary tables: gate_entry_master, gate_entry_documents (gate); grn_master,
 * grn_items, grn_container (GRN); rm_batch_master, batch_container_mappings,
 * batch_genealogy_history (batch genealogy); inventory_status_master, inventory_batch,
 * inventory_transaction_type_master, inventory_transaction, inventory_event_history
 * (inventory ledger); stock_adjustment, stock_audit, stock_audit_details, stock_reservation,
 * stock_transfer (stock ops); expiry_tracker. + outbox, audit_events (crosscutting).
 */
export { inventory } from "./_schema.js";

export { gateEntryMaster, gateEntryDocuments } from "./gate.js";
export { grnMaster, grnItems, grnContainer } from "./grn.js";
export {
  rmBatchMaster,
  batchContainerMappings,
  batchGenealogyHistory,
} from "./batch.js";
export {
  inventoryStatusMaster,
  inventoryBatch,
  inventoryTransactionTypeMaster,
  inventoryTransaction,
  inventoryEventHistory,
} from "./inventory-batch.js";
export {
  stockAdjustment,
  stockAudit,
  stockAuditDetails,
  stockReservation,
  stockTransfer,
} from "./stock.js";
export { expiryTracker } from "./expiry.js";
export { outbox, auditEvents } from "./crosscutting.js";
