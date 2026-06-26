/**
 * Shared DTOs for the inventory cluster. The generic list/cursor query is reused by every
 * controller; per-table create bodies + flow-action bodies live here, grouped by feature.
 * numeric columns arrive as strings/numbers and are coerced to String(n) in the service;
 * dates arrive as ISO strings (date columns kept as-is, timestamp → new Date(iso)). Soft/
 * cross-schema refs are plain uuids (no .references at this layer — the data layer encodes
 * the in-schema FKs).
 */
import { z } from 'zod';

/* ── shared list/page ─────────────────────────────────────────────────── */

/** Cursor-paginated list query: `?cursor=&limit=` (limit coerced 1..100, default 20). */
export const listQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListQuery = z.infer<typeof listQuery>;

/** A page of rows + the cursor to fetch the next page (null when exhausted). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const num = z.union([z.number(), z.string()]);

/* ── gate ─────────────────────────────────────────────────────────────── */

/** A gate-entry document supplied at gate-entry creation (or standalone). */
export const gateEntryDocumentInput = z.object({
  documentTypeId: z.string().uuid().nullish(),
  documentId: z.string().uuid().nullish(),
});
export type GateEntryDocumentInput = z.infer<typeof gateEntryDocumentInput>;

/** POST /v1/gate-entries — header + optional document rows, one transaction. */
export const createGateEntry = z.object({
  gateEntryNumber: z.string().max(50).nullish(),
  vendorId: z.string().uuid().nullish(),
  purchaseOrderId: z.string().uuid().nullish(),
  locationId: z.string().uuid().nullish(),
  vehicleNumber: z.string().max(20).nullish(),
  entryDt: z.string().nullish(),
  exitDt: z.string().nullish(),
  driverName: z.string().max(200).nullish(),
  documents: z.array(gateEntryDocumentInput).default([]),
});
export type CreateGateEntry = z.infer<typeof createGateEntry>;

export const createGateEntryDocument = z.object({
  gateEntryId: z.string().uuid().nullish(),
  documentTypeId: z.string().uuid().nullish(),
  documentId: z.string().uuid().nullish(),
});
export type CreateGateEntryDocument = z.infer<typeof createGateEntryDocument>;

/* ── grn ──────────────────────────────────────────────────────────────── */

/** A GRN container supplied for a GRN line at receiving. */
export const grnContainerInput = z.object({
  containerCode: z.string().max(50).nullish(),
  containerQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
});
export type GrnContainerInput = z.infer<typeof grnContainerInput>;

/** A GRN line supplied at receiving; spawns an rm_batch_master + container mappings. */
export const grnItemInput = z.object({
  purchaseOrderItemId: z.string().uuid().nullish(),
  materialId: z.string().uuid().nullish(),
  receivedQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
  acceptedQty: num.nullish(),
  rejectedQty: num.nullish(),
  manufacturingDate: z.string().nullish(),
  expiryDate: z.string().nullish(),
  storageLocationId: z.string().uuid().nullish(),
  containers: z.array(grnContainerInput).default([]),
});
export type GrnItemInput = z.infer<typeof grnItemInput>;

/** POST /v1/grns — grn_master + grn_items + grn_container + rm_batch_master per item. */
export const createGrn = z.object({
  grnNumber: z.string().max(50).nullish(),
  gateEntryId: z.string().uuid().nullish(),
  purchaseOrderId: z.string().uuid().nullish(),
  vendorId: z.string().uuid().nullish(),
  locationId: z.string().uuid().nullish(),
  grnDate: z.string().nullish(),
  items: z.array(grnItemInput).default([]),
});
export type CreateGrn = z.infer<typeof createGrn>;

export const createGrnItem = z.object({
  grnId: z.string().uuid().nullish(),
  purchaseOrderItemId: z.string().uuid().nullish(),
  materialId: z.string().uuid().nullish(),
  receivedQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
  acceptedQty: num.nullish(),
  rejectedQty: num.nullish(),
});
export type CreateGrnItem = z.infer<typeof createGrnItem>;

export const createGrnContainer = z.object({
  grnId: z.string().uuid().nullish(),
  grnItemId: z.string().uuid().nullish(),
  containerCode: z.string().max(50).nullish(),
  containerQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
});
export type CreateGrnContainer = z.infer<typeof createGrnContainer>;

/* ── batch ────────────────────────────────────────────────────────────── */

export const createRmBatch = z.object({
  grnItemId: z.string().uuid().nullish(),
  materialId: z.string().uuid().nullish(),
  batchNumber: z.string().max(50).nullish(),
  manufacturingDate: z.string().nullish(),
  expiryDate: z.string().nullish(),
  receivedQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
  storageLocationId: z.string().uuid().nullish(),
});
export type CreateRmBatch = z.infer<typeof createRmBatch>;

export const createBatchContainerMapping = z.object({
  rmBatchId: z.string().uuid().nullish(),
  grnContainerId: z.string().uuid().nullish(),
});
export type CreateBatchContainerMapping = z.infer<typeof createBatchContainerMapping>;

export const createBatchGenealogyHistory = z.object({
  finishedGoodBatchId: z.string().uuid().nullish(),
  oilBatchId: z.string().uuid().nullish(),
  rmBatchId: z.string().uuid().nullish(),
  relationshipType: z.string().max(30).nullish(),
  recordedDt: z.string().nullish(),
});
export type CreateBatchGenealogyHistory = z.infer<typeof createBatchGenealogyHistory>;

/** POST /v1/rm-batches/:id/release — releases an RM batch into the inventory ledger. */
export const releaseRmBatch = z.object({
  storageLocationId: z.string().uuid().nullish(),
  inventoryStatusId: z.string().uuid().nullish(),
  inventoryTransactionTypeId: z.string().uuid().nullish(),
  quantity: num.nullish(),
  uomId: z.string().uuid().nullish(),
  referenceDocumentId: z.string().uuid().nullish(),
  remarks: z.string().nullish(),
});
export type ReleaseRmBatch = z.infer<typeof releaseRmBatch>;

/* ── inventory ledger ─────────────────────────────────────────────────── */

export const createInventoryStatus = z.object({
  statusCode: z.string().max(50).nullish(),
  statusName: z.string().max(200).nullish(),
});
export type CreateInventoryStatus = z.infer<typeof createInventoryStatus>;

export const createInventoryBatch = z.object({
  rmBatchId: z.string().uuid().nullish(),
  materialId: z.string().uuid().nullish(),
  storageLocationId: z.string().uuid().nullish(),
  inventoryStatusId: z.string().uuid().nullish(),
  quantityOnHand: num.nullish(),
  uomId: z.string().uuid().nullish(),
});
export type CreateInventoryBatch = z.infer<typeof createInventoryBatch>;

export const createInventoryTransactionType = z.object({
  typeCode: z.string().max(50).nullish(),
  typeName: z.string().max(200).nullish(),
});
export type CreateInventoryTransactionType = z.infer<typeof createInventoryTransactionType>;

/** POST /v1/inventory-transactions — RECEIVE/ISSUE/TRANSFER/ADJUSTMENT; writes event history. */
export const createInventoryTransaction = z.object({
  inventoryBatchId: z.string().uuid().nullish(),
  inventoryTransactionTypeId: z.string().uuid().nullish(),
  eventType: z.string().max(50).nullish(),
  transactionQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
  fromLocationId: z.string().uuid().nullish(),
  toLocationId: z.string().uuid().nullish(),
  transactionDt: z.string().nullish(),
  referenceDocumentId: z.string().uuid().nullish(),
  referenceDocumentType: z.string().max(50).nullish(),
  remarks: z.string().nullish(),
});
export type CreateInventoryTransaction = z.infer<typeof createInventoryTransaction>;

export const createInventoryEventHistory = z.object({
  inventoryBatchId: z.string().uuid().nullish(),
  eventType: z.string().max(50).nullish(),
  eventDt: z.string().nullish(),
  inventoryTransactionId: z.string().uuid().nullish(),
  referenceDocumentId: z.string().uuid().nullish(),
  referenceDocumentType: z.string().max(50).nullish(),
  performedBy: z.string().uuid().nullish(),
  remarks: z.string().nullish(),
});
export type CreateInventoryEventHistory = z.infer<typeof createInventoryEventHistory>;

/* ── stock ops ────────────────────────────────────────────────────────── */

export const createStockAdjustment = z.object({
  inventoryBatchId: z.string().uuid().nullish(),
  adjustmentQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
  adjustmentReason: z.string().nullish(),
  adjustmentDt: z.string().nullish(),
  approvedBy: z.string().uuid().nullish(),
});
export type CreateStockAdjustment = z.infer<typeof createStockAdjustment>;

/** A stock-audit detail line supplied at audit creation (or standalone). */
export const stockAuditDetailInput = z.object({
  materialId: z.string().uuid().nullish(),
  inventoryBatchId: z.string().uuid().nullish(),
  storageLocationId: z.string().uuid().nullish(),
  systemQty: num.nullish(),
  countedQty: num.nullish(),
  varianceQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
  countedBy: z.string().uuid().nullish(),
  countedDt: z.string().nullish(),
  varianceReason: z.string().nullish(),
});
export type StockAuditDetailInput = z.infer<typeof stockAuditDetailInput>;

/** POST /v1/stock-audits — audit header + optional detail lines, one transaction. */
export const createStockAudit = z.object({
  auditCode: z.string().max(50).nullish(),
  auditType: z.string().max(30).nullish(),
  locationId: z.string().uuid().nullish(),
  auditStartDt: z.string().nullish(),
  auditEndDt: z.string().nullish(),
  initiatedBy: z.string().uuid().nullish(),
  approvedBy: z.string().uuid().nullish(),
  approvedDt: z.string().nullish(),
  remarks: z.string().nullish(),
  details: z.array(stockAuditDetailInput).default([]),
});
export type CreateStockAudit = z.infer<typeof createStockAudit>;

export const createStockAuditDetail = z.object({
  stockAuditId: z.string().uuid().nullish(),
  materialId: z.string().uuid().nullish(),
  inventoryBatchId: z.string().uuid().nullish(),
  storageLocationId: z.string().uuid().nullish(),
  systemQty: num.nullish(),
  countedQty: num.nullish(),
  varianceQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
  countedBy: z.string().uuid().nullish(),
  countedDt: z.string().nullish(),
  varianceReason: z.string().nullish(),
});
export type CreateStockAuditDetail = z.infer<typeof createStockAuditDetail>;

export const createStockReservation = z.object({
  inventoryBatchId: z.string().uuid().nullish(),
  reservedQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
  reservedForDocumentId: z.string().uuid().nullish(),
  reservedDt: z.string().nullish(),
  releasedDt: z.string().nullish(),
});
export type CreateStockReservation = z.infer<typeof createStockReservation>;

export const createStockTransfer = z.object({
  inventoryBatchId: z.string().uuid().nullish(),
  fromLocationId: z.string().uuid().nullish(),
  toLocationId: z.string().uuid().nullish(),
  transferQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
  transferDt: z.string().nullish(),
  requestedBy: z.string().uuid().nullish(),
});
export type CreateStockTransfer = z.infer<typeof createStockTransfer>;

/* ── expiry ───────────────────────────────────────────────────────────── */

export const createExpiryTracker = z.object({
  batchType: z.string().max(30),
  rmBatchId: z.string().uuid().nullish(),
  oilBatchId: z.string().uuid().nullish(),
  finishedGoodBatchId: z.string().uuid().nullish(),
  materialId: z.string().uuid().nullish(),
  manufacturingDate: z.string().nullish(),
  expiryDate: z.string().nullish(),
  remainingDays: z.number().int().nullish(),
  alertThresholdDays: z.number().int().nullish(),
  alertSentDt: z.string().nullish(),
  alertSentTo: z.string().uuid().nullish(),
});
export type CreateExpiryTracker = z.infer<typeof createExpiryTracker>;
