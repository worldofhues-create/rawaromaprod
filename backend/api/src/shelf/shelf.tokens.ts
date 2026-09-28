/**
 * The shelf module's database handle (lane produce): a schema-less Drizzle client over the shared
 * PG_CLIENT pool. The shelf flows are cross-schema by nature (location bins, packaging FG batches,
 * production QC, the bridge outbox) and use raw SQL — the same BFF idiom as dispatchdocs /
 * packaging-qc — but through Drizzle's `transaction`/`execute`, so the kernel's shared writers
 * (`emitBridgeManualEvent`, `recordProduceAlert`) run inside the same transaction.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';

export const SHELF_DB = Symbol('SHELF_DB');
export type ShelfDb = PostgresJsDatabase<Record<string, never>>;
export type ShelfTx = Parameters<Parameters<ShelfDb['transaction']>[0]>[0];

export function shelfDb(client: Sql): ShelfDb {
  return drizzle(client);
}
