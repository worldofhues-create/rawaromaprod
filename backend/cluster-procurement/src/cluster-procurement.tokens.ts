/**
 * Injection token + typed Drizzle client for the procurement cluster (procurement schema).
 *
 * Like the other @ra clusters, this mints its OWN client off the shared `PG_CLIENT` pool,
 * bound to the `@ra/data-procurement` schema barrel. The boundary rule holds: this cluster
 * only ever receives a client typed to its own schema.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as procurementSchema from '@ra/data-procurement';

/** DI token → `ProcurementDb`. Inject with `@Inject(PROCUREMENT_DB)`. */
export const PROCUREMENT_DB = Symbol('PROCUREMENT_DB');

/** Drizzle client bound to the `@ra/data-procurement` (procurement) schema barrel. */
export type ProcurementDb = PostgresJsDatabase<typeof procurementSchema>;

export { procurementSchema, drizzle };
