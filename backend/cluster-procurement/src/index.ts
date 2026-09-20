/**
 * @ra/cluster-procurement — the RAW AROMACHEM procurement cluster module + its public port.
 *
 * Exports the module (composed by `api`), the `PROCUREMENT_DB` token (for the worker that
 * drains this cluster's outbox), and the `PROCUREMENT_LOOKUP` cold-read port + its types.
 */
export { ClusterProcurementModule } from './cluster-procurement.module.js';
export {
  PROCUREMENT_DB,
  type ProcurementDb,
} from './cluster-procurement.tokens.js';
export {
  type ProcurementLookup,
  type VendorRef,
  type PurchaseOrderRef,
  PROCUREMENT_LOOKUP,
} from './public-api.js';
