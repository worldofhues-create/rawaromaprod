/**
 * Workflow tables (Phase-1A Data Dictionary, schema `workflow`): WORKFLOW_STATE_MASTER and
 * WORKFLOW_TRANSACTION_MASTER — the lightweight state engine.
 *
 * - workflow_transaction_master.from_state_id / to_state_id are in-schema soft refs to
 *   workflow_state_master, but per the build spec we keep them as plain uuid + index (NOT
 *   FK) to keep the engine simple.
 * - entity_id is a plain uuid (polymorphic — points at PURCHASE_REQUEST / FORMULA / PO rows).
 * - performed_by is a cross-schema soft ref to iam.user_master (id-only, no FK).
 */
import { boolean, index, integer, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { workflow } from "./_schema.js";

/** WORKFLOW_STATE_MASTER */
export const workflowStateMaster = workflow.table(
  "workflow_state_master",
  {
    workflowStateId: dictPk("workflow_state_id"),
    workflowName: varchar("workflow_name", { length: 200 }),
    stateCode: varchar("state_code", { length: 50 }),
    stateName: varchar("state_name", { length: 200 }),
    isInitial: boolean("is_initial").notNull().default(false),
    isFinal: boolean("is_final").notNull().default(false),
    sortOrder: integer("sort_order"),
    ...metaColumns(),
  },
  (t) => [index("workflow_state_master_name_idx").on(t.workflowName)],
);

/** WORKFLOW_TRANSACTION_MASTER */
export const workflowTransactionMaster = workflow.table(
  "workflow_transaction_master",
  {
    workflowTransactionId: dictPk("workflow_transaction_id"),
    workflowName: varchar("workflow_name", { length: 200 }),
    entityType: varchar("entity_type", { length: 100 }),
    entityId: uuid("entity_id"),
    // in-schema soft refs → workflow_state_master (plain uuid + index, no FK)
    fromStateId: uuid("from_state_id"),
    toStateId: uuid("to_state_id"),
    transitionAction: varchar("transition_action", { length: 100 }),
    // cross-schema soft ref → iam.user_master
    performedBy: uuid("performed_by"),
    transactionDt: timestamp("transaction_dt", { withTimezone: true }),
    comments: text("comments"),
    ...metaColumns(),
  },
  (t) => [
    index("workflow_transaction_master_entity_idx").on(t.entityId),
    index("workflow_transaction_master_from_state_idx").on(t.fromStateId),
    index("workflow_transaction_master_to_state_idx").on(t.toStateId),
    index("workflow_transaction_master_performed_by_idx").on(t.performedBy),
  ],
);
