/**
 * platform geo engine (doc 10 §4) — a GENERIC self-referencing region tree, not
 * rigid per-level tables. India: country→state→district→tehsil→village (rural) and
 * district→city→ward→municipality→locality (urban); branching depth, no schema
 * change to add a level or a country. `code` holds the LGD/census code for future
 * RERA/registry matching. PostGIS centroid (always) + boundary (where available)
 * with GIST indexes; geo/suggest uses trigram on `name` + type filter.
 *
 * Note: `geo_region_types.key` is a TEXT PK (per ERD §4) — it is a small, fixed-ish
 * classification table, so a natural key reads better than a uuid here.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { geoMultiPolygon, geoPoint } from "@core/data-kernel";
import { platform } from "./_schema.js";

/**
 * geo_region_types — classification of region levels. TEXT `key` PK (country, state,
 * district, tehsil, village, city, ward, municipality, locality, ...).
 * `typical_parent` is a soft hint only; the real tree is in geo_regions.parent_id.
 */
export const geoRegionTypes = platform.table("geo_region_types", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  typicalParent: text("typical_parent"),
});

/**
 * geo_regions — the self-referencing region tree. type_key → geo_region_types.key
 * (in-schema FK); parent_id → self (in-schema FK). PostGIS centroid (Point) always,
 * boundary (MultiPolygon) nullable. id is UUIDv7.
 */
export const geoRegions = platform.table(
  "geo_regions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    typeKey: text("type_key")
      .notNull()
      .references(() => geoRegionTypes.key),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    code: text("code"),
    centroid: geoPoint("centroid"),
    boundary: geoMultiPolygon("boundary"),
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
    index("geo_regions_type_idx").on(t.typeKey),
    index("geo_regions_parent_idx").on(t.parentId),
    index("geo_regions_code_idx").on(t.code),
    index("geo_regions_active_idx").on(t.isActive),
    // trigram name search for geo/suggest
    index("geo_regions_name_trgm_idx").using("gin", sql`${t.name} gin_trgm_ops`),
    // GIST on geo columns
    index("geo_regions_centroid_gist").using("gist", t.centroid),
    index("geo_regions_boundary_gist").using("gist", t.boundary),
  ],
);
