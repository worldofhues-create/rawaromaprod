/**
 * @ra/cluster-inventory — the RAW AROMACHEM inventory cluster module + its public port.
 *
 * Exports the module (composed by `api`), the `INVENTORY_DB` token (for the worker that drains
 * this cluster's outbox), and the `INVENTORY_LOOKUP` cold-read port + its types.
 */
export { ClusterInventoryModule } from './cluster-inventory.module.js';
export { INVENTORY_DB, type InventoryDb } from './cluster-inventory.tokens.js';
export {
  type InventoryLookup,
  type RmBatchRef,
  type InventoryBatchRef,
  INVENTORY_LOOKUP,
} from './public-api.js';
/* PROD-B: the receiving audit (api/src/prodfloor) writes its GRN through the same service, inside
 * its own transaction, so the checklist, the decision and the GRN land together or not at all. */
export { GrnService } from './grn/grn.service.js';
