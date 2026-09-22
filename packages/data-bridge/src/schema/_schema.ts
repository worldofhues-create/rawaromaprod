/**
 * The `bridge` Postgres schema — the ALEMBIC↔RawProd channel (data-conventions §1
 * schema-per-cluster, extended to a cross-repo boundary). Owns the local
 * ProductionRequirement projection RawProd tracks against ALEMBIC's requirement id, the
 * inbound dedupe/park ledger for events arriving FROM ALEMBIC, and its own outbox for
 * events going TO ALEMBIC. No cross-schema FK out of `bridge` into `production`/`sales` —
 * same extraction-safe soft-ref rule every other cluster follows, doubly true here since
 * the far side of this boundary isn't even in this database.
 */
import { pgSchema } from "drizzle-orm/pg-core";

export const bridge = pgSchema("bridge");
