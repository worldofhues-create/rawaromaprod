/**
 * Injection token + typed Drizzle client for the inventory cluster (inventory schema).
 *
 * Like the other @ra clusters, this mints its OWN client off the shared `PG_CLIENT` pool,
 * bound to the `@ra/data-inventory` schema barrel. The boundary rule holds: this cluster
 * only ever receives a client typed to its own schema.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as inventorySchema from '@ra/data-inventory';

/** DI token → `InventoryDb`. Inject with `@Inject(INVENTORY_DB)`. */
export const INVENTORY_DB = Symbol('INVENTORY_DB');

/** Drizzle client bound to the `@ra/data-inventory` (inventory) schema barrel. */
export type InventoryDb = PostgresJsDatabase<typeof inventorySchema>;

export { inventorySchema, drizzle };
