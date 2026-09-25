/**
 * G3 — shared constants for the factory-side deterministic automation layer.
 *
 * SYSTEM_ACTOR: every rule in this module runs in the `worker` process, outside the HTTP/
 * NestJS-guard boundary — exactly the same posture ConsumptionService (backend/api/src/
 * consumption), EmailNotifierService (backend/api/src/notify) and BridgeRelayService
 * (backend/api/src/bridge) already have: no `AuthPrincipal` exists to check a permission
 * against, because there is no request. `created_by`/`updated_by` columns are
 * `varchar(255)` username strings (dictionary convention — @core/data-kernel's
 * `metaColumns()`), never a uuid FK, so a literal string identifying the automation actor is
 * the established idiom (see EmailNotifierService's `'auto-approve-24h'` and
 * cluster-org/security.service.ts's `'system'`).
 *
 * "Respects permissions (system actor with explicit minimal role)" is satisfied by scoping
 * what this actor is even CAPABLE of touching, at the code level, to exactly the tables each
 * rule below documents — never a PO, never a formula, never money capture, never a role/user
 * grant. Each rule file states its own minimal write set in its header. There is no dynamic
 * permission escalation path: the automation module has no controller, no route, and is never
 * reachable from a request — its blast radius is fixed at review time, not runtime.
 */

/** The actor recorded on every row this module writes (created_by / updated_by / decision log). */
export const SYSTEM_ACTOR = 'automation:g3';

/** A failed rule invocation is retried up to this many times before it is dead-lettered. */
export const MAX_ATTEMPTS = Number(process.env.AUTOMATION_MAX_ATTEMPTS) || 5;

/** Poll interval for each outbox-driven rule (ms). */
export const AUTOMATION_POLL_MS = Number(process.env.AUTOMATION_POLL_MS) || 5000;

/** Poll interval for the time/threshold condition scan (ms). Default 15 min. */
export const AUTOMATION_SCAN_MS = Number(process.env.AUTOMATION_SCAN_MS) || 900000;

/** QC HOLD is alerted once it has sat this many hours without a disposition. */
export const QC_HOLD_ALERT_HOURS = Number(process.env.AUTOMATION_QC_HOLD_ALERT_HOURS) || 48;

/** A purchase request pending approval this many hours is alerted as overdue. */
export const PR_OVERDUE_HOURS = Number(process.env.AUTOMATION_PR_OVERDUE_HOURS) || 48;

/** A purchase order not yet issued/approved this many hours is alerted as overdue. */
export const PO_OVERDUE_HOURS = Number(process.env.AUTOMATION_PO_OVERDUE_HOURS) || 48;

/** Whether the material-shortage rule also drafts an RFQ alongside the draft PR. */
export const AUTO_RFQ_ENABLED = process.env.AUTOMATION_AUTO_RFQ !== 'false';

/** Stable rule codes — the `rule_code` half of every idempotency key. */
export const RULE = {
  MATERIAL_SHORTAGE: 'material_shortage_to_draft_pr',
  QUARANTINE_INTAKE: 'grn_batch_to_quarantine_qc',
  INCOMING_QC_PASS: 'incoming_qc_pass_release',
  INCOMING_QC_FAIL: 'incoming_qc_fail_reject_credit',
  PACKAGING_QC_RELEASE: 'packaging_qc_pass_fg_release',
  ALERT_QC_HOLD_AGE: 'alert_qc_hold_age',
  ALERT_PR_OVERDUE: 'alert_pr_overdue',
  ALERT_PO_OVERDUE: 'alert_po_overdue',
} as const;

/**
 * The human-readable suffix of an automation-drafted document number (PR-AUTO-…, RFQ-AUTO-…,
 * CN-AUTO-…), taken from the TAIL of the row's uuidv7 id. Row ids here are uuidv7 — the tables'
 * own default, which the id-ordered lists ("newest first") rely on — and a uuidv7's HEAD is its
 * millisecond timestamp: the first 8 hex of two ids minted within the same ~65 s are identical, so
 * a head-derived number would collide on purchase_request_pr_number_uq / rfq_master_rfq_number_uq /
 * vendor_credit_note_number_uq (two vendor groups in one shortage run are minted in the same
 * millisecond). The last 12 hex are 16 counter bits + 32 random bits — the same suffix
 * cluster-inventory's RM batch numbers use (grn.service.ts shortId).
 */
export function autoNumberSuffix(id: string): string {
  return id.replace(/-/g, '').slice(-12).toUpperCase();
}
