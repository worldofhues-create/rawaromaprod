/**
 * bridge cluster DB token — its own per-schema Drizzle client over the `bridge` schema
 * (@ra/data-bridge), built off the shared PG_CLIENT pool in bridge.module.ts. Mirrors the
 * PRODUCTION_DB / QUALITY_DB pattern every other cluster in this codebase uses.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as bridgeSchema from '@ra/data-bridge';

export const BRIDGE_DB = Symbol('BRIDGE_DB');
export type BridgeDb = PostgresJsDatabase<typeof bridgeSchema>;

export { drizzle, bridgeSchema };
