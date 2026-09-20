/**
 * iam organization tables (doc 10 §3 — the V3.1 org addition).
 *
 * organizations(type=builder|partner|internal) with org_units (branch/department/
 * team tree) and org_members. Partners (P2) = type=partner + a partners row.
 * Builder CMS multi-user, internal departments, and the partner ecosystem all reuse
 * this one shape. `org_members.user_id` is an id-only soft ref to users (mirrors the
 * cross-cluster convention even though same schema); org_unit FK is in-schema.
 */
import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { baseColumns } from "@core/data-kernel";
import { iam } from "./_schema.js";

/**
 * organizations — builder|partner|internal. rera_no/gstin nullable.
 */
export const organizations = iam.table(
  "organizations",
  {
    ...baseColumns(),
    type: text("type").notNull(),
    name: text("name").notNull(),
    reraNo: text("rera_no"),
    gstin: text("gstin"),
    status: text("status").notNull().default("active"),
  },
  (t) => [
    index("organizations_type_idx").on(t.type),
    index("organizations_status_idx").on(t.status),
    index("organizations_name_trgm_idx").using("gin", sql`${t.name} gin_trgm_ops`),
  ],
);

/**
 * org_units — self-referencing tree (branch|department|team) within an org.
 * org_id + parent_id (self) FKs are in-schema.
 */
export const orgUnits = iam.table(
  "org_units",
  {
    ...baseColumns(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    type: text("type").notNull(),
    name: text("name").notNull(),
  },
  (t) => [
    index("org_units_org_idx").on(t.orgId),
    index("org_units_parent_idx").on(t.parentId),
  ],
);

/**
 * org_members — membership of a user in an org (and optionally an org_unit).
 * user_id is id-only soft ref; org_id + org_unit_id FKs are in-schema. `role`
 * owner|admin|member is the membership-level role (distinct from RBAC roles).
 */
export const orgMembers = iam.table(
  "org_members",
  {
    ...baseColumns(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    orgUnitId: uuid("org_unit_id").references(() => orgUnits.id, {
      onDelete: "set null",
    }),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("active"),
  },
  (t) => [
    index("org_members_org_idx").on(t.orgId),
    index("org_members_user_idx").on(t.userId),
    index("org_members_unit_idx").on(t.orgUnitId),
    // A user appears once per org.
    uniqueIndex("org_members_org_user_uq").on(t.orgId, t.userId),
  ],
);

/**
 * partners — extends an organization (type=partner). category bank|legal|inspection|
 * service; `terms` jsonb. org_id FK in-schema; one partner row per org.
 */
export const partners = iam.table(
  "partners",
  {
    ...baseColumns(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    terms: jsonb("terms"),
  },
  (t) => [
    uniqueIndex("partners_org_uq").on(t.orgId),
    index("partners_category_idx").on(t.category),
  ],
);
