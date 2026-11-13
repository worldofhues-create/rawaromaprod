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
export { assertNotMacerating, macerationOnTransition, macerationProgress, restEndedAt } from './maceration-gate.js';
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
  FACTORY_RULE_KEYS,
  FACTORY_RULE_DEFAULTS,
  FACTORY_ENFORCEMENT_VERSION,
  restRuleProblems,
  referenceRuleProblems,
  factoryRuleProblems,
  isFactoryRuleKey,
  restRuleInForce,
  referenceRuleInForce,
  type FactoryRuleKey,
  type RestRule,
  type ReferenceRule,
  type RuleInForce,
} from './factory-rules.js';
export { emitPurchaseOrderFact, emitPurchaseOrderCancelled, emitGoodsReceiptFact } from './payables-facts.js';
export {
  recordProduceAlert,
  type ProduceAlertInput,
  type ProduceAlertKind,
} from './produce-alert.js';
