/**
 * The `platform` Postgres schema handle (doc 10 §1 schema-per-cluster, §4 ERD).
 *
 * The control plane + geo + masters cluster. Generic engines, not one-table-per-
 * thing: a geo_regions self-tree and master_types/master_items handle any hierarchy
 * or list, so a new master is data, not a migration.
 */
import { pgSchema } from "drizzle-orm/pg-core";

export const platform = pgSchema("platform");
