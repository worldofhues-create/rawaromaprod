/**
 * production schema barrel (Phase-1A). drizzle.config points here.
 */
export { production } from "./_schema.js";
export {
  productionPlan,
  productionPlanItems,
  productionOrder,
  productionOrderIngredients,
} from "./plan.js";
export {
  materialPickList,
  materialPickListItems,
  materialIssue,
  materialIssueItem,
} from "./picking.js";
export { secureMixingSession, mixingStepLog } from "./mixing.js";
export { weighingRecord } from "./weighing.js";
export {
  oilBatchMaster,
  oilBatchConsumption,
  oilBatchEventHistory,
} from "./batch.js";
export { productionQc, oilBatchQcHistory } from "./qc.js";
export { outbox, auditEvents } from "./crosscutting.js";
