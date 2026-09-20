/**
 * The `workflow` Postgres schema — RAW AROMACHEM Phase-1A lightweight state engine
 * (NOT a dynamic workflow builder). Built table-for-table to the Phase-1A Data Dictionary.
 * Only the dictionary state engine lives here: workflow_state_master +
 * workflow_transaction_master. from_state_id/to_state_id are kept as id-only soft refs
 * (plain uuid + index, no FK) to keep the engine simple; entity_id and performed_by are
 * id-only refs too (performed_by is a cross-schema soft ref to iam.user_master).
 *
 * NOTE: @mfg/data-workflow also targets pgSchema("workflow") with OTHER table names —
 * that coexists fine; this package uses its own migrate tracking table.
 */
import { pgSchema } from "drizzle-orm/pg-core";

export const workflow = pgSchema("workflow");
