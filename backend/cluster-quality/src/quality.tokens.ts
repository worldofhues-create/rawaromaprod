/**
 * quality cluster DB token — its own per-schema Drizzle client over the `quality` schema
 * (the Phase-1A QC tables in `@ra/data-quality`). Built off the shared `PG_CLIENT` pool in
 * `quality.module.ts`. Mirrors the IAM_DB/PLATFORM_DB pattern but lives in-cluster (this is
 * an `@ra` cluster, not a `@core` one).
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as qualitySchema from '@ra/data-quality';

/** DI token for the quality cluster's Drizzle client. */
export const QUALITY_DB = Symbol('QUALITY_DB');

/** The quality cluster's Drizzle client, typed to the quality schema. */
export type QualityDb = PostgresJsDatabase<typeof qualitySchema>;

export { drizzle, qualitySchema };
