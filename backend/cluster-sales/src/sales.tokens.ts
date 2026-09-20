/**
 * sales cluster DB token — its own per-schema Drizzle client over the `sales` schema
 * (the Phase-1A sales tables in `@ra/data-sales`). Built off the shared `PG_CLIENT` pool in
 * `sales.module.ts`. Mirrors the QUALITY_DB pattern: an in-cluster `@ra` token, not a `@core`
 * one.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as salesSchema from '@ra/data-sales';

/** DI token for the sales cluster's Drizzle client. */
export const SALES_DB = Symbol('SALES_DB');

/** The sales cluster's Drizzle client, typed to the sales schema. */
export type SalesDb = PostgresJsDatabase<typeof salesSchema>;

export { drizzle, salesSchema };
