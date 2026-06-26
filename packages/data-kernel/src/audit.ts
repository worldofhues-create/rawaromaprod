/**
 * Audit-events factory — append-only change log (doc 10 §1 cross-cutting tables).
 *
 * `auditTable(schema)` builds `<schema>.audit_events`. Written by the backend audit
 * interceptor on every mutating request: who (actor_id), what (action +
 * entity_type/id), the before/after jsonb diff, plus request_id + ip for tracing.
 *
 * Hash-chain (doc 10 §1 + §7): `prev_hash` / `row_hash` make the log tamper-evident
 * — `row_hash = H(prev_hash || canonical(row))`. Mandatory in `trust` + `revenue`,
 * optional/nullable elsewhere. Columns ship on EVERY schema's table (uniform shape);
 * clusters that don't chain simply leave them null. The interceptor computes them.
 *
 * Append-only: no UPDATE/DELETE in the app; corrections are new rows. Enforce with
 * a table grant (REVOKE UPDATE, DELETE) in nt-infra, not here.
 */
import { sql } from "drizzle-orm";
import {
  type PgSchema,
  bigint,
  index,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Build the audit_events table for a cluster schema.
 *
 * @param schema a `pgSchema("<cluster>")` instance.
 * @param opts.hashChain when true, documents intent that this cluster's interceptor
 *   MUST populate prev_hash/row_hash (trust, revenue). Purely advisory — the columns
 *   exist regardless so the shape is uniform and forward-compatible.
 */
export function auditTable(schema: PgSchema, opts: { hashChain?: boolean } = {}) {
  void opts.hashChain; // advisory only; columns are always present.
  return schema.table(
    "audit_events",
    {
      id: uuid("id")
        .primaryKey()
        .default(sql`uuidv7()`),
      /** iam.users id of the actor — id-only soft ref, never a FK. Null = system. */
      actorId: uuid("actor_id"),
      /** verb, e.g. `listing.publish`, `flag.update`. */
      action: text("action").notNull(),
      /** the entity table/type acted on, e.g. `listings`. */
      entityType: text("entity_type").notNull(),
      /** the entity row id. */
      entityId: uuid("entity_id"),
      /** snapshot before the change (null on create). */
      before: jsonb("before"),
      /** snapshot after the change (null on delete). */
      after: jsonb("after"),
      /** correlation id threaded from the edge layer. */
      requestId: text("request_id"),
      /** client ip (text to hold v4/v6). */
      ip: text("ip"),
      occurredAt: timestamp("occurred_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      // --- hash-chain (tamper-evidence) ---
      /**
       * App-assigned, strictly monotonic chain counter (1-based), set under the same
       * advisory lock that serializes appends. UNLIKE an identity column it is folded into
       * `row_hash`, so deleting the tail of the chain leaves a detectable gap/regression in
       * `chain_seq` that no KEK-less attacker can paper over (the row_hash won't recompute).
       * Null for non-chained writers (the generic interceptor leaves it unset).
       */
      chainSeq: bigint("chain_seq", { mode: "bigint" }),
      /** row_hash of the previous audit row in this chain (null for genesis). */
      prevHash: text("prev_hash"),
      /** H(prev_hash || canonical(this row)) — canonical INCLUDES chain_seq. Verifiable end-to-end. */
      rowHash: text("row_hash"),
    },
    (t) => [
      index("audit_events_entity_idx").on(t.entityType, t.entityId),
      index("audit_events_actor_idx").on(t.actorId),
      index("audit_events_occurred_idx").on(t.occurredAt),
      index("audit_events_request_idx").on(t.requestId),
      // Chain-head read (order by chain_seq desc) under the append lock.
      index("audit_events_chain_seq_idx").on(t.chainSeq),
    ],
  );
}
