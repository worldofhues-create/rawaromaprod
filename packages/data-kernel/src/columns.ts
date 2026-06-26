/**
 * Reusable column-set helpers — the heart of the standard (doc 10 §1).
 *
 * These return PLAIN OBJECTS of Drizzle column builders, spread into a
 * `pgSchema(...).table(...)` definition. They are domain-free: no IAM/platform
 * knowledge leaks in here, so the whole file lifts verbatim into any project.
 *
 *   const users = iam.table("users", {
 *     ...baseColumns(),
 *     ...softDelete(),
 *     mobile: text("mobile"),
 *   });
 */
import { sql } from "drizzle-orm";
import { bigint, char, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Base columns present on EVERY table (doc 10 §1 "Base columns").
 *
 * - `id`         UUIDv7 PK, defaulted by the DB `uuidv7()` function (see uuid.ts).
 * - `created_at` set by DB default.
 * - `updated_at` set by DB default; bump in the repository/`onUpdate` on write.
 * - `created_by` / `updated_by` actor ids — **soft refs to iam.users**, so they
 *   are NEVER `.references()` (no cross-schema FK; even within iam we keep them
 *   id-only to stay uniform). Nullable: system/seed writes have no actor.
 */
export function baseColumns() {
  return {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    createdBy: uuid("created_by"),
    updatedBy: uuid("updated_by"),
  };
}

/**
 * Soft-delete marker (doc 10 §1).
 *
 * Only add to entities that need recovery/audit (users, listings, documents,
 * offers); everything else hard-deletes. Pair with a PARTIAL index
 * `WHERE deleted_at IS NULL` on the table's hot lookup columns — see
 * `partialActiveIndex` guidance below.
 */
export function softDelete() {
  return {
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  };
}

/**
 * Money: bigint MINOR units (paise) + ISO-4217 currency. NEVER float (doc 10 §1).
 *
 * `money("price")` → { price: bigint, price_currency: char(3) }.
 * bigint is returned as JS `number` mode `"bigint"` to avoid precision loss.
 * Default currency INR; override per-row where multi-currency is in play.
 */
export function money<N extends string>(name: N) {
  const amount = bigint(name, { mode: "bigint" });
  const ccy = char(`${name}_currency`, { length: 3 }).notNull().default("INR");
  return { [name]: amount, [`${name}Currency`]: ccy } as Record<N, typeof amount> &
    Record<`${N}Currency`, typeof ccy>;
}

/** Standalone currency column helper (when amount lives elsewhere / is implicit). */
export function currency(name = "currency") {
  return char(name, { length: 3 }).notNull().default("INR");
}

/**
 * Guidance for the partial active-rows index (doc 10 §1 indexing rules).
 *
 * Drizzle can't express a partial index inside the column helper, so declare it
 * in the table's index callback, e.g.:
 *
 *   (t) => ({
 *     activeMobile: uniqueIndex("users_mobile_active_uq")
 *       .on(t.mobile)
 *       .where(sql`${t.deletedAt} IS NULL`),
 *   })
 *
 * Exported as a string constant purely as a copy-paste reminder in schema files.
 */
export const PARTIAL_ACTIVE_WHERE = "WHERE deleted_at IS NULL";

/**
 * Dictionary-style PK (the RAW AROMACHEM Phase-1A Data Dictionary convention):
 * `<entity>_id UUID NOT NULL DEFAULT uuidv7()`. Pass the snake_case column name.
 *
 *   const addressMaster = platform.table("address_master", {
 *     addressId: dictPk("address_id"),
 *     ...metaColumns(),
 *   });
 */
export function dictPk(name: string) {
  return uuid(name)
    .primaryKey()
    .default(sql`uuidv7()`);
}

/**
 * Dictionary base columns present on EVERY Phase-1A table (the Data Dictionary tail):
 * `Status VARCHAR(30)`, `CreatedDT`, `UpdatedDT`, `CreatedBy VARCHAR(255)`,
 * `UpdatedBy VARCHAR(255)`. Lifecycle is `status` (no soft-delete column). `created_by`/
 * `updated_by` are username strings per the dictionary (not uuid). Spread after the PK.
 */
export function metaColumns() {
  return {
    status: varchar("status", { length: 30 }),
    createdDt: timestamp("created_dt", { withTimezone: true }).notNull().defaultNow(),
    updatedDt: timestamp("updated_dt", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    createdBy: varchar("created_by", { length: 255 }),
    updatedBy: varchar("updated_by", { length: 255 }),
  };
}
