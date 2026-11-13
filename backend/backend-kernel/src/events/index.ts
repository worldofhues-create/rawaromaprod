export { EventBus, type DomainEvent, type EventHandler } from './event-bus.js';
export { OutboxPublisher } from './outbox.publisher.js';
export { OutboxModule, type OutboxModuleOptions } from './outbox.module.js';
export {
  OUTBOX_SOURCES,
  provideOutboxSources,
  type OutboxSource,
  type OutboxSourceSpec,
  type OutboxTable,
} from './outbox.registry.js';
export {
  recordOutbox,
  type EventDescriptor,
  type OutboxWriter,
} from './outbox.recorder.js';
export {
  emitBridgeOutbound,
  emitBridgeToRequirement,
  emitBridgeManualEvent,
  type BridgeEmitTx,
} from './bridge-emit.js';
export { assertNotMacerating, macerationOnTransition, macerationProgress, restEndedAt, emitRestStarted } from './maceration-gate.js';
export {
  SCOPE_LADDER,
  OPS,
  evaluateRules,
  validateBody,
  describeRule,
  describeCondition,
  type RuleScope,
  type ConditionOp,
  type Condition,
  type Rule,
  type PolicyBody,
  type Evaluation,
} from './policy-engine.js';
export {
  MACERATION_REST,
  QC_REFERENCE_REQUIRED,
  FILL_LOT_SERVER_ASSIGNED,
  CONTINUITY_SUPPLIER_CHANGE,
  FACTORY_RULE_KEYS,
  FACTORY_RULE_DEFAULTS,
  FACTORY_ENFORCEMENT_VERSION,
  restRuleProblems,
  referenceRuleProblems,
  lotRuleProblems,
  supplierChangeRuleProblems,
  factoryRuleProblems,
  isFactoryRuleKey,
  restRuleInForce,
  referenceRuleInForce,
  lotRuleInForce,
  factoryRuleReading,
  factoryRulesStateWire,
  type PolicyVersionRow,
  type FactoryRuleKey,
  type RestRule,
  type ReferenceRule,
  type LotRule,
  type SupplierChangeRule,
  type RuleInForce,
} from './factory-rules.js';
export {
  CONTINUITY_SUPPLIER_RULE,
  SUPPLIER_RULE_DEFAULT,
  supplierRuleProblems,
  continuityKey,
  changeKinds,
  recordBatchContinuity,
  recordReferenceContinuity,
  type ContinuityInputs,
  type ContinuityComponents,
  type ContinuityResult,
  type MaterialChangeKind,
  type SupplierRule,
} from './continuity.js';
export { emitPurchaseOrderFact, emitPurchaseOrderCancelled, emitGoodsReceiptFact } from './payables-facts.js';
// PROM-3 / PROM-6: one batch's process record, as ALEMBIC is told it.
export { qcPromiseBlockOf, restRecordOf, fgPromiseBlockOf } from './lot-promise.js';
export {
  recordProduceAlert,
  type ProduceAlertInput,
  type ProduceAlertKind,
} from './produce-alert.js';
