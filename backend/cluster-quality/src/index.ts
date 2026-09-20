/**
 * @ra/cluster-quality — the quality cluster module + its public port + DB token. The
 * inspection flow emits quality.qc.passed / quality.qc.failed via the transactional outbox;
 * the worker drains that outbox onto the bus for downstream (inventory) consumers.
 */
export { QualityModule } from './quality.module.js';
export { QUALITY_DB, type QualityDb } from './quality.tokens.js';
export { qualityEvents } from './quality.events.js';
export {
  type InspectionRef,
  type QualityLookup,
  QUALITY_LOOKUP,
} from './public-api.js';
