/**
 * RFQ + quotations (Phase-1A Data Dictionary, schema `procurement`): RFQ_MASTER,
 * RFQ_ITEMS, RFQ_VENDOR_MAPPINGS, QUOTATIONS, QUOTATION_ITEMS. In-schema FKs:
 * rfq_items->rfq_master, rfq_vendor_mappings->rfq_master + ->vendor_details,
 * quotations->rfq_master + ->vendor_details, quotation_items->quotations.
 * material/uom/currency/purchase_request refs are id-only SOFT refs.
 */
import {
  boolean,
  date,
  index,
  numeric,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { procurement } from "./_schema.js";
import { vendorDetails } from "./vendor.js";

/** RFQ_MASTER — purchase_request_id is an id-only SOFT ref. */
export const rfqMaster = procurement.table(
  "rfq_master",
  {
    rfqId: dictPk("rfq_id"),
    rfqNumber: varchar("rfq_number", { length: 50 }),
    purchaseRequestId: uuid("purchase_request_id"),
    rfqDate: date("rfq_date"),
    submissionDeadline: varchar("submission_deadline", { length: 255 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("rfq_master_rfq_number_uq").on(t.rfqNumber)],
);

/** RFQ_ITEMS — rfq_id is an in-schema FK to RFQ_MASTER. */
export const rfqItems = procurement.table(
  "rfq_items",
  {
    rfqItemId: dictPk("rfq_item_id"),
    rfqId: uuid("rfq_id").references(() => rfqMaster.rfqId),
    materialId: uuid("material_id"),
    requiredQty: numeric("required_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    ...metaColumns(),
  },
  (t) => [index("rfq_items_rfq_idx").on(t.rfqId)],
);

/** RFQ_VENDOR_MAPPINGS — rfq_id + vendor_id are in-schema FKs. */
export const rfqVendorMappings = procurement.table(
  "rfq_vendor_mappings",
  {
    rfqVendorMappingId: dictPk("rfq_vendor_mapping_id"),
    rfqId: uuid("rfq_id").references(() => rfqMaster.rfqId),
    vendorId: uuid("vendor_id").references(() => vendorDetails.vendorId),
    isSelectedVendor: boolean("is_selected_vendor"),
    ...metaColumns(),
  },
  (t) => [
    index("rfq_vendor_mappings_rfq_idx").on(t.rfqId),
    index("rfq_vendor_mappings_vendor_idx").on(t.vendorId),
  ],
);

/** QUOTATIONS — rfq_id + vendor_id are in-schema FKs. */
export const quotations = procurement.table(
  "quotations",
  {
    quotationId: dictPk("quotation_id"),
    rfqId: uuid("rfq_id").references(() => rfqMaster.rfqId),
    vendorId: uuid("vendor_id").references(() => vendorDetails.vendorId),
    quotationNumber: varchar("quotation_number", { length: 50 }),
    quotationDate: date("quotation_date"),
    validUntilDate: date("valid_until_date"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("quotations_quotation_number_uq").on(t.quotationNumber),
    index("quotations_rfq_idx").on(t.rfqId),
    index("quotations_vendor_idx").on(t.vendorId),
  ],
);

/** QUOTATION_ITEMS — quotation_id in-schema FK; currency_id soft→platform.currency_master. */
export const quotationItems = procurement.table(
  "quotation_items",
  {
    quotationItemId: dictPk("quotation_item_id"),
    quotationId: uuid("quotation_id").references(() => quotations.quotationId),
    materialId: uuid("material_id"),
    quotedQty: numeric("quoted_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    quotedRate: numeric("quoted_rate", { precision: 18, scale: 4 }),
    currencyId: uuid("currency_id"),
    ...metaColumns(),
  },
  (t) => [index("quotation_items_quotation_idx").on(t.quotationId)],
);
