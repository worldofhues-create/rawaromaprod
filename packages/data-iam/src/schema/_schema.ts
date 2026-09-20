/**
 * The `iam` Postgres schema handle (doc 10 §1 schema-per-cluster).
 *
 * Every iam table is declared on this `pgSchema` so it lands in the `iam` namespace
 * and is grantable to the dedicated `iam` PG role. The kernel outbox/audit factories
 * are fed this same handle, so `iam.outbox` / `iam.audit_events` are co-located.
 */
import { pgSchema } from "drizzle-orm/pg-core";

export const iam = pgSchema("iam");
