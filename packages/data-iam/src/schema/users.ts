/**
 * iam.users + auth-material tables (doc 10 §3).
 *
 * `users` is the SINGLE source of identity — no per-portal user tables. Roles + org
 * membership decide portal access; the JWT carries role + portal-audience.
 * `credentials` is split out so password material is isolated (encrypt-at-rest
 * candidate column). FKs here are WITHIN the iam schema only.
 */
import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { baseColumns, softDelete } from "@core/data-kernel";
import { iam } from "./_schema.js";

/**
 * users — the single source of identity.
 * `status`: active|suspended|pending (text + zod app-side, not a PG enum — may grow).
 * mobile/email are unique among NON-deleted rows (partial unique index).
 */
export const users = iam.table(
  "users",
  {
    ...baseColumns(),
    mobile: text("mobile"),
    email: text("email"),
    status: text("status").notNull().default("pending"),
    fullName: text("full_name"),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex("users_mobile_active_uq")
      .on(t.mobile)
      .where(sql`${t.deletedAt} IS NULL AND ${t.mobile} IS NOT NULL`),
    uniqueIndex("users_email_active_uq")
      .on(t.email)
      .where(sql`${t.deletedAt} IS NULL AND ${t.email} IS NOT NULL`),
    index("users_status_idx").on(t.status),
    index("users_deleted_at_idx").on(t.deletedAt).where(sql`${t.deletedAt} IS NULL`),
    // GIN trigram on full_name for search/suggest (requires pg_trgm; enabled in migration).
    index("users_full_name_trgm_idx").using("gin", sql`${t.fullName} gin_trgm_ops`),
  ],
);

/**
 * credentials — 1:1 with users; PK IS user_id (no separate id). Password material
 * isolated. `password_history` keeps last-N hashes for reuse prevention.
 * `user_id` is the PK and an in-schema FK to users.id.
 */
export const credentials = iam.table("credentials", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  passwordHistory: jsonb("password_history").notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * otps — code stored HASHED, attempts capped, short TTL. `user_id` is null until the
 * OTP is linked to a user (registration flow can create the row pre-user). Kept
 * id-only to user (no FK) because rows may outlive/predate a user and we hard-delete
 * expired ones aggressively.
 */
export const otps = iam.table(
  "otps",
  {
    ...baseColumns(),
    userId: uuid("user_id"),
    target: text("target").notNull(),
    channel: text("channel").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: smallint("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("otps_target_idx").on(t.target),
    index("otps_user_idx").on(t.userId),
    index("otps_expires_idx").on(t.expiresAt),
  ],
);

/**
 * devices — known devices per user (fingerprint, platform, last seen). FK to users.
 */
export const devices = iam.table(
  "devices",
  {
    ...baseColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint"),
    platform: text("platform"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [
    index("devices_user_idx").on(t.userId),
    index("devices_fingerprint_idx").on(t.fingerprint),
  ],
);

/**
 * sessions — refresh-token sessions, bound to a user + device + portal audience.
 * `refresh_token_hash` stored hashed. `revoked_at` for logout/kill.
 * FKs to users and devices (in-schema).
 */
export const sessions = iam.table(
  "sessions",
  {
    ...baseColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").references(() => devices.id, {
      onDelete: "set null",
    }),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    portalAudience: text("portal_audience"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("sessions_user_idx").on(t.userId),
    index("sessions_device_idx").on(t.deviceId),
    index("sessions_expires_idx").on(t.expiresAt),
    // Active sessions per user: hot lookup, partial on not-yet-revoked.
    index("sessions_active_idx")
      .on(t.userId, t.expiresAt)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);
