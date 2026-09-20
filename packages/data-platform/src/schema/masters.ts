/**
 * platform master engine (doc 10 §4) — master_types + master_items. Every dropdown
 * platform-wide reads from master_items by type_key. Hierarchical masters (defect
 * taxonomy, material categories) use parent_id. `measurement_unit` items carry
 * conversion in metadata (`{dimension,base,factor}`). Adding a master = INSERT,
 * never a migration.
 *
 * `master_types.key` is a TEXT PK (per ERD §4); master_items.id is UUIDv7.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
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
 * master_types — the registry of master lists. TEXT `key` PK (property_type,
 * unit_type, amenity, document_type, material_category, brand, measurement_unit,
 * defect_taxonomy, inspection_type, verification_type, ...). `is_hierarchical` tells
 * the app whether items use parent_id.
 */
export const masterTypes = platform.table("master_types", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  isHierarchical: boolean("is_hierarchical").notNull().default(false),
});

/**
 * master_items — the items of every list. type_key → master_types.key (in-schema FK);
 * parent_id → self (in-schema FK, hierarchical). `key` is a stable code, unique per
 * type. `metadata` holds e.g. unit conversion `{dimension:'area',base:'sqft',
 * factor:9.0}`.
 */
export const masterItems = platform.table(
  "master_items",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    typeKey: text("type_key")
      .notNull()
      .references(() => masterTypes.key),
    key: text("key").notNull(),
    label: text("label").notNull(),
    parentId: uuid("parent_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    metadata: jsonb("metadata"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // A key is unique within its type.
    uniqueIndex("master_items_type_key_uq").on(t.typeKey, t.key),
    index("master_items_type_idx").on(t.typeKey),
    index("master_items_parent_idx").on(t.parentId),
    index("master_items_active_idx").on(t.isActive),
    index("master_items_label_trgm_idx").using("gin", sql`${t.label} gin_trgm_ops`),
  ],
);
