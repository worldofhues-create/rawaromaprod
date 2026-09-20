/**
 * inventory cluster — PUBLIC API.
 *
 * The only surface other clusters may import from cluster-inventory. Cross-cluster reads go
 * through this cold-read port (inject by token); never a deep import into a service or the
 * schema. Resolvers return id + ref values only — no meta tail, no bodies.
 */

/** A minimal RM-batch view for cross-cluster resolution. */
export interface RmBatchRef {
  rmBatchId: string;
  materialId: string | null;
  batchNumber: string | null;
  status: string | null;
}

/** A minimal inventory-batch view for cross-cluster resolution. */
export interface InventoryBatchRef {
  inventoryBatchId: string;
  rmBatchId: string | null;
  quantityOnHand: string | null;
}

/** Cold-read port into the inventory cluster. */
export interface InventoryLookup {
  /** Resolve an RM batch by id (material/number/status refs only), or null if absent. */
  findRmBatch(rmBatchId: string): Promise<RmBatchRef | null>;
  /** Resolve an inventory batch by id (rm-batch/on-hand refs only), or null if absent. */
  findInventoryBatch(inventoryBatchId: string): Promise<InventoryBatchRef | null>;
}

/** DI token for `InventoryLookup`. Consumers: `@Inject(INVENTORY_LOOKUP)`. */
export const INVENTORY_LOOKUP = Symbol('INVENTORY_LOOKUP');
