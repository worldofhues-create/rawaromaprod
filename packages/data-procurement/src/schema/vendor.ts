/**
 * Vendor master + dependents (Phase-1A Data Dictionary, schema `procurement`):
 * VENDOR_DETAILS, VENDOR_CONTACT, VENDOR_RM_MAPPING. organization_id/address_id/
 * base_currency_id/material_id are id-only SOFT refs to other schemas (no cross-schema
 * FK). vendor_contact + vendor_rm_mapping are in-schema FKs to vendor_details.
 */
import { boolean, index, integer, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { procurement } from "./_schema.js";

/** VENDOR_DETAILS */
export const vendorDetails = procurement.table(
  "vendor_details",
  {
    vendorId: dictPk("vendor_id"),
    organizationId: uuid("organization_id"),
    vendorCode: varchar("vendor_code", { length: 50 }),
    vendorName: varchar("vendor_name", { length: 200 }),
    addressId: uuid("address_id"),
    baseCurrencyId: uuid("base_currency_id"),
    paymentTerms: varchar("payment_terms", { length: 255 }),
    gstin: text("gstin"),
    panNumber: text("pan_number"),
    bankName: text("bank_name"),
    bankAccountNumber: text("bank_account_number"),
    bankIfsc: text("bank_ifsc"),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("vendor_details_code_uq").on(t.vendorCode),
    index("vendor_details_org_idx").on(t.organizationId),
  ],
);

/** VENDOR_CONTACT — vendor_id is an in-schema FK to VENDOR_DETAILS. */
export const vendorContact = procurement.table(
  "vendor_contact",
  {
    vendorContactId: dictPk("vendor_contact_id"),
    vendorId: uuid("vendor_id").references(() => vendorDetails.vendorId),
    contactName: varchar("contact_name", { length: 200 }),
    designation: varchar("designation", { length: 255 }),
    email: varchar("email", { length: 150 }),
    mobileNumber: varchar("mobile_number", { length: 20 }),
    isPrimary: boolean("is_primary"),
    ...metaColumns(),
  },
  (t) => [index("vendor_contact_vendor_idx").on(t.vendorId)],
);

/** VENDOR_RM_MAPPING — vendor_id in-schema FK; material_id soft→masterdata.material. */
export const vendorRmMapping = procurement.table(
  "vendor_rm_mapping",
  {
    vendorRmMappingId: dictPk("vendor_rm_mapping_id"),
    vendorId: uuid("vendor_id").references(() => vendorDetails.vendorId),
    materialId: uuid("material_id"),
    isPreferred: boolean("is_preferred"),
    leadTimeDays: integer("lead_time_days"),
    ...metaColumns(),
  },
  (t) => [
    index("vendor_rm_mapping_vendor_idx").on(t.vendorId),
    index("vendor_rm_mapping_material_idx").on(t.materialId),
  ],
);
