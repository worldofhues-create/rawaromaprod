/**
 * Security tables (Phase-1A Data Dictionary): ROLE_MASTER, PERMISSION_MASTER,
 * ROLE_PERMISSION_MAPPING, USER_ROLE_MAPPING, LOCATION_AUTHORITY_MASTER. Mapping tables use
 * in-schema FKs; LocationID is a soft ref to the location schema.
 */
import { index, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { iam } from "./_schema.js";
import { userMaster } from "./users.js";

/** ROLE_MASTER */
export const roleMaster = iam.table(
  "role_master",
  {
    roleId: dictPk("role_id"),
    roleCode: varchar("role_code", { length: 50 }),
    roleName: varchar("role_name", { length: 200 }),
    description: text("description"),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("role_master_code_uq").on(t.roleCode)],
);

/** PERMISSION_MASTER */
export const permissionMaster = iam.table(
  "permission_master",
  {
    permissionId: dictPk("permission_id"),
    permissionCode: varchar("permission_code", { length: 50 }),
    permissionName: varchar("permission_name", { length: 200 }),
    moduleName: varchar("module_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("permission_master_code_uq").on(t.permissionCode)],
);

/** ROLE_PERMISSION_MAPPING */
export const rolePermissionMapping = iam.table(
  "role_permission_mapping",
  {
    rolePermissionMappingId: dictPk("role_permission_mapping_id"),
    roleId: uuid("role_id").references(() => roleMaster.roleId),
    permissionId: uuid("permission_id").references(() => permissionMaster.permissionId),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("role_permission_mapping_uq").on(t.roleId, t.permissionId),
    index("role_permission_mapping_role_idx").on(t.roleId),
  ],
);

/** USER_ROLE_MAPPING */
export const userRoleMapping = iam.table(
  "user_role_mapping",
  {
    userRoleMappingId: dictPk("user_role_mapping_id"),
    userId: uuid("user_id").references(() => userMaster.userId),
    roleId: uuid("role_id").references(() => roleMaster.roleId),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("user_role_mapping_uq").on(t.userId, t.roleId),
    index("user_role_mapping_user_idx").on(t.userId),
  ],
);

/** LOCATION_AUTHORITY_MASTER — who has authority at a location (OWNER/APPROVER/INSPECTOR). */
export const locationAuthorityMaster = iam.table(
  "location_authority_master",
  {
    locationAuthorityId: dictPk("location_authority_id"),
    locationId: uuid("location_id"), // soft ref → location schema
    authorityUserId: uuid("authority_user_id").references(() => userMaster.userId),
    authorityRoleId: uuid("authority_role_id").references(() => roleMaster.roleId),
    authorityType: varchar("authority_type", { length: 50 }),
    effectiveFromDt: timestamp("effective_from_dt", { withTimezone: true }),
    effectiveToDt: timestamp("effective_to_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [
    index("location_authority_master_location_idx").on(t.locationId),
    index("location_authority_master_user_idx").on(t.authorityUserId),
  ],
);
