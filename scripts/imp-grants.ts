// IMPORT-RP (13 Nov 2026) — the permissions behind the spreadsheet imports, and which existing roles
// hold them. `owner` holds every one that is not `vault:` through its blanket grant.
//
// THE RULE: one permission per import kind, held by EXACTLY the roles that hold the single-record
// action it mirrors, so a sheet can never do what the form cannot. IMPORT_MIRRORS below is that pairing
// and backend/api/src/__tests__/imports-permissions.test.ts asserts it for every role.
//
// A RELEASE MUST RE-RUN THE RBAC SEED (`pnpm db:seed`) so these reach iam.permission_master and the
// role mappings; until it does, only nobody holds them (a new permission is granted to no role by
// default, the owner included: the owner's grant is written by the seed).
export const IMP_PERMISSIONS = [
  // What a dilution is made of (masterdata.material_dilution): the single-record route and its list.
  'masterdata:material_dilution:read',
  'masterdata:material_dilution:write',
  // The import kinds. `masterdata:material_import:write` (ingredients) is STOCK-FIX-RP's, in stk-grants.
  'masterdata:material_dilution_import:write',
  'procurement:vendor_import:write',
  'inventory:grn_import:write',
  'inventory:rm_batch_import:write',
  'inventory:stock_adjustment_import:write',
  'packaging:packaging_material_import:write',
  // The Vault's formulas import. `vault:` so that no blanket grant reaches it (the owner's excludes
  // every vault:* permission) and so that it rides in the access token, as the Vault box needs.
  'vault:formula_import:write',
  // IMPORT-RP-COST (LD-156): a material's purchase price, read and recorded. One write permission for
  // the sheet and the screen: purchasing (through its procurement:* grant) and finance (below).
  'procurement:material_purchase_price:read',
  'procurement:material_purchase_price:write',
] as const;

/** import permission -> the single-record permission whose holders it must match exactly. */
export const IMPORT_MIRRORS: Record<string, string> = {
  // Procurement knows the real material: it files it under a family (floor_code:write) and imports it
  // (STOCK-FIX-RP, STK-17). The same people record what a dilution is made of.
  'masterdata:material_import:write': 'masterdata:floor_code:write',
  'masterdata:material_dilution:write': 'masterdata:floor_code:write',
  'masterdata:material_dilution_import:write': 'masterdata:material_dilution:write',
  'procurement:vendor_import:write': 'procurement:vendor_details:write',
  'inventory:grn_import:write': 'inventory:grn_master:write',
  'inventory:rm_batch_import:write': 'inventory:rm_batch_master:write',
  'inventory:stock_adjustment_import:write': 'inventory:stock_adjustment:write',
  'packaging:packaging_material_import:write': 'packaging:packaging_material_master:write',
  // Sealing a recipe is the formulator's alone; so is uploading one.
  'vault:formula_import:write': 'formula:formula_ingredients:write',
  // One permission for the sheet and for the single price typed on screen (LD-156): it mirrors itself.
  'procurement:material_purchase_price:write': 'procurement:material_purchase_price:write',
};

// procurement holds procurement:vendor_import:write, and packaging holds
// packaging:packaging_material_import:write, through their own whole-namespace grants (as they hold
// the single-record permissions); every masterdata reader holds masterdata:material_dilution:read the
// same way. Only what no existing rule gives is listed here.
const GRANTS: Record<string, readonly string[]> = {
  procurement: ['masterdata:material_dilution:write', 'masterdata:material_dilution_import:write'],
  receiving: ['inventory:grn_import:write', 'inventory:rm_batch_import:write'],
  warehouse: ['inventory:stock_adjustment_import:write'],
  formulator: ['vault:formula_import:write'],
  // Finance holds no procurement write but this one: it records and reads what a material costs.
  finance: ['procurement:material_purchase_price:read', 'procurement:material_purchase_price:write'],
};

/** true -> `role` holds `permission` under IMPORT-RP's grants. */
export const impGrant = (role: string) => (permission: string) => (GRANTS[role] ?? []).includes(permission);
