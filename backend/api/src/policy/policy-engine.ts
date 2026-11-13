/**
 * PROM-2: the rules engine moved to the kernel (backend-kernel/src/events/policy-engine.ts) so the
 * maceration gate, which runs inside the oil-batch transaction in cluster-production, evaluates
 * `maceration.rest` with the SAME evaluator the Rules screen tests and publishes with. A second copy
 * of the scope ladder in the kernel would be a second rules engine; this file keeps every existing
 * import path working.
 */
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
} from '@core/backend-kernel';
