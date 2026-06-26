/**
 * @ra/data-workflow-state — Phase-1A workflow schema (lightweight state engine):
 * workflow_state_master + workflow_transaction_master, built table-for-table to the
 * Data Dictionary.
 */
export * from "./schema/index.js";
export { WORKFLOW_STATE_PREREQUISITES } from "./migrate.js";
