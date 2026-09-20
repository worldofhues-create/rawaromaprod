/**
 * platform themes / content / config (doc 10 §4).
 *
 * themes — runtime token overrides per portal over the @core/tokens base (retune a
 *   portal's look without a deploy). `portal` is a TEXT PK (per ERD §4).
 * content_blocks — slotted CMS content (homepage.hero, banner.search), localized,
 *   scheduled (publish_at/expire_at), draft|published.
 * config — generic key/value config scoped system|portal:<name>.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { platform } from "./_schema.js";

/**
 * themes — per-portal token overrides. `portal` TEXT PK
 * (buyer|owner|builder|inspector|ops|finance|admin). `tokens` jsonb overrides.
 */
export const themes = platform.table("themes", {
  portal: text("portal").primaryKey(),
  tokens: jsonb("tokens").notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * content_blocks — slotted, localized, scheduled content. id UUIDv7.
 */
export const contentBlocks = platform.table(
  "content_blocks",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    slot: text("slot").notNull(),
    locale: text("locale").notNull().default("en"),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("draft"),
    publishAt: timestamp("publish_at", { withTimezone: true }),
    expireAt: timestamp("expire_at", { withTimezone: true }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // slot + locale lookup, ordered, for published rows.
    index("content_blocks_slot_locale_idx").on(t.slot, t.locale, t.sortOrder),
    index("content_blocks_status_idx").on(t.status),
  ],
);

/**
 * config — generic scoped key/value. `scope` system | portal:<name>. (scope, key) UK.
 */
export const config = platform.table(
  "config",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("config_scope_key_uq").on(t.scope, t.key)],
);
