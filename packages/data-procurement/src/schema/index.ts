/**
 * procurement schema barrel — every table in the procurement cluster. drizzle.config.ts
 * points `schema` here.
 *
 * Tables (Phase-1A): vendor_details, vendor_contact, vendor_rm_mapping, stock_requirement,
 *   stock_req_items, purchase_request, purchase_request_items, purchase_request_approval,
 *   rfq_master, rfq_items, rfq_vendor_mappings, quotations, quotation_items, purchase_order,
 *   purchase_order_items, po_approval_order, vendor_po_ack, vendor_credit_reason_master,
 *   vendor_credit_note, vendor_credit_notes_allocation; + outbox, audit_events.
 */
export { procurement } from "./_schema.js";

export { vendorDetails, vendorContact, vendorRmMapping } from "./vendor.js";
export {
  stockRequirement,
  stockReqItems,
  purchaseRequest,
  purchaseRequestItems,
  purchaseRequestApproval,
} from "./requirement.js";
export {
  rfqMaster,
  rfqItems,
  rfqVendorMappings,
  quotations,
  quotationItems,
} from "./rfq.js";
export {
  purchaseOrder,
  purchaseOrderItems,
  poApprovalOrder,
  vendorPoAck,
} from "./po.js";
export {
  vendorCreditReasonMaster,
  vendorCreditNote,
  vendorCreditNotesAllocation,
} from "./credit.js";
export { outbox, auditEvents } from "./crosscutting.js";
