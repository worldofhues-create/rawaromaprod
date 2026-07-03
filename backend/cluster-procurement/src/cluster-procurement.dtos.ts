/**
 * Shared DTOs for the procurement cluster. The generic list/cursor query is reused by
 * every controller; per-table create bodies + flow-action bodies live here, grouped by
 * feature. numeric columns arrive as strings/numbers and are coerced to String(n) in the
 * service; dates arrive as ISO strings and are parsed with new Date(iso). Soft/cross-schema
 * refs are plain uuids (no .references at this layer — the data layer encodes the FKs).
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

/* ── vendor ───────────────────────────────────────────────────────────── */

export const createVendorDetails = z.object({
  organizationId: z.string().uuid().nullish(),
  vendorCode: z.string().max(50).nullish(),
  vendorName: z.string().max(200).nullish(),
  addressId: z.string().uuid().nullish(),
  baseCurrencyId: z.string().uuid().nullish(),
  paymentTerms: z.string().max(255).nullish(),
  gstin: z.string().nullish(),
  panNumber: z.string().nullish(),
  bankName: z.string().nullish(),
  bankAccountNumber: z.string().nullish(),
  bankIfsc: z.string().nullish(),
  contactEmail: z.string().nullish(),
  contactPhone: z.string().nullish(),
});
export type CreateVendorDetails = z.infer<typeof createVendorDetails>;

export const createVendorContact = z.object({
  vendorId: z.string().uuid().nullish(),
  contactName: z.string().max(200).nullish(),
  designation: z.string().max(255).nullish(),
  email: z.string().max(150).nullish(),
  mobileNumber: z.string().max(20).nullish(),
  isPrimary: z.boolean().nullish(),
});
export type CreateVendorContact = z.infer<typeof createVendorContact>;

export const createVendorRmMapping = z.object({
  vendorId: z.string().uuid().nullish(),
  materialId: z.string().uuid().nullish(),
  isPreferred: z.boolean().nullish(),
  leadTimeDays: z.number().int().nullish(),
});
export type CreateVendorRmMapping = z.infer<typeof createVendorRmMapping>;

/* ── stock requirement ────────────────────────────────────────────────── */

export const createStockRequirement = z.object({
  locationId: z.string().uuid().nullish(),
  materialId: z.string().uuid().nullish(),
  requiredQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
  requiredByDate: z.string().nullish(),
  requirementSource: z.string().max(255).nullish(),
  priority: z.string().max(255).nullish(),
});
export type CreateStockRequirement = z.infer<typeof createStockRequirement>;

export const createStockReqItem = z.object({
  stockRequirementId: z.string().uuid().nullish(),
  materialId: z.string().uuid().nullish(),
  requiredQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
});
export type CreateStockReqItem = z.infer<typeof createStockReqItem>;

/* ── purchase request ─────────────────────────────────────────────────── */

export const createPurchaseRequest = z.object({
  prNumber: z.string().max(50).nullish(),
  stockRequirementId: z.string().uuid().nullish(),
  requestLocationId: z.string().uuid().nullish(),
  deliveryLocationId: z.string().uuid().nullish(),
  priority: z.string().max(255).nullish(),
  expectedDeliveryDate: z.string().nullish(),
});
export type CreatePurchaseRequest = z.infer<typeof createPurchaseRequest>;

export const createPurchaseRequestItem = z.object({
  purchaseRequestId: z.string().uuid().nullish(),
  materialId: z.string().uuid().nullish(),
  requiredQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
});
export type CreatePurchaseRequestItem = z.infer<typeof createPurchaseRequestItem>;

export const createPurchaseRequestApproval = z.object({
  purchaseRequestId: z.string().uuid().nullish(),
  approverUserId: z.string().uuid().nullish(),
  approvalLevel: z.number().int().nullish(),
  approvalStatus: z.string().max(30).nullish(),
  remarks: z.string().nullish(),
});
export type CreatePurchaseRequestApproval = z.infer<typeof createPurchaseRequestApproval>;

/** POST /v1/purchase-requests/:id/submit — record the level-1 approval request. */
export const submitPurchaseRequest = z.object({
  approverUserId: z.string().uuid().nullish(),
  approvalLevel: z.number().int().nullish(),
  remarks: z.string().nullish(),
});
export type SubmitPurchaseRequest = z.infer<typeof submitPurchaseRequest>;

/** POST /v1/purchase-requests/:id/approve — close out the pending approval. */
export const approvePurchaseRequest = z.object({
  approverUserId: z.string().uuid().nullish(),
  remarks: z.string().nullish(),
});
export type ApprovePurchaseRequest = z.infer<typeof approvePurchaseRequest>;

/* ── rfq + quotations ─────────────────────────────────────────────────── */

export const createRfqMaster = z.object({
  rfqNumber: z.string().max(50).nullish(),
  purchaseRequestId: z.string().uuid().nullish(),
  rfqDate: z.string().nullish(),
  submissionDeadline: z.string().max(255).nullish(),
});
export type CreateRfqMaster = z.infer<typeof createRfqMaster>;

export const createRfqItem = z.object({
  rfqId: z.string().uuid().nullish(),
  materialId: z.string().uuid().nullish(),
  requiredQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
});
export type CreateRfqItem = z.infer<typeof createRfqItem>;

export const createRfqVendorMapping = z.object({
  rfqId: z.string().uuid().nullish(),
  vendorId: z.string().uuid().nullish(),
  isSelectedVendor: z.boolean().nullish(),
});
export type CreateRfqVendorMapping = z.infer<typeof createRfqVendorMapping>;

export const createQuotation = z.object({
  rfqId: z.string().uuid().nullish(),
  vendorId: z.string().uuid().nullish(),
  quotationNumber: z.string().max(50).nullish(),
  quotationDate: z.string().nullish(),
  validUntilDate: z.string().nullish(),
});
export type CreateQuotation = z.infer<typeof createQuotation>;

export const createQuotationItem = z.object({
  quotationId: z.string().uuid().nullish(),
  materialId: z.string().uuid().nullish(),
  quotedQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
  quotedRate: num.nullish(),
  currencyId: z.string().uuid().nullish(),
});
export type CreateQuotationItem = z.infer<typeof createQuotationItem>;

/* ── purchase order ───────────────────────────────────────────────────── */

/** A PO line supplied at PO creation; amount drives the computed total_amount. */
export const purchaseOrderItemInput = z.object({
  materialId: z.string().uuid().nullish(),
  orderedQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
  rate: num.nullish(),
  amount: num.nullish(),
});
export type PurchaseOrderItemInput = z.infer<typeof purchaseOrderItemInput>;

/** POST /v1/purchase-orders — header from a quotation + its lines (total computed). */
export const createPurchaseOrder = z.object({
  poNumber: z.string().max(50).nullish(),
  vendorId: z.string().uuid().nullish(),
  quotationId: z.string().uuid().nullish(),
  purchaseRequestId: z.string().uuid().nullish(),
  orderDate: z.string().nullish(),
  deliveryLocationId: z.string().uuid().nullish(),
  currencyId: z.string().uuid().nullish(),
  items: z.array(purchaseOrderItemInput).default([]),
});
export type CreatePurchaseOrder = z.infer<typeof createPurchaseOrder>;

export const createPurchaseOrderItem = z.object({
  purchaseOrderId: z.string().uuid().nullish(),
  materialId: z.string().uuid().nullish(),
  orderedQty: num.nullish(),
  uomId: z.string().uuid().nullish(),
  rate: num.nullish(),
  amount: num.nullish(),
});
export type CreatePurchaseOrderItem = z.infer<typeof createPurchaseOrderItem>;

export const createPoApprovalOrder = z.object({
  purchaseOrderId: z.string().uuid().nullish(),
  approverUserId: z.string().uuid().nullish(),
  approvalLevel: z.number().int().nullish(),
  approvalStatus: z.string().max(30).nullish(),
  remarks: z.string().nullish(),
});
export type CreatePoApprovalOrder = z.infer<typeof createPoApprovalOrder>;

export const createVendorPoAck = z.object({
  purchaseOrderId: z.string().uuid().nullish(),
  vendorId: z.string().uuid().nullish(),
  acceptedDeliveryDate: z.string().nullish(),
  remarks: z.string().nullish(),
});
export type CreateVendorPoAck = z.infer<typeof createVendorPoAck>;

/** POST /v1/purchase-orders/:id/approve — record the PO approval. */
export const approvePurchaseOrder = z.object({
  approverUserId: z.string().uuid().nullish(),
  approvalLevel: z.number().int().nullish(),
  remarks: z.string().nullish(),
});
export type ApprovePurchaseOrder = z.infer<typeof approvePurchaseOrder>;

/** POST /v1/purchase-orders/:id/acknowledge — vendor accepts the issued PO. */
export const acknowledgePurchaseOrder = z.object({
  acceptedDeliveryDate: z.string().nullish(),
  remarks: z.string().nullish(),
});
export type AcknowledgePurchaseOrder = z.infer<typeof acknowledgePurchaseOrder>;

/* ── vendor credit ────────────────────────────────────────────────────── */

export const createVendorCreditReason = z.object({
  reasonCode: z.string().max(50).nullish(),
  reasonDescription: z.string().nullish(),
});
export type CreateVendorCreditReason = z.infer<typeof createVendorCreditReason>;

export const createVendorCreditNote = z.object({
  vendorId: z.string().uuid().nullish(),
  grnId: z.string().uuid().nullish(),
  vendorCreditReasonId: z.string().uuid().nullish(),
  creditNoteNumber: z.string().max(50).nullish(),
  creditNoteDate: z.string().nullish(),
  amount: num.nullish(),
  currencyId: z.string().uuid().nullish(),
});
export type CreateVendorCreditNote = z.infer<typeof createVendorCreditNote>;

export const createVendorCreditNotesAllocation = z.object({
  vendorCreditNoteId: z.string().uuid().nullish(),
  purchaseOrderId: z.string().uuid().nullish(),
  allocatedAmount: num.nullish(),
});
export type CreateVendorCreditNotesAllocation = z.infer<
  typeof createVendorCreditNotesAllocation
>;
