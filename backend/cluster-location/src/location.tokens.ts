/**
 * Injection token + type for the location cluster's per-schema Drizzle client.
 *
 * The boundary rule (doc 01 §0): each cluster touches ONLY its own schema. The kernel
 * hands us the shared postgres-js pool via `PG_CLIENT`; we bind a Drizzle client to the
 * `location` schema barrel here so this cluster can physically reference only location
 * tables. One socket (the shared pool), one schema generic.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as locationSchema from '@ra/data-location';

/** Drizzle client bound to the `location` schema barrel. */
export type LocationDb = PostgresJsDatabase<typeof locationSchema>;

/** DI token → `LocationDb`. Inject with `@Inject(LOCATION_DB)`. */
export const LOCATION_DB = Symbol('LOCATION_DB');

/** Re-export the schema barrel so callers type their queries without a second import. */
export { locationSchema };
export { drizzle };
