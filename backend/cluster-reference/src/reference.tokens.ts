/**
 * reference cluster DB token — its own per-schema Drizzle client over the `platform`
 * schema (the Phase-1A reference masters in `@ra/data-reference`). Built off the shared
 * `PG_CLIENT` pool in `reference.module.ts`. Mirrors the IAM_DB/PLATFORM_DB pattern but
 * lives in-cluster (this is an `@ra` cluster, not a `@core` one).
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as referenceSchema from '@ra/data-reference';

/** DI token for the reference cluster's Drizzle client. */
export const REFERENCE_DB = Symbol('REFERENCE_DB');

/** The reference cluster's Drizzle client, typed to the platform reference schema. */
export type ReferenceDb = PostgresJsDatabase<typeof referenceSchema>;

export { drizzle, referenceSchema };
