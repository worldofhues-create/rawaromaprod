/**
 * @ra/cluster-packaging — the packaging cluster module + its public port + DB token. The
 * order / filling / FG-batch flows emit packaging.order.created / packaging.filling.done /
 * packaging.fg_batch.created via the transactional outbox; the worker drains that outbox onto
 * the bus for downstream (sales / dispatch) consumers.
 */
export { PackagingModule } from './packaging.module.js';
export { PACKAGING_DB, type PackagingDb } from './packaging.tokens.js';
export { packagingEvents } from './packaging.events.js';
export {
  type PackageOrderRef,
  type FinishedGoodBatchRef,
  type FinishedGoodStockRef,
  type PackagingLookup,
  PACKAGING_LOOKUP,
} from './public-api.js';
