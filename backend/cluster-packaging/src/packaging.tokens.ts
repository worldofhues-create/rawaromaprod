/**
 * packaging cluster DB token — its own per-schema Drizzle client over the `packaging` schema
 * (the Phase-1A packaging tables in `@ra/data-packaging`). Built off the shared `PG_CLIENT`
 * pool in `packaging.module.ts`. Mirrors the QUALITY_DB/IAM_DB pattern but lives in-cluster
 * (this is an `@ra` cluster, not a `@core` one).
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as packagingSchema from '@ra/data-packaging';

/** DI token for the packaging cluster's Drizzle client. */
export const PACKAGING_DB = Symbol('PACKAGING_DB');

/** The packaging cluster's Drizzle client, typed to the packaging schema. */
export type PackagingDb = PostgresJsDatabase<typeof packagingSchema>;

export { drizzle, packagingSchema };
