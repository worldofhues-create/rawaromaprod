/**
 * Organization tables (Phase-1A Data Dictionary): ORG_GROUP_MASTER, ORG_TYPE_MASTER,
 * ORG_MASTER, ORG_RELATIONSHIP, BUSINESS_UNIT_MASTER. Country/currency/timezone/language
 * refs are soft refs to the platform schema (no cross-schema FK).
 */
import { index, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { iam } from "./_schema.js";

/** ORG_GROUP_MASTER */
export const orgGroupMaster = iam.table(
  "org_group_master",
  {
    orgGroupId: dictPk("org_group_id"),
    orgGroupCode: varchar("org_group_code", { length: 50 }),
    orgGroupName: varchar("org_group_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("org_group_master_code_uq").on(t.orgGroupCode)],
);

/** ORG_TYPE_MASTER */
export const orgTypeMaster = iam.table(
  "org_type_master",
  {
    orgTypeId: dictPk("org_type_id"),
    orgTypeCode: varchar("org_type_code", { length: 50 }),
    orgTypeName: varchar("org_type_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("org_type_master_code_uq").on(t.orgTypeCode)],
);

/** ORG_MASTER */
export const orgMaster = iam.table(
  "org_master",
  {
    organizationId: dictPk("organization_id"),
    orgGroupId: uuid("org_group_id").references(() => orgGroupMaster.orgGroupId),
    orgTypeId: uuid("org_type_id").references(() => orgTypeMaster.orgTypeId),
    organizationCode: varchar("organization_code", { length: 50 }),
    organizationName: varchar("organization_name", { length: 200 }),
    // soft refs → platform schema
    registrationCountryId: uuid("registration_country_id"),
    baseCurrencyId: uuid("base_currency_id"),
    defaultTimezoneId: uuid("default_timezone_id"),
    defaultLanguageId: uuid("default_language_id"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("org_master_code_uq").on(t.organizationCode),
    index("org_master_group_idx").on(t.orgGroupId),
  ],
);

/** ORG_RELATIONSHIP */
export const orgRelationship = iam.table(
  "org_relationship",
  {
    orgRelationshipId: dictPk("org_relationship_id"),
    organizationId: uuid("organization_id").references(() => orgMaster.organizationId),
    relatedOrganizationId: uuid("related_organization_id").references(
      () => orgMaster.organizationId,
    ),
    relationshipType: varchar("relationship_type", { length: 30 }),
    ...metaColumns(),
  },
  (t) => [index("org_relationship_org_idx").on(t.organizationId)],
);

/** BUSINESS_UNIT_MASTER */
export const businessUnitMaster = iam.table(
  "business_unit_master",
  {
    businessUnitId: dictPk("business_unit_id"),
    organizationId: uuid("organization_id").references(() => orgMaster.organizationId),
    parentBusinessUnitId: uuid("parent_business_unit_id"),
    businessUnitCode: varchar("business_unit_code", { length: 50 }),
    businessUnitName: varchar("business_unit_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [
    index("business_unit_master_org_idx").on(t.organizationId),
    index("business_unit_master_parent_idx").on(t.parentBusinessUnitId),
  ],
);
