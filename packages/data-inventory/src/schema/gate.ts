/**
 * Gate-entry tables (Phase-1A Data Dictionary, schema `inventory`): GATE_ENTRY_MASTER,
 * GATE_ENTRY_DOCUMENTS. In-schema FK: gate_entry_documents → gate_entry_master. All other
 * refs (vendor/po/location/document_type/document) are cross-schema SOFT refs (plain uuid).
 */
import { index, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { inventory } from "./_schema.js";

/** GATE_ENTRY_MASTER */
export const gateEntryMaster = inventory.table(
  "gate_entry_master",
  {
    gateEntryId: dictPk("gate_entry_id"),
    gateEntryNumber: varchar("gate_entry_number", { length: 50 }),
    vendorId: uuid("vendor_id"),
    purchaseOrderId: uuid("purchase_order_id"),
    locationId: uuid("location_id"),
    vehicleNumber: varchar("vehicle_number", { length: 20 }),
    entryDt: timestamp("entry_dt", { withTimezone: true }),
    exitDt: timestamp("exit_dt", { withTimezone: true }),
    driverName: varchar("driver_name", { length: 200 }),
    invoiceNumber: text("invoice_number"),
    challanNumber: text("challan_number"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("gate_entry_master_number_uq").on(t.gateEntryNumber),
    index("gate_entry_master_vendor_idx").on(t.vendorId),
    index("gate_entry_master_po_idx").on(t.purchaseOrderId),
    index("gate_entry_master_location_idx").on(t.locationId),
  ],
);

/** GATE_ENTRY_DOCUMENTS — gate_entry_id is an in-schema FK. */
export const gateEntryDocuments = inventory.table(
  "gate_entry_documents",
  {
    gateEntryDocumentId: dictPk("gate_entry_document_id"),
    gateEntryId: uuid("gate_entry_id").references(() => gateEntryMaster.gateEntryId),
    documentTypeId: uuid("document_type_id"),
    documentId: uuid("document_id"),
    ...metaColumns(),
  },
  (t) => [
    index("gate_entry_documents_gate_entry_idx").on(t.gateEntryId),
    index("gate_entry_documents_document_type_idx").on(t.documentTypeId),
    index("gate_entry_documents_document_idx").on(t.documentId),
  ],
);
