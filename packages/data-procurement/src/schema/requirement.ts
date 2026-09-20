/**
 * Stock requirement + purchase request (Phase-1A Data Dictionary, schema `procurement`):
 * STOCK_REQUIREMENT, STOCK_REQ_ITEMS, PURCHASE_REQUEST, PURCHASE_REQUEST_ITEMS,
 * PURCHASE_REQUEST_APPROVAL. location/material/uom/approver refs are id-only SOFT refs.
 * Header->line FKs are in-schema (stock_req_items->stock_requirement, *_items/approval->
 * purchase_request).
 */
import {
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

/** STOCK_REQUIREMENT */
export const stockRequirement = procurement.table(
  "stock_requirement",
  {
    stockRequirementId: dictPk("stock_requirement_id"),
    locationId: uuid("location_id"),
    materialId: uuid("material_id"),
    requiredQty: numeric("required_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    requiredByDate: date("required_by_date"),
    requirementSource: varchar("requirement_source", { length: 255 }),
    priority: varchar("priority", { length: 255 }),
    ...metaColumns(),
  },
  (t) => [
    index("stock_requirement_location_idx").on(t.locationId),
    index("stock_requirement_material_idx").on(t.materialId),
  ],
);

/** STOCK_REQ_ITEMS — stock_requirement_id is an in-schema FK to STOCK_REQUIREMENT. */
export const stockReqItems = procurement.table(
  "stock_req_items",
  {
    stockReqItemId: dictPk("stock_req_item_id"),
    stockRequirementId: uuid("stock_requirement_id").references(
      () => stockRequirement.stockRequirementId,
    ),
    materialId: uuid("material_id"),
    requiredQty: numeric("required_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    ...metaColumns(),
  },
  (t) => [index("stock_req_items_req_idx").on(t.stockRequirementId)],
);

/** PURCHASE_REQUEST — stock_requirement_id/locations/approved_by are id-only SOFT refs. */
export const purchaseRequest = procurement.table(
  "purchase_request",
  {
    purchaseRequestId: dictPk("purchase_request_id"),
    prNumber: varchar("pr_number", { length: 50 }),
    stockRequirementId: uuid("stock_requirement_id"),
    requestLocationId: uuid("request_location_id"),
    deliveryLocationId: uuid("delivery_location_id"),
    priority: varchar("priority", { length: 255 }),
    expectedDeliveryDate: date("expected_delivery_date"),
    approvedBy: uuid("approved_by"),
    approvedDt: timestamp("approved_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("purchase_request_pr_number_uq").on(t.prNumber)],
);

/** PURCHASE_REQUEST_ITEMS — purchase_request_id is an in-schema FK to PURCHASE_REQUEST. */
export const purchaseRequestItems = procurement.table(
  "purchase_request_items",
  {
    purchaseRequestItemId: dictPk("purchase_request_item_id"),
    purchaseRequestId: uuid("purchase_request_id").references(
      () => purchaseRequest.purchaseRequestId,
    ),
    materialId: uuid("material_id"),
    requiredQty: numeric("required_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    ...metaColumns(),
  },
  (t) => [index("purchase_request_items_pr_idx").on(t.purchaseRequestId)],
);

/** PURCHASE_REQUEST_APPROVAL — purchase_request_id in-schema FK; approver_user_id soft. */
export const purchaseRequestApproval = procurement.table(
  "purchase_request_approval",
  {
    purchaseRequestApprovalId: dictPk("purchase_request_approval_id"),
    purchaseRequestId: uuid("purchase_request_id").references(
      () => purchaseRequest.purchaseRequestId,
    ),
    approverUserId: uuid("approver_user_id"),
    approvalLevel: integer("approval_level"),
    approvalStatus: varchar("approval_status", { length: 30 }),
    approvedDt: timestamp("approved_dt", { withTimezone: true }),
    remarks: text("remarks"),
    ...metaColumns(),
  },
  (t) => [index("purchase_request_approval_pr_idx").on(t.purchaseRequestId)],
);
