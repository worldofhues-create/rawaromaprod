/**
 * Secure mixing tables (Phase-1A Data Dictionary): SECURE_MIXING_SESSION, MIXING_STEP_LOG.
 * The direct header->line ref (step_log->session) is an in-schema FK; the ref to production_order
 * and formula stage / operator / user refs are id-only soft refs per the locked dictionary.
 */
import { index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { production } from "./_schema.js";

/** SECURE_MIXING_SESSION */
export const secureMixingSession = production.table(
  "secure_mixing_session",
  {
    secureMixingSessionId: dictPk("secure_mixing_session_id"),
    productionOrderId: uuid("production_order_id"), // soft ref → production_order (per locked dictionary)
    operatorId: uuid("operator_id"), // soft ref → iam.user_master
    sessionStartDt: timestamp("session_start_dt", { withTimezone: true }),
    sessionEndDt: timestamp("session_end_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [index("secure_mixing_session_order_idx").on(t.productionOrderId)],
);

/** MIXING_STEP_LOG */
export const mixingStepLog = production.table(
  "mixing_step_log",
  {
    mixingStepLogId: dictPk("mixing_step_log_id"),
    secureMixingSessionId: uuid("secure_mixing_session_id").references(
      () => secureMixingSession.secureMixingSessionId,
    ),
    formulaStageId: uuid("formula_stage_id"), // soft ref → formula.formula_stage_master
    stepSequence: integer("step_sequence"),
    stepDescription: text("step_description"),
    performedDt: timestamp("performed_dt", { withTimezone: true }),
    performedBy: uuid("performed_by"), // soft ref → iam.user_master
    ...metaColumns(),
  },
  (t) => [index("mixing_step_log_session_idx").on(t.secureMixingSessionId)],
);
