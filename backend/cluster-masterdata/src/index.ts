/**
 * @ra/cluster-masterdata — the RAW AROMACHEM masterdata cluster module + its public port.
 *
 * Exports the module (composed by `api`), the `MASTERDATA_DB` token (for the worker that
 * drains this cluster's outbox), and the `MASTERDATA_LOOKUP` cold-read port + its types.
 */
export { ClusterMasterdataModule } from './cluster-masterdata.module.js';
export {
  MASTERDATA_DB,
  type MasterdataDb,
} from './cluster-masterdata.tokens.js';
export {
  type MasterdataLookup,
  type MaterialRef,
  type AliasRef,
  MASTERDATA_LOOKUP,
} from './public-api.js';
