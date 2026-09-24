// RA role catalog — the role → permission-subset matrix seeded into iam.role_master +
// role_permission_mapping. Each role's `select(permissionCode)` decides which of the 263
// RA_PERMISSIONS it is granted. Phase-1 roles mirror the portal design 1:1.
//
// HARD invariants enforced by the seed:
//   - only `owner` (Super Admin) may hold `formula:actual:read` (the decrypted recipe).
//   - ROLE GRANTING (`iam:user_role_mapping:write`) is held ONLY by `owner` + `admin`. Every
//     operational role gets ZERO `iam:*` perms, so a floor/qc/procurement user can never assign
//     a role. "Only an admin can give the role." (Asserted in db-seed.ts.)
//
// Masking: roles WITHOUT `masterdata:material:reveal` receive alias-masked responses (the
// MaterialMaskingInterceptor). compounding + filling are masked ("ratios you cannot decode" /
// "never a recipe"); admin is masked too (governs access, never sees materials/formulas).

/** A user provisioned alongside a role so the role is immediately testable (optional). */
export interface RoleDef {
  code: string;
  name: string;
  /** the design's screen key this role maps to (owner → the superadmin controller view). */
  view: string;
  /** true → grant this permission code to the role. */
  select: (permissionCode: string) => boolean;
  /** sample login email for this role (created only when its password env var is set). */
  sampleEmail: string;
  /** env var holding the sample user's password. */
  passwordEnv: string;
}

const startsWith = (prefix: string) => (p: string) => p.startsWith(prefix);
const isRead = (p: string) => p.endsWith(':read');
const oneOf =
  (...perms: string[]) =>
  (p: string) =>
    perms.includes(p);
const anyOf =
  (...preds: Array<(p: string) => boolean>) =>
  (p: string) =>
    preds.some((f) => f(p));

const REVEAL = 'masterdata:material:reveal';

/** The one permission NO role but `formulator`/`vault_approver` may hold — enforced by the
 * seed. Vault Authority (§107): "tenant_owner/admin/factory_admin/platform_super_admin: NO
 * implicit formula plaintext. Vault authority is separately granted." `owner` below is
 * deliberately full-access MINUS this one permission — god-mode stops at the vault door.
 * Exported so scripts/db-seed.ts can assert the invariant. */
export const VAULT_PLAINTEXT_PERMISSION = 'formula:actual:read';

/**
 * Every formula:*-domain WRITE permission that constitutes drafting or a Vault-authority
 * DECISION — sealing ingredients (whole-recipe or per-stage), authoring a formula/version,
 * approving/rejecting/locking, or granting/deciding per-formula access — held ONLY by
 * `formulator`/`vault_approver` (§107/§108, security review item 2). `owner`'s blanket grant
 * excludes every permission in this set explicitly, on top of the vault:* / formula:actual:read
 * exclusion above: "god-mode stops at the vault door" means owner may see THAT a formula/
 * version/policy exists (the matching `:read` permissions are NOT in this set, and stay
 * granted) but can never draft, seal, approve, reject, lock, or grant/copy-request a
 * formula's protected content. `formula:formula_type_master:write` is deliberately NOT in
 * this set — it is plain taxonomy (e.g. "Eau de Parfum"), held by no Vault role, and
 * excluding it here would leave it unassignable to any seeded role.
 *
 * scripts/db-seed.ts asserts this as a hard invariant: no role outside
 * VAULT_PLAINTEXT_ROLES may hold any permission in this set.
 */
export const FORMULA_DECISION_PERMISSIONS: ReadonlySet<string> = new Set([
  'formula:formula_master:write',
  'formula:formula_version:write',
  'formula:formula_ingredients:write',
  'formula:formula_stage_master:write',
  'formula:formula_stage_ingredients:write',
  'formula:formula_document_mapping:write',
  'formula:formula_copy_request:write',
  'formula:formula_approval:write',
  'formula:formula_access_policy:write',
]);

/** §108 SoD, made a hard seed invariant (security review item 2): `formulator` (drafting)
 * must never hold an approve/lock/access-policy DECISION permission, and `vault_approver`
 * (review/decision) must never hold a drafting/seal WRITE permission. The two Vault roles'
 * `select` predicates below already keep to this split; these two lists let db-seed.ts
 * assert it rather than leave it implicit. */
export const FORMULATOR_FORBIDDEN_PERMISSIONS: ReadonlySet<string> = new Set([
  'formula:formula_approval:write',
  'formula:formula_access_policy:write',
]);
export const VAULT_APPROVER_FORBIDDEN_PERMISSIONS: ReadonlySet<string> = new Set([
  'formula:formula_master:write',
  'formula:formula_ingredients:write',
  'formula:formula_stage_master:write',
  'formula:formula_stage_ingredients:write',
]);

/** Platform Ops console read (§6/§113, this lane) — tenant/org list, environment/outbox
 * health, provider status, build identity. Deliberately its OWN domain prefix
 * (`platformops:`, not `platform:`) so it can never be swept in by an existing role's
 * broader `startsWith('platform:')` grant (procurement/sales both read `platform:*`
 * reference data — country/contact/document masters — and must NOT thereby gain Platform
 * Ops access). Held ONLY by `platform_super_admin`, explicitly excluded below from
 * `owner`'s otherwise-blanket grant — tenant authority and platform-operations authority
 * are separate domains (same split §108 draws for Vault authority): owning the tenant does
 * not mean owning the platform's own operational console. */
export const PLATFORM_OPS_PERMISSION = 'platformops:console:read';

/** §109.7 manufacturing-instruction read (security review item 4) — the ONE formula-derived
 * read the factory floor gets (coded material + a per-batch QUANTITY, never material_id or
 * the raw recipe percentage — see FormulaLookupService.resolveManufacturingInstruction).
 * P0 DECISION: quantities are operationally required for weigh/dispense, so the route stays,
 * but access is deliberately narrower than the ordinary `production:production_order:read`
 * it used to piggyback on — held ONLY by the two roles that actually weigh/dispense
 * (`production`, `compounding`). Explicitly NOT `owner` (oversight doesn't need the resolved
 * quantities), NOT `filling` (downstream of compounding, never touches raw material weighing),
 * and no other role. */
export const MANUFACTURING_INSTRUCTION_PERMISSION = 'production:manufacturing_instruction:read';
export const MANUFACTURING_INSTRUCTION_ROLES = ['production', 'compounding'];

/** G1/PB-08 (FINAL_OS §2.3/§41, ledger PB-08) — RawProd must not be an independent commercial-
 * order writer. Sales orders should originate from the ALEMBIC bridge; POST /v1/sales-orders,
 * its /:id/confirm, and POST /v1/sales-order-items (OrdersController) are now a break-glass
 * MANUAL CONTINUITY path, gated on this permission instead of the ordinary
 * `sales:sales_order(_items):write`. Held ONLY by owner/admin — deliberately EXCLUDED from
 * `sales`'s otherwise-blanket `startsWith('sales:')` grant below (same shape as
 * PLATFORM_OPS_PERMISSION/MANUFACTURING_INSTRUCTION_PERMISSION: a narrow permission that must
 * not be swept in by a broader prefix grant), and never held by any other factory role. */
export const MANUAL_CONTINUITY_PERMISSION = 'sales:manual_continuity:write';
export const MANUAL_CONTINUITY_ROLES = ['owner', 'admin'];

export const ROLES: RoleDef[] = [
  {
    // Super Admin — full access EXCEPT the decrypted recipe (§107: no implicit vault
    // plaintext, even for the owner role — Vault authority is a separate grant, held only by
    // `formulator`/`vault_approver` below), EXCEPT any OTHER `vault:*`-prefixed permission
    // (same rule, generalized — the guard's own NEVER_IMPLICIT_PATTERNS treats the whole
    // `vault:` prefix as never-implicit for the super_admin BYPASS; this mirrors that for
    // owner's blanket SEED grant, so a future `vault:*` permission can't slip into owner's
    // "everything" just because nobody remembered to list it here too), EXCEPT every
    // FORMULA_DECISION_PERMISSIONS write (§107/§108, security review item 2 — owner keeps
    // formula:*:read for oversight, but can never draft/seal/approve/reject/lock/grant a
    // formula), AND EXCEPT the Platform Ops console (§113: a separate operational authority
    // from tenant ownership — see PLATFORM_OPS_PERMISSION's doc comment).
    //
    // Can still ASSIGN the two Vault roles (formulator/vault_approver) to a user, despite
    // holding none of their permissions itself — that is NOT the ordinary "grant a role whose
    // permissions are a subset of your own" path (SecurityService.createUserRole), which
    // owner could never satisfy for these two roles; it is a separate, explicit allow-list
    // EXCEPTION carved out for exactly owner/admin, that also hard-refuses self-assignment
    // (security review item 6 — see VAULT_AUTHORITY_ROLES in
    // backend/cluster-org/src/security/security.service.ts).
    code: 'owner',
    name: 'Super Admin',
    view: 'superadmin',
    select: (p) =>
      p !== VAULT_PLAINTEXT_PERMISSION &&
      !p.startsWith('vault:') &&
      p !== PLATFORM_OPS_PERMISSION &&
      !FORMULA_DECISION_PERMISSIONS.has(p) &&
      p !== MANUFACTURING_INSTRUCTION_PERMISSION,
    sampleEmail: 'owner@rawaroma.local',
    passwordEnv: 'BOOTSTRAP_OWNER_PASSWORD',
  },
  {
    // Admin — Access & Governance. Manages users + assigns roles (iam:*). Never sees formulas
    // or product/material identities (no formula:*, no material:reveal → masked). Plus
    // (security review item 3) the finished-good trace read — admin is one of the roles that
    // legitimately runs GET /v1/trace/finished-good/:id (chain-of-custody oversight), but
    // WITHOUT masterdata:material:reveal it gets the masked view (no vendor identity, no
    // material list — see DashboardService.traceFinishedGood).
    code: 'admin',
    name: 'Admin',
    view: 'admin',
    // G1/PB-08: admin is one of the two roles allowed to hold the sales manual-continuity
    // break-glass permission (owner is the other, via its blanket grant below).
    select: anyOf(
      startsWith('iam:'),
      oneOf('packaging:finished_good_batch_master:read', MANUAL_CONTINUITY_PERMISSION),
    ),
    sampleEmail: 'admin@rawaroma.local',
    passwordEnv: 'BOOTSTRAP_ADMIN_PASSWORD',
  },
  {
    // Procurement — POs/suppliers/materials. Sees real materials (reveal), never which perfume.
    code: 'procurement',
    name: 'Procurement',
    view: 'procurement',
    select: anyOf(
      startsWith('procurement:'),
      (p) => p.startsWith('masterdata:') && isRead(p),
      (p) => p.startsWith('platform:') && isRead(p),
      (p) => p.startsWith('location:') && isRead(p),
      oneOf('inventory:gate_entry_master:read', 'inventory:grn_master:read', REVEAL),
    ),
    sampleEmail: 'procurement@rawaroma.local',
    passwordEnv: 'BOOTSTRAP_PROCUREMENT_PASSWORD',
  },
  {
    // Receiving — deliveries, GRN, batch assignment. Sees real materials (reveal).
    code: 'receiving',
    name: 'Receiving',
    view: 'receiving',
    select: anyOf(
      oneOf(
        'inventory:gate_entry_master:read',
        'inventory:gate_entry_master:write',
        'inventory:gate_entry_documents:read',
        'inventory:gate_entry_documents:write',
        'inventory:grn_master:read',
        'inventory:grn_master:write',
        'inventory:grn_items:read',
        'inventory:grn_items:write',
        'inventory:grn_container:read',
        'inventory:grn_container:write',
        'inventory:rm_batch_master:read',
        'inventory:rm_batch_master:write',
        REVEAL,
      ),
      (p) => p.startsWith('procurement:') && isRead(p),
      (p) => p.startsWith('masterdata:') && isRead(p),
      (p) => p.startsWith('location:') && isRead(p),
    ),
    sampleEmail: 'receiving@rawaroma.local',
    passwordEnv: 'BOOTSTRAP_RECEIVING_PASSWORD',
  },
  {
    // QC Laboratory — incoming RM QC (quality:*) + production/oil-batch QC. Sees real (reveal).
    code: 'qc',
    name: 'QC Laboratory',
    view: 'qc',
    select: anyOf(
      startsWith('quality:'),
      oneOf(
        'production:production_qc:read',
        'production:production_qc:write',
        'production:oil_batch_master:read',
        'production:oil_batch_qc_history:read',
        'production:oil_batch_qc_history:write',
      ),
      oneOf(
        'inventory:rm_batch_master:read',
        'inventory:grn_master:read',
        'inventory:grn_items:read',
        'inventory:inventory_batch:read',
      ),
      oneOf('masterdata:material:read', 'masterdata:rm_alias:read', 'masterdata:material_qc_specifications:read', REVEAL),
      // Security review item 3 — QC legitimately traces a finished-good batch back to its
      // RM batches/GRN for a QC investigation. Already holds REVEAL above, so gets the
      // full (unmasked) trace view.
      oneOf('packaging:finished_good_batch_master:read'),
    ),
    sampleEmail: 'qc@rawaroma.local',
    passwordEnv: 'BOOTSTRAP_QC_PASSWORD',
  },
  {
    // Warehouse — storage, shelf map, stock, picks. Sees real codes/classes (reveal) + locations.
    code: 'warehouse',
    name: 'Warehouse',
    view: 'warehouse',
    select: anyOf(
      oneOf(
        'inventory:inventory_batch:read',
        'inventory:inventory_batch:write',
        'inventory:rm_batch_master:read',
        'inventory:inventory_status_master:read',
        'inventory:inventory_transaction:read',
        'inventory:inventory_transaction:write',
        'inventory:stock_adjustment:read',
        'inventory:stock_adjustment:write',
        'inventory:stock_reservation:read',
        'inventory:stock_reservation:write',
        'inventory:stock_transfer:read',
        'inventory:stock_transfer:write',
        'inventory:expiry_tracker:read',
        REVEAL,
      ),
      startsWith('location:'),
      (p) => p.startsWith('masterdata:') && isRead(p),
    ),
    sampleEmail: 'warehouse@rawaroma.local',
    passwordEnv: 'BOOTSTRAP_WAREHOUSE_PASSWORD',
  },
  {
    // Compounding — masked worksheets. Follows ratios it cannot decode. NO material:reveal →
    // every material_id in its responses is alias-masked. The canonical formula-protected floor.
    code: 'compounding',
    name: 'Compounding',
    view: 'compounding',
    select: anyOf(
      oneOf(
        'production:production_order:read',
        'production:production_order_ingredients:read',
        'production:manufacturing_instruction:read',
        'production:material_pick_list:read',
        'production:material_pick_list_items:read',
        'production:material_issue:read',
        'production:material_issue:write',
        'production:material_issue_item:read',
        'production:secure_mixing_session:read',
        'production:secure_mixing_session:write',
        'production:mixing_step_log:read',
        'production:mixing_step_log:write',
        'production:oil_batch_master:read',
        'production:oil_batch_master:write',
        'production:oil_batch_consumption:read',
        'production:oil_batch_event_history:read',
      ),
      oneOf('masterdata:rm_alias:read', 'inventory:inventory_batch:read'),
      (p) => p.startsWith('location:') && isRead(p),
    ),
    sampleEmail: 'compounding@rawaroma.local',
    passwordEnv: 'BOOTSTRAP_COMPOUNDING_PASSWORD',
  },
  {
    // Production (Manufacturing/QC oversight — owner override 2026-09-21, ERP_BOUNDARY lifted:
    // manufacturing/QC is in scope for RawProd). Plans and schedules production (the one write
    // surface no floor role held before this role existed — production_plan/production_order/
    // material_pick_list write sat with `owner` only) and holds read-only oversight across the
    // floor + QC outcome, without performing the floor actions themselves: no
    // secure_mixing_session:write / material_issue:write (compounding executes), no
    // production_qc:write / quality:* write (qc executes/remediates). NO material:reveal → masked
    // (same Formula Vault boundary as compounding/filling: plans runs by masked alias, never sees
    // the actual recipe).
    code: 'production',
    name: 'Production Manager',
    view: 'production',
    select: anyOf(
      oneOf(
        'production:production_plan:read',
        'production:production_plan:write',
        'production:production_plan_items:read',
        'production:production_plan_items:write',
        'production:production_order:read',
        'production:production_order:write',
        'production:production_order_ingredients:read',
        'production:manufacturing_instruction:read',
        'production:material_pick_list:read',
        'production:material_pick_list:write',
        'production:material_pick_list_items:read',
        'production:material_issue:read',
        'production:material_issue_item:read',
        'production:secure_mixing_session:read',
        'production:mixing_step_log:read',
        'production:oil_batch_master:read',
        'production:oil_batch_consumption:read',
        'production:oil_batch_event_history:read',
        'production:oil_batch_qc_history:read',
        'production:production_qc:read',
      ),
      oneOf(
        'quality:qc_capa:read',
        'quality:qc_inspections:read',
        'quality:qc_result_details:read',
        'quality:qc_disposition:read',
      ),
      oneOf('masterdata:rm_alias:read', 'inventory:inventory_batch:read'),
      (p) => p.startsWith('location:') && isRead(p),
    ),
    sampleEmail: 'production@rawaroma.local',
    passwordEnv: 'BOOTSTRAP_PRODUCTION_PASSWORD',
  },
  {
    // Filling — fill tickets from finished juice + a target volume. Sees a code + a quantity,
    // never a recipe → NO material:reveal (masked).
    code: 'filling',
    name: 'Filling',
    view: 'filling',
    select: anyOf(
      oneOf(
        'production:oil_batch_master:read',
        'production:production_order:read',
        'packaging:package_order:read',
        'packaging:package_order_item:read',
        'packaging:filling_session:read',
        'packaging:filling_session:write',
        'packaging:filling_session_details:read',
        'packaging:filling_session_details:write',
        'packaging:product_sku:read',
      ),
      (p) => p.startsWith('location:') && isRead(p),
    ),
    sampleEmail: 'filling@rawaroma.local',
    passwordEnv: 'BOOTSTRAP_FILLING_PASSWORD',
  },
  {
    // Packaging — labels + finished goods. The product NAME surfaces here for the first time
    // (to print the label) → reveal granted.
    code: 'packaging',
    name: 'Packaging',
    view: 'packaging',
    select: anyOf(
      startsWith('packaging:'),
      oneOf('production:oil_batch_master:read', 'sales:dispatch_master:read', 'sales:dispatch_items:read', REVEAL),
      (p) => p.startsWith('masterdata:') && isRead(p),
      (p) => p.startsWith('location:') && isRead(p),
    ),
    sampleEmail: 'packaging@rawaroma.local',
    passwordEnv: 'BOOTSTRAP_PACKAGING_PASSWORD',
  },
  {
    // Sales & Dispatch — customers, sales orders, dispatch. Sees finished-goods product identity
    // (reveal) to fulfil orders; never sees upstream formulas/materials beyond FG.
    code: 'sales',
    name: 'Sales & Dispatch',
    view: 'sales',
    // G1/PB-08: `sales:manual_continuity:write` is deliberately carved OUT of the blanket
    // `startsWith('sales:')` grant below — this role creates/confirms sales orders through the
    // ordinary sales_order(_items):write permission only; the break-glass continuity path is
    // owner/admin-only (MANUAL_CONTINUITY_ROLES).
    select: anyOf(
      (p) => p.startsWith('sales:') && p !== MANUAL_CONTINUITY_PERMISSION,
      oneOf(
        'packaging:finished_good_batch_master:read',
        'packaging:product_master:read',
        'packaging:product_sku:read',
        REVEAL,
      ),
      (p) => p.startsWith('masterdata:') && isRead(p),
      (p) => p.startsWith('platform:') && isRead(p),
      (p) => p.startsWith('location:') && isRead(p),
    ),
    sampleEmail: 'sales@rawaroma.local',
    passwordEnv: 'BOOTSTRAP_SALES_PASSWORD',
  },
  {
    // Formulator — Vault authority, drafting side (§107). Creates/edits DRAFT formulas +
    // versions, reads plaintext (VAULT_PLAINTEXT_PERMISSION) within a granted scope — own
    // formulas, or an explicit FORMULA_ACCESS_POLICY grant; enforced per-formula by
    // FormulasService.assertFormulaAccess, not by this coarse permission alone. Cannot
    // approve/reject — no formula:formula_approval:*, the SoD complement of `vault_approver`
    // (§108: "Formula author cannot final-approve same protected version"); the approve/
    // reject ENDPOINTS also independently re-check the actor isn't the version's author.
    code: 'formulator',
    name: 'Formulator',
    view: 'vault_formulator',
    select: oneOf(
      'formula:formula_master:read',
      'formula:formula_master:write',
      'formula:formula_version:read',
      'formula:formula_version:write',
      'formula:formula_ingredients:read',
      'formula:formula_ingredients:write',
      'formula:formula_stage_master:read',
      'formula:formula_stage_master:write',
      'formula:formula_stage_ingredients:write',
      'formula:formula_type_master:read',
      'formula:formula_access_policy:read',
      'formula:formula_document_mapping:read',
      'formula:formula_document_mapping:write',
      'formula:formula_change_log:read',
      'formula:formula_event_hist:read',
      'formula:formula_copy_request:read',
      'formula:formula_copy_request:write',
      'vault:material_search:read',
      VAULT_PLAINTEXT_PERMISSION,
    ),
    sampleEmail: 'formulator@rawaroma.local',
    passwordEnv: 'BOOTSTRAP_FORMULATOR_PASSWORD',
  },
  {
    // Vault Approver — Vault authority, review side (§107). Reviews an authorized formula
    // (plaintext, to actually review it) and drives the §109.8 lifecycle's decision half:
    // approve/reject (DRAFT|VERSIONED|REVIEW → APPROVED/REJECTED) and lock (APPROVED →
    // LOCKED), all under `formula:formula_approval:write`. Supersede is automatic — approving
    // a formula's successor version flips its prior current version to SUPERSEDED, so it
    // needs no permission of its own. No formula:formula_master/ingredients:write — cannot
    // author or edit a draft's contents (SoD complement of `formulator`).
    code: 'vault_approver',
    name: 'Vault Approver',
    view: 'vault_approver',
    select: oneOf(
      'formula:formula_master:read',
      'formula:formula_version:read',
      'formula:formula_version:write',
      'formula:formula_ingredients:read',
      'formula:formula_stage_master:read',
      'formula:formula_type_master:read',
      'formula:formula_approval:read',
      'formula:formula_approval:write',
      'formula:formula_access_policy:read',
      'formula:formula_access_policy:write',
      'formula:formula_change_log:read',
      'formula:formula_event_hist:read',
      'formula:formula_copy_request:read',
      'formula:formula_copy_request:write',
      'vault:material_search:read',
      VAULT_PLAINTEXT_PERMISSION,
    ),
    sampleEmail: 'vault.approver@rawaroma.local',
    passwordEnv: 'BOOTSTRAP_VAULT_APPROVER_PASSWORD',
  },
  {
    // Platform Super Admin — platform operations only (§106 UI, this launch's Platform Ops
    // console): feature-flag kill-switches + support/audit tooling built from EXISTING
    // platform-cluster endpoints, plus (this lane, §6/§113) `platformops:console:read` —
    // tenant/org list (identity+status only), db/outbox environment health, connector/
    // provider status (never secrets), and build identity. Deliberately NOT full tenant
    // access: no formula:*, no iam:role_permission_mapping/user_role_mapping:write (cannot
    // grant itself tenant roles — "Platform admin does not bypass tenant business/Vault
    // authorization", §108), no masterdata:material:reveal. iam:user_master:read is the
    // narrowest existing permission that gates GET /v1/login-history (support/audit tooling)
    // — see web-platform's Not-Built note for what platform ops UI is intentionally NOT
    // built for lack of a route.
    code: 'platform_super_admin',
    name: 'Platform Super Admin',
    view: 'platform_ops',
    select: oneOf('platform:flag:write', 'iam:user_master:read', PLATFORM_OPS_PERMISSION),
    sampleEmail: 'platform.admin@rawaroma.local',
    passwordEnv: 'BOOTSTRAP_PLATFORM_ADMIN_PASSWORD',
  },
];

/** Roles allowed to hold VAULT_PLAINTEXT_PERMISSION — everyone else is rejected by the seed,
 * `owner` included (§107: "NO implicit formula plaintext. Vault authority is separately
 * granted."). */
export const VAULT_PLAINTEXT_ROLES = ['formulator', 'vault_approver'];

/** Roles allowed to hold PLATFORM_OPS_PERMISSION — everyone else is rejected by the seed,
 * `owner` included (§113: Platform Ops is a separate operational authority from tenant
 * ownership, same split as Vault authority above). */
export const PLATFORM_OPS_ROLES = ['platform_super_admin'];

/** The role-granting permission. Only owner + admin may hold it — asserted by the seed. */
export const ROLE_GRANT_PERMISSION = 'iam:user_role_mapping:write';

/** Roles allowed to hold ROLE_GRANT_PERMISSION (everyone else is rejected by the seed). */
export const ROLE_GRANTERS = ['owner', 'admin'];

/**
 * Capability permissions — NOT guarded on any route (so they aren't in the grep-generated
 * RA_PERMISSIONS), but seeded into permission_master so roles can be granted them and the JWT
 * carries them. `masterdata:material:reveal` exempts a caller from the MaterialMaskingInterceptor.
 */
export const CAPABILITY_PERMISSIONS: string[] = ['masterdata:material:reveal'];
