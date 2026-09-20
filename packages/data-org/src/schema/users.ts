/**
 * USER_MASTER (Phase-1A Data Dictionary). Auth backend for the platform — PasswordHash is
 * Argon2id (set by the auth service). OrganizationID is an in-schema FK to org_master.
 */
import { boolean, index, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { iam } from "./_schema.js";
import { orgMaster } from "./org.js";

export const userMaster = iam.table(
  "user_master",
  {
    userId: dictPk("user_id"),
    organizationId: uuid("organization_id").references(() => orgMaster.organizationId),
    employeeCode: varchar("employee_code", { length: 50 }),
    userName: varchar("user_name", { length: 200 }),
    email: varchar("email", { length: 150 }),
    mobileNumber: varchar("mobile_number", { length: 20 }),
    passwordHash: varchar("password_hash", { length: 255 }),
    isActive: boolean("is_active"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("user_master_email_uq").on(t.email),
    index("user_master_org_idx").on(t.organizationId),
  ],
);
