/**
 * Customer + transporter masters (Phase-1A Data Dictionary): CUSTOMER_MASTER,
 * TRANSPORTER_MASTER. address/currency/contact refs are soft refs to the platform
 * schema (no cross-schema FK).
 */
import { uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { sales } from "./_schema.js";

/** CUSTOMER_MASTER */
export const customerMaster = sales.table(
  "customer_master",
  {
    customerId: dictPk("customer_id"),
    customerCode: varchar("customer_code", { length: 50 }),
    customerName: varchar("customer_name", { length: 200 }),
    // soft refs → platform schema
    addressId: uuid("address_id"),
    baseCurrencyId: uuid("base_currency_id"),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("customer_master_code_uq").on(t.customerCode)],
);

/** TRANSPORTER_MASTER */
export const transporterMaster = sales.table(
  "transporter_master",
  {
    transporterId: dictPk("transporter_id"),
    transporterCode: varchar("transporter_code", { length: 50 }),
    transporterName: varchar("transporter_name", { length: 200 }),
    // soft refs → platform schema
    contactId: uuid("contact_id"),
    addressId: uuid("address_id"),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("transporter_master_code_uq").on(t.transporterCode)],
);
