/**
 * @ra/cluster-production — the production cluster module + its public port + DB token. The
 * order flow expands an APPROVED formula's coded pick list (VAULT_PORT.resolvePickList, over the
 * signed channel to the Formula Vault — the floor never sees the recipe) into a production order's
 * bill-of-materials and emits
 * production.order.created / production.materials.issued / production.oil_batch.created /
 * production.qc.recorded via the transactional outbox; the worker drains that outbox onto the
 * bus for downstream (packaging, traceability) consumers. The ONLY cold-read surface is the
 * PRODUCTION_LOOKUP port.
 */
export { ProductionModule } from './production.module.js';
export { PRODUCTION_DB, type ProductionDb } from './production.tokens.js';
export { productionEvents } from './production.events.js';
export {
  type OilBatchRef,
  type OrderRef,
  type ProductionLookup,
  PRODUCTION_LOOKUP,
} from './public-api.js';
export {
  ProduceQueueService,
  PRODUCE_ALERT_ROLES,
  FORMULA_ALERT_ROLES,
  BLOCK_MESSAGES,
  countersOf,
  queueStage,
  requirementKg,
  type QueueRow,
  type QueueCounters,
  type QueueStage,
} from './produce/produce-queue.service.js';
export { ProducePlanService, PlanBlockedException, type PlanResult } from './produce/produce-plan.service.js';
export { PlanningService } from './planning/planning.service.js';
export { CoaService, QC_ALERT_ROLES } from './coa/coa.service.js';
