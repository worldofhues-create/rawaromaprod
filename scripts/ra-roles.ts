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

export const ROLES: RoleDef[] = [
  {
    // Super Admin — full access; the only role holding formula:actual:read + can grant roles.
    code: 'owner',
    name: 'Super Admin',
    view: 'superadmin',
    select: () => true,
    sampleEmail: 'owner@rawaroma.local',
    passwordEnv: 'BOOTSTRAP_OWNER_PASSWORD',
  },
  {
    // Admin — Access & Governance. Manages users + assigns roles (iam:*). Never sees formulas
    // or product/material identities (no formula:*, no material:reveal → masked).
    code: 'admin',
    name: 'Admin',
    view: 'admin',
    select: startsWith('iam:'),
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
];

/** The one permission no role but owner may hold — enforced by the seed. */
export const OWNER_ONLY_PERMISSION = 'formula:actual:read';

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
