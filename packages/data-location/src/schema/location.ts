/**
 * Site tables (Phase-1A Data Dictionary): LOCATION_TYPE_MASTER, LOCATION_MASTER.
 * organization_id/business_unit_id (→ iam), address_id/geo_location_id/primary_contact_id
 * (→ platform) are soft refs (no cross-schema FK). parent_location_id is a self soft ref.
 */
import { index, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { location } from "./_schema.js";

/** LOCATION_TYPE_MASTER */
export const locationTypeMaster = location.table(
  "location_type_master",
  {
    locationTypeId: dictPk("location_type_id"),
    typeCode: varchar("type_code", { length: 50 }),
    typeName: varchar("type_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("location_type_master_code_uq").on(t.typeCode)],
);

/** LOCATION_MASTER */
export const locationMaster = location.table(
  "location_master",
  {
    locationId: dictPk("location_id"),
    // soft refs → iam schema
    organizationId: uuid("organization_id"),
    businessUnitId: uuid("business_unit_id"),
    // self soft ref (no FK to avoid circularity)
    parentLocationId: uuid("parent_location_id"),
    locationTypeId: uuid("location_type_id").references(() => locationTypeMaster.locationTypeId),
    locationCode: varchar("location_code", { length: 50 }),
    locationName: varchar("location_name", { length: 200 }),
    // soft refs → platform schema
    addressId: uuid("address_id"),
    geoLocationId: uuid("geo_location_id"),
    primaryContactId: uuid("primary_contact_id"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("location_master_code_uq").on(t.locationCode),
    index("location_master_type_idx").on(t.locationTypeId),
    index("location_master_parent_idx").on(t.parentLocationId),
    index("location_master_org_idx").on(t.organizationId),
    index("location_master_business_unit_idx").on(t.businessUnitId),
  ],
);
