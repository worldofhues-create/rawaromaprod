/**
 * Transactional outbox factory — the reliability backbone (doc 10 §1).
 *
 * `outboxTable(schema)` builds `<schema>.outbox`. Every cluster gets exactly one,
 * created from this factory so the shape is identical everywhere (a generic worker
 * can drain any schema's outbox without per-cluster code).
 *
 * Pattern: in the same DB transaction that mutates domain data, INSERT an outbox
 * row. A worker polls `published_at IS NULL` ordered by `occurred_at`, dispatches
 * to the in-proc bus (→ NATS at extraction), then stamps `published_at`. `attempts`
 * backs off / dead-letters poison messages.
 */
import { sql } from "drizzle-orm";
import {
  type PgSchema,
  bigint,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Build the outbox table for a cluster schema.
 *
 * @param schema a `pgSchema("<cluster>")` instance.
 * @returns the Drizzle table (export it from the cluster's schema barrel).
 */
export function outboxTable(schema: PgSchema) {
  return schema.table(
    "outbox",
    {
      id: uuid("id")
        .primaryKey()
        .default(sql`uuidv7()`),
      /** event type, `cluster.entity.verb` past-tense (doc 11 §3.1). */
      type: text("type").notNull(),
      /** the event envelope payload `{...}` — validated by zod app-side. */
      payload: jsonb("payload").notNull(),
      /** id of the aggregate root this event is about (for ordering/partitioning). */
      aggregateId: uuid("aggregate_id"),
      occurredAt: timestamp("occurred_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      /** null until the worker has dispatched it. The drain filter. */
      publishedAt: timestamp("published_at", { withTimezone: true }),
      /** dispatch attempt counter for backoff / dead-lettering. */
      attempts: integer("attempts").notNull().default(0),
      /** monotonic sequence to break ties on identical occurred_at within a tx. */
      seq: bigint("seq", { mode: "bigint" }).generatedAlwaysAsIdentity(),
    },
    (t) => [
      // The drain query: unpublished rows in occurrence order. Partial index keeps
      // it tiny (published rows fall out) — the hot path for the worker.
      index("outbox_unpublished_idx")
        .on(t.occurredAt, t.seq)
        .where(sql`${t.publishedAt} IS NULL`),
      index("outbox_aggregate_idx").on(t.aggregateId),
    ],
  );
}
