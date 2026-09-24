/**
 * Purchase order (Phase-1A Data Dictionary, schema `procurement`): PURCHASE_ORDER,
 * PURCHASE_ORDER_ITEMS, PO_APPROVAL_ORDER, VENDOR_PO_ACK. In-schema FKs:
 * purchase_order->vendor_details, purchase_order->purchase_order (replacement_of_po_id,
 * self-ref — the "Generate replacement PO" flow, FAIL-03/04), purchase_order_items->
 * purchase_order, po_approval_order->purchase_order, vendor_po_ack->vendor_details.
 * quotation/purchase_request/location/currency/approver refs are id-only SOFT refs.
 */
import {
  type AnyPgColumn,
  date,
  index,
  integer,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { procurement } from "./_schema.js";
import { vendorDetails } from "./vendor.js";

/** PURCHASE_ORDER — vendor_id in-schema FK; quotation/pr/location/currency soft refs. */
export const purchaseOrder = procurement.table(
  "purchase_order",
  {
    purchaseOrderId: dictPk("purchase_order_id"),
    poNumber: varchar("po_number", { length: 50 }),
    vendorId: uuid("vendor_id").references(() => vendorDetails.vendorId),
    quotationId: uuid("quotation_id"),
    purchaseRequestId: uuid("purchase_request_id"),
    orderDate: date("order_date"),
    deliveryLocationId: uuid("delivery_location_id"),
    currencyId: uuid("currency_id"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 4 }),
    /**
     * Self-ref → the original PO this one replaces (FAIL-03/04 "Generate replacement PO" off a
     * rejected/short/damaged GRN — po.service.ts#createReplacementPo,
     * procanalytics.service.ts#createReplacementPo). Null for an ordinary PO. In-schema FK to
     * this same table; nullable so it never blocks inserting an ordinary (non-replacement) PO.
     */
    replacementOfPoId: uuid("replacement_of_po_id").references(
      (): AnyPgColumn => purchaseOrder.purchaseOrderId,
    ),
    /** G2/V4 §113 — set when `status = 'CANCELLED'` via PoService.cancelPurchaseOrder. Null
     * otherwise. Kept on the row (in addition to the `procurement.po.cancelled` outbox event)
     * so the reason is visible directly on the document, not only in the event log. */
    cancellationReason: text("cancellation_reason"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("purchase_order_po_number_uq").on(t.poNumber),
    index("purchase_order_vendor_idx").on(t.vendorId),
    index("purchase_order_replacement_of_po_idx").on(t.replacementOfPoId),
  ],
);

/** PURCHASE_ORDER_ITEMS — purchase_order_id is an in-schema FK to PURCHASE_ORDER. */
export const purchaseOrderItems = procurement.table(
  "purchase_order_items",
  {
    purchaseOrderItemId: dictPk("purchase_order_item_id"),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrder.purchaseOrderId),
    materialId: uuid("material_id"),
    orderedQty: numeric("ordered_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    rate: numeric("rate", { precision: 18, scale: 4 }),
    amount: numeric("amount", { precision: 18, scale: 4 }),
    ...metaColumns(),
  },
  (t) => [index("purchase_order_items_po_idx").on(t.purchaseOrderId)],
);

/** PO_APPROVAL_ORDER — purchase_order_id in-schema FK; approver_user_id soft. */
export const poApprovalOrder = procurement.table(
  "po_approval_order",
  {
    poApprovalOrderId: dictPk("po_approval_order_id"),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrder.purchaseOrderId),
    approverUserId: uuid("approver_user_id"),
    approvalLevel: integer("approval_level"),
    approvalStatus: varchar("approval_status", { length: 30 }),
    approvedDt: timestamp("approved_dt", { withTimezone: true }),
    remarks: text("remarks"),
    ...metaColumns(),
  },
  (t) => [index("po_approval_order_po_idx").on(t.purchaseOrderId)],
);

/** VENDOR_PO_ACK — vendor_id in-schema FK; purchase_order_id soft→purchase_order. */
export const vendorPoAck = procurement.table(
  "vendor_po_ack",
  {
    vendorPoAckId: dictPk("vendor_po_ack_id"),
    purchaseOrderId: uuid("purchase_order_id"),
    vendorId: uuid("vendor_id").references(() => vendorDetails.vendorId),
    acknowledgedDt: timestamp("acknowledged_dt", { withTimezone: true }),
    acceptedDeliveryDate: date("accepted_delivery_date"),
    remarks: text("remarks"),
    ...metaColumns(),
  },
  (t) => [
    index("vendor_po_ack_po_idx").on(t.purchaseOrderId),
    index("vendor_po_ack_vendor_idx").on(t.vendorId),
  ],
);
