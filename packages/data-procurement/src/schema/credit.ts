/**
 * Vendor credit (Phase-1A Data Dictionary, schema `procurement`):
 * VENDOR_CREDIT_REASON_MASTER, VENDOR_CREDIT_NOTE, VENDOR_CREDIT_NOTES_ALLOCATION.
 * In-schema FKs: vendor_credit_note->vendor_details + ->vendor_credit_reason_master,
 * vendor_credit_notes_allocation->vendor_credit_note. grn_id (soft→inventory.grn_master),
 * purchase_order_id, currency_id are id-only SOFT refs.
 */
import { date, index, numeric, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { procurement } from "./_schema.js";
import { vendorDetails } from "./vendor.js";

/** VENDOR_CREDIT_REASON_MASTER */
export const vendorCreditReasonMaster = procurement.table(
  "vendor_credit_reason_master",
  {
    vendorCreditReasonId: dictPk("vendor_credit_reason_id"),
    reasonCode: varchar("reason_code", { length: 50 }),
    reasonDescription: text("reason_description"),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("vendor_credit_reason_master_code_uq").on(t.reasonCode)],
);

/** VENDOR_CREDIT_NOTE — vendor_id + vendor_credit_reason_id in-schema FKs; grn/currency soft. */
export const vendorCreditNote = procurement.table(
  "vendor_credit_note",
  {
    vendorCreditNoteId: dictPk("vendor_credit_note_id"),
    vendorId: uuid("vendor_id").references(() => vendorDetails.vendorId),
    grnId: uuid("grn_id"),
    vendorCreditReasonId: uuid("vendor_credit_reason_id").references(
      () => vendorCreditReasonMaster.vendorCreditReasonId,
    ),
    creditNoteNumber: varchar("credit_note_number", { length: 50 }),
    creditNoteDate: date("credit_note_date"),
    amount: numeric("amount", { precision: 18, scale: 4 }),
    currencyId: uuid("currency_id"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("vendor_credit_note_number_uq").on(t.creditNoteNumber),
    index("vendor_credit_note_vendor_idx").on(t.vendorId),
    index("vendor_credit_note_reason_idx").on(t.vendorCreditReasonId),
  ],
);

/** VENDOR_CREDIT_NOTES_ALLOCATION — vendor_credit_note_id in-schema FK; purchase_order_id soft. */
export const vendorCreditNotesAllocation = procurement.table(
  "vendor_credit_notes_allocation",
  {
    vendorCreditNotesAllocationId: dictPk("vendor_credit_notes_allocation_id"),
    vendorCreditNoteId: uuid("vendor_credit_note_id").references(
      () => vendorCreditNote.vendorCreditNoteId,
    ),
    purchaseOrderId: uuid("purchase_order_id"),
    allocatedAmount: numeric("allocated_amount", { precision: 18, scale: 4 }),
    ...metaColumns(),
  },
  (t) => [index("vendor_credit_notes_allocation_note_idx").on(t.vendorCreditNoteId)],
);
