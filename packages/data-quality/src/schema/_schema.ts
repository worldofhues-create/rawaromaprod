/**
 * The `quality` Postgres schema handle (data-conventions §1 schema-per-cluster).
 *
 * Owns QC parameter configs + the named-param catalog (M05), QC inspections + results,
 * sample retentions, and vendor settlements. References to OTHER clusters (materials,
 * GRNs, batches, storage nodes, inspectors) are id-only SOFT REFS — no cross-schema FK
 * (extraction-safe). In-schema FKs (inspection → results) are real.
 */
import { pgSchema } from "drizzle-orm/pg-core";

export const quality = pgSchema("quality");
