/**
 * Geo / locale reference masters (Phase-1A Data Dictionary): COUNTRY_MASTER,
 * CURRENCY_MASTER, LANGUAGE_MASTER, TIMEZONE_MASTER, ADDRESS_MASTER,
 * GEO_LOCATION_MASTER, CONTACT_MASTER. ADDRESS_MASTER.country_id is an in-schema FK
 * to COUNTRY_MASTER.
 */
import { index, numeric, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { platform } from "./_schema.js";

/** COUNTRY_MASTER */
export const countryMaster = platform.table(
  "country_master",
  {
    countryId: dictPk("country_id"),
    countryCode: varchar("country_code", { length: 50 }),
    countryName: varchar("country_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("country_master_code_uq").on(t.countryCode)],
);

/** CURRENCY_MASTER */
export const currencyMaster = platform.table(
  "currency_master",
  {
    currencyId: dictPk("currency_id"),
    currencyCode: varchar("currency_code", { length: 50 }),
    currencyName: varchar("currency_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("currency_master_code_uq").on(t.currencyCode)],
);

/** LANGUAGE_MASTER */
export const languageMaster = platform.table(
  "language_master",
  {
    languageId: dictPk("language_id"),
    languageCode: varchar("language_code", { length: 50 }),
    languageName: varchar("language_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("language_master_code_uq").on(t.languageCode)],
);

/** TIMEZONE_MASTER */
export const timezoneMaster = platform.table(
  "timezone_master",
  {
    timezoneId: dictPk("timezone_id"),
    timezoneCode: varchar("timezone_code", { length: 50 }),
    utcOffset: varchar("utc_offset", { length: 20 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("timezone_master_code_uq").on(t.timezoneCode)],
);

/** ADDRESS_MASTER — country_id is an in-schema FK to COUNTRY_MASTER. */
export const addressMaster = platform.table(
  "address_master",
  {
    addressId: dictPk("address_id"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: varchar("city", { length: 255 }),
    stateName: varchar("state_name", { length: 200 }),
    countryId: uuid("country_id").references(() => countryMaster.countryId),
    pincode: varchar("pincode", { length: 50 }),
    ...metaColumns(),
  },
  (t) => [index("address_master_country_idx").on(t.countryId)],
);

/** GEO_LOCATION_MASTER */
export const geoLocationMaster = platform.table("geo_location_master", {
  geoLocationId: dictPk("geo_location_id"),
  latitude: numeric("latitude", { precision: 10, scale: 8 }),
  longitude: numeric("longitude", { precision: 11, scale: 8 }),
  ...metaColumns(),
});

/** CONTACT_MASTER */
export const contactMaster = platform.table("contact_master", {
  contactId: dictPk("contact_id"),
  contactName: varchar("contact_name", { length: 200 }),
  email: varchar("email", { length: 150 }),
  mobileNumber: varchar("mobile_number", { length: 20 }),
  ...metaColumns(),
});
