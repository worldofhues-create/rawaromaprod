/**
 * production cluster DB token — its own per-schema Drizzle client over the `production` schema
 * (Phase-1A production tables in `@ra/data-production`), built off the shared `PG_CLIENT` pool
 * in production.module.ts. Mirrors the INVENTORY_DB / QUALITY_DB pattern.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as productionSchema from '@ra/data-production';

/** DI token for the production cluster's Drizzle client. */
export const PRODUCTION_DB = Symbol('PRODUCTION_DB');

/** The production cluster's Drizzle client, typed to the production schema. */
export type ProductionDb = PostgresJsDatabase<typeof productionSchema>;

export { drizzle, productionSchema };
