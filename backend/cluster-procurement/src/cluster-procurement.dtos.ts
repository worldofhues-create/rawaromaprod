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
// A real date (yyyy-mm-dd or full ISO) — rejects free text like "uhyg" server-side.
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}([T ].*)?$/, 'Expected a date (yyyy-mm-dd)');
// A sane quantity 0..1e9 — rejects the absurd 65,493,487,347,935 kind of junk server-side.
const qty = z
  .union([z.number(), z.string()])
  .refine((v) => { const n = Number(v); return !isNaN(n) && n >= 0 && n <= 1_000_000_000; }, 'Quantity out of range (0–1,000,000,000)');

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
  contactType: z.string().nullish(),
});
export type CreateVendorContact = z.infer<typeof createVendorContact>;

export const createVendorRmMapping = z.object({
  vendorId: z.string().uuid().nullish(),
  materialId: z.string().uuid().nullish(),
  isPreferred: z.preprocess((v) => (v === '' || v == null ? undefined : v === true || v === 'true' || v === 'on' || v === 1), z.boolean().nullish()),
  leadTimeDays: z.coerce.number().int().nullish(),
  minOrderQty: num.nullish(),
});
export type CreateVendorRmMapping = z.infer<typeof createVendorRmMapping>;

/* ── stock requirement ────────────────────────────────────────────────── */

export const createStockRequirement = z.object({
  locationId: z.string().uuid().nullish(),
  materialId: z.string().uuid(),
  requiredQty: qty,
  uomId: z.string().uuid().nullish(),
  requiredByDate: dateStr, // required + must be a real date (server-side enforcement)
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
  purchaseRequestId: z.string().uuid(), // an RFQ must come from a PR (mapping enforced)
  rfqDate: dateStr, // required + real date
  submissionDeadline: dateStr.nullish(), // optional, but a real date if given (rejects "uhyg")
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

/** POST /v1/quotations/:id/select — the formal "select winning quotation" step (RP-PROC-006
 * follow-up): marks one quotation the RFQ's awarded winner. See rfq.service.ts selectQuotation.
 * `overrideReason` (§87 RFQ-award separation-of-duties): required ONLY when the caller is the
 * RFQ's own creator, separation is enforced for the organisation, and the caller also holds the
 * award-override permission — see rfq.service.ts selectQuotation for the full rule. */
export const selectQuotation = z.object({
  remarks: z.string().nullish(),
  overrideReason: z.string().min(1).nullish(),
});
export type SelectQuotation = z.infer<typeof selectQuotation>;

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

/**
 * POST /v1/purchase-orders/:id/approve — record the PO approval. Deliberately carries NO
 * approverUserId: the approver's identity is ALWAYS the authenticated principal (security
 * review R1 #1) — a client-supplied approverUserId let one user register the first approval
 * under a spoofed id then approve again as themselves, satisfying the two-distinct-approver
 * segregation-of-duties rule alone. approvalLevel is likewise server-computed, never client
 * input.
 */
export const approvePurchaseOrder = z.object({
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
