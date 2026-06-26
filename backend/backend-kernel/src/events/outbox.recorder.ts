/**
 * outbox recorder — the PRODUCER side of the transactional outbox.
 *
 * Cluster services call `recordOutbox(tx, table, event, payload)` INSIDE the same
 * Drizzle transaction that mutates their domain rows. The insert and the domain write
 * commit atomically, so an event is emitted if and only if its cause was persisted. The
 * `OutboxPublisher` later drains the row onto the bus. A free function (not a provider)
 * so it composes inside any `db.transaction(async (tx) => …)` callback.
 */
import type { OutboxTable } from './outbox.registry.js';

/** A contracts `defineEvent(...)` descriptor: `{ type, schema }`. We only need `type`. */
export interface EventDescriptor {
  type: string;
}

/** The outbox row we insert. Matches the kernel `outboxTable()` insertable columns. */
interface OutboxInsert {
  type: string;
  payload: unknown;
  aggregateId: string | null;
}

/**
 * The minimal write surface the recorder needs. Both a Drizzle db AND a transaction
 * handle expose `insert(table).values(row)`, so typing it structurally lets callers pass
 * either without a cast (a `PgTransaction` is not assignable to `PostgresJsDatabase`, but
 * it IS assignable to this).
 */
export interface OutboxWriter {
  insert(table: OutboxTable): { values(row: OutboxInsert): Promise<unknown> | unknown };
}

/**
 * Insert one outbox row. `payload` is validated by the caller against the event's zod
 * schema (`descriptor.schema`) before this is called — the recorder stays free of zod so
 * it remains a thin, transaction-friendly insert.
 *
 * @param writer the active Drizzle transaction (or a db handle for non-tx writes).
 * @param table  the cluster's outbox table (`iamSchema.outbox`, …).
 * @param descriptor the event type (from `@core/contracts` …Events.*).
 * @param payload the event payload object.
 * @param aggregateId optional root id for ordering/partitioning.
 */
export async function recordOutbox(
  writer: OutboxWriter,
  table: OutboxTable,
  descriptor: EventDescriptor,
  payload: unknown,
  aggregateId?: string,
): Promise<void> {
  await writer.insert(table).values({
    type: descriptor.type,
    payload,
    aggregateId: aggregateId ?? null,
  });
}
