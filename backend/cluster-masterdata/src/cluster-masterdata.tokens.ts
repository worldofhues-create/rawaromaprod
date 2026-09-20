/**
 * masterdata cluster DB token — its own per-schema Drizzle client over the `masterdata`
 * schema (the Phase-1A material masters in `@ra/data-masterdata`). Built off the shared
 * `PG_CLIENT` pool in `cluster-masterdata.module.ts`. Mirrors the REFERENCE_DB pattern.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as masterdataSchema from '@ra/data-masterdata';

/** DI token for the masterdata cluster's Drizzle client. */
export const MASTERDATA_DB = Symbol('MASTERDATA_DB');

/** The masterdata cluster's Drizzle client, typed to the masterdata schema. */
export type MasterdataDb = PostgresJsDatabase<typeof masterdataSchema>;

export { drizzle, masterdataSchema };
