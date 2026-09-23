/**
 * IAM.APPROVAL_MATRIX (Phase-1A Data Dictionary revision — §87 autonomous decision defaults,
 * lane F8/rp-policy, docs/PHASE1B_SCHEMA_PROPOSAL.md "iam.approval_matrix — ADOPTED").
 *
 * The per-organisation approval-policy governance table: ProcAnalyticsService.approvalMatrix()
 * (backend/api/src/procanalytics) had already documented the intended shape (informational
 * "who approves what" governance view) but the table never existed — lane F5 (RP-DEADTABLES)
 * left it as an honest NotImplementedException. Lane F8 adopts a MINIMAL slice of that table now
 * (organisation-scoped policy KEY → VALUE rows) because §87 requires two concrete configurable
 * policies with nowhere else to live:
 *
 *   - PO_APPROVAL_THRESHOLD — the amount at/above which a purchase order needs a SECOND, distinct
 *     approver (thresholdAmount). Replaces the hardcoded ₹5,00,000 previously in po.service.ts.
 *     No row for an organisation → no configured threshold → the pre-existing single-approval
 *     path applies (never auto-approved just because a default was missing).
 *   - RFQ_AWARD_SEPARATION — whether the RFQ's award approver must differ from its creator
 *     (isEnabled). No row for an organisation → the conservative default (separation enforced)
 *     applies per §87 ("Default conservative policy: separate creator from final award approver
 *     where roles permit").
 *
 * This is additive and does not collide with the richer "who creates/submits/approves/final
 * authority/auto-approval per transaction type" governance table ProcAnalyticsService's comment
 * describes — that richer shape can be layered on top of this same table (more policyType rows,
 * or extra nullable columns) without a breaking migration; the analytics read-path
 * (ProcAnalyticsService.approvalMatrix) is deliberately left as NotImplementedException by this
 * lane since building that full read view is out of §87's scope.
 */
import { index, numeric, uniqueIndex, uuid, varchar, boolean } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { iam } from "./_schema.js";
import { orgMaster } from "./org.js";

/** IAM.APPROVAL_MATRIX */
export const approvalMatrix = iam.table(
  "approval_matrix",
  {
    approvalMatrixId: dictPk("approval_matrix_id"),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => orgMaster.organizationId),
    /** e.g. 'PO_APPROVAL_THRESHOLD', 'RFQ_AWARD_SEPARATION'. */
    policyType: varchar("policy_type", { length: 50 }).notNull(),
    /** Used by PO_APPROVAL_THRESHOLD — amount at/above which a second approver is required. */
    thresholdAmount: numeric("threshold_amount", { precision: 18, scale: 4 }),
    /** Used by RFQ_AWARD_SEPARATION — true = award approver must differ from the RFQ creator. */
    isEnabled: boolean("is_enabled"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("approval_matrix_org_policy_uq").on(t.organizationId, t.policyType),
    index("approval_matrix_org_idx").on(t.organizationId),
  ],
);
