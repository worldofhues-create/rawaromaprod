// Lane pf-d (production floor P5 + the QC review gap, 2026-11-07) — the permissions behind order
// intelligence (stock cover suggestions) and the QC review decision, and which existing roles hold
// them. `owner` holds all of them through its blanket grant.
//
// The QC review is signed by two people (plan 12.7.4): the perfumer (`formulator`) and the
// `vault_approver`. Each holds only its own signature, so one role cannot decide a review alone;
// qc and production read the review but sign nothing. These are `production:` permissions on
// purpose: qc's blanket `quality:*` grant must not sweep a signature in.
export const PFD_PERMISSIONS = [
  'production:cover_plan:read',
  'production:cover_plan:write',
  'production:qc_review:approve',
  'production:qc_review:perfumer',
  'production:qc_review:read',
  'production:qc_review_setup:write',
] as const;

const GRANTS: Record<string, readonly string[]> = {
  admin: ['production:cover_plan:read', 'production:cover_plan:write', 'production:qc_review:read', 'production:qc_review_setup:write'],
  production: ['production:cover_plan:read', 'production:cover_plan:write', 'production:qc_review:read'],
  procurement: ['production:cover_plan:read'],
  qc: ['production:qc_review:read'],
  formulator: ['production:qc_review:read', 'production:qc_review:perfumer'],
  vault_approver: ['production:qc_review:read', 'production:qc_review:approve', 'production:qc_review_setup:write'],
};

/** true -> `role` holds `permission` under lane pf-d's grants. */
export const pfdGrant = (role: string) => (permission: string) => (GRANTS[role] ?? []).includes(permission);
