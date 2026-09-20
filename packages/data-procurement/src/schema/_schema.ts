/**
 * The `procurement` Postgres schema handle (data-conventions §1 schema-per-cluster).
 *
 * Owns vendor master + material-map + rate-history + performance (M03); PR/RFQ/quotation/PO
 * (M04) land here later. Vendor CONTACTS are NOT duplicated here — they reuse the single
 * masterdata contact master (`owner_type='vendor'`), resolving the prior double-model defect.
 * Material refs are id-only SOFT REFS to masterdata (no cross-schema FK; extraction-safe).
 */
import { pgSchema } from "drizzle-orm/pg-core";

export const procurement = pgSchema("procurement");
