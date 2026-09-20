/**
 * Outbox source registry — the list of (db, outbox-table) pairs the publisher drains.
 *
 * Every cluster owns exactly one outbox table built from the kernel `outboxTable()`
 * factory, so they all share one shape: { id, type, payload, aggregateId, occurredAt,
 * publishedAt, attempts, seq }. The publisher is therefore generic — it never imports a
 * cluster; it just iterates whatever sources are registered here. The `api`/`worker`
 * composition root registers iam + platform (and any new cluster) via this token.
 */
import type { Provider } from '@nestjs/common';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Db } from '@core/data-kernel';

/**
 * The minimal column surface the publisher relies on. Each cluster's `outbox` table has
 * exactly these columns (from `outboxTable()`); typing them structurally keeps the
 * publisher decoupled from any specific schema barrel.
 */
export interface OutboxTable extends PgTable {
  id: PgColumn;
  type: PgColumn;
  payload: PgColumn;
  aggregateId: PgColumn;
  occurredAt: PgColumn;
  publishedAt: PgColumn;
  attempts: PgColumn;
  seq: PgColumn;
}

/** One drainable outbox: a schema-bound db client + that schema's outbox table. */
export interface OutboxSource {
  /** Human label for logs/metrics, e.g. `iam`. */
  cluster: string;
  db: Db;
  table: OutboxTable;
}

/** DI token → `OutboxSource[]`. Provided by the composition root. */
export const OUTBOX_SOURCES = Symbol('OUTBOX_SOURCES');

/** One outbox source spec: a label, the cluster's per-schema db DI token, and its table. */
export interface OutboxSourceSpec {
  cluster: string;
  dbToken: symbol;
  table: OutboxTable;
}

/**
 * Factory provider for `OUTBOX_SOURCES`. The worker composition root passes one spec per
 * cluster; the factory injects each cluster's per-schema db client (already in the global
 * DI graph) and pairs it with that cluster's outbox table. Adding a cluster to the event
 * loop = add one spec line in the worker — no edit here, no @ra import in @core.
 */
export function provideOutboxSources(specs: OutboxSourceSpec[]): Provider {
  return {
    provide: OUTBOX_SOURCES,
    inject: specs.map((s) => s.dbToken),
    useFactory: (...dbs: Db[]): OutboxSource[] =>
      specs.map((spec, i) => ({ cluster: spec.cluster, db: dbs[i]!, table: spec.table })),
  };
}
