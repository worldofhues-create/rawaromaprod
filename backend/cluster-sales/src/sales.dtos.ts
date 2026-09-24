/**
 * sales cluster DTOs — zod create bodies (one per sales table) + the order/dispatch flow
 * bodies + the generic cursor list query. Bodies carry only the Data Dictionary columns; the
 * service fills the meta tail (status, created_by / updated_by from the principal). Numerics
 * arrive as numbers and are stringified at insert; dates as plain strings; cross-schema /
 * dict-soft refs are plain uuids.
 */
import { z } from 'zod';

/** Generic cursor list query shared by every table. */
export const listQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListQuery = z.infer<typeof listQuery>;

/* ── customer master ──────────────────────────────────────────────────── */

export const createCustomer = z.object({
  customerCode: z.string(),
  customerName: z.string(),
  addressId: z.string().uuid().optional(),
  baseCurrencyId: z.string().uuid().optional(),
});
export type CreateCustomer = z.infer<typeof createCustomer>;

/* ── transporter master ───────────────────────────────────────────────── */

export const createTransporter = z.object({
  transporterCode: z.string(),
  transporterName: z.string(),
  contactId: z.string().uuid().optional(),
  addressId: z.string().uuid().optional(),
});
export type CreateTransporter = z.infer<typeof createTransporter>;

/* ── sales order + items ──────────────────────────────────────────────── */

/** One line on a sales order create body. */
export const salesOrderItemInput = z.object({
  productSkuId: z.string().uuid().optional(),
  orderedQty: z.number().optional(),
  uomId: z.string().uuid().optional(),
  rate: z.number().optional(),
  amount: z.number().optional(),
});
export type SalesOrderItemInput = z.infer<typeof salesOrderItemInput>;

/**
 * G1/PB-08 (FINAL_OS §2.3/§41): RawProd must not be an independent commercial-order writer.
 * createSalesOrder/confirmSalesOrder/createSalesOrderItem are now a break-glass continuity
 * path (`sales:manual_continuity:write`, owner/admin only) — every call requires a non-empty
 * `reason`, which is audited (stamped on the row + emitted toward ALEMBIC via the bridge
 * outbox) rather than accepted and discarded.
 */
export const manualContinuityReason = z.object({ reason: z.string().trim().min(1) });
export type ManualContinuityReason = z.infer<typeof manualContinuityReason>;

/** Flow body for POST /v1/sales-orders — header + lines, in one transaction. */
export const createSalesOrder = z.object({
  soNumber: z.string().nullish(),
  customerId: z.string().uuid(),
  orderDate: z.string().optional(),
  deliveryLocationId: z.string().uuid().optional(),
  currencyId: z.string().uuid().optional(),
  items: z.array(salesOrderItemInput).min(1),
  reason: z.string().trim().min(1),
});
export type CreateSalesOrder = z.infer<typeof createSalesOrder>;

/** Standalone item create (CRUD), distinct from the create-with-items flow. */
export const createSalesOrderItem = z.object({
  salesOrderId: z.string().uuid(),
  productSkuId: z.string().uuid().optional(),
  orderedQty: z.number().optional(),
  uomId: z.string().uuid().optional(),
  rate: z.number().optional(),
  amount: z.number().optional(),
  reason: z.string().trim().min(1),
});
export type CreateSalesOrderItem = z.infer<typeof createSalesOrderItem>;

/* ── dispatch master + items ──────────────────────────────────────────── */

/** One line on a dispatch create body. */
export const dispatchItemInput = z.object({
  salesOrderItemId: z.string().uuid().optional(),
  finishedGoodBatchId: z.string().uuid().optional(),
  dispatchedQty: z.number().optional(),
  uomId: z.string().uuid().optional(),
});
export type DispatchItemInput = z.infer<typeof dispatchItemInput>;

/** Flow body for POST /v1/dispatches — header + lines, in one transaction. */
export const createDispatch = z.object({
  salesOrderId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  dispatchDate: z.string().optional(),
  vehicleNumber: z.string().optional(),
  transporterId: z.string().uuid().optional(),
  items: z.array(dispatchItemInput).min(1),
});
export type CreateDispatch = z.infer<typeof createDispatch>;

/** Standalone dispatch item create (CRUD), distinct from the create-with-items flow. */
export const createDispatchItem = z.object({
  dispatchId: z.string().uuid(),
  salesOrderItemId: z.string().uuid().optional(),
  finishedGoodBatchId: z.string().uuid().optional(),
  dispatchedQty: z.number().optional(),
  uomId: z.string().uuid().optional(),
});
export type CreateDispatchItem = z.infer<typeof createDispatchItem>;
