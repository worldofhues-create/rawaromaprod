// STOCK-FIX-RP (13 Nov 2026) — the permissions behind the oil ledger (STK-10, STK-11), the mixer's
// scoped name reveal (STK-15, D-1 / LD-35) and the raw-material import (STK-17), and which existing
// roles hold them. `owner` holds all of them through its blanket grant.
//
// Writing oil off is its own permission so the role that may do it is named: the production manager
// and admin, never the floor or packing. The mixer's reveal is NOT masterdata:material:reveal (which
// would show every material everywhere): it is honoured only by the mix station, for the current step
// of an active batch, to the mixer assigned to it (floor-station.service.ts).
export const STK_PERMISSIONS = [
  'production:oil_batch_balance:read',
  'production:oil_batch_remnant:write',
  'production:oil_batch:write_off',
  'production:floor_mix:reveal_name',
  'masterdata:material_import:write',
] as const;

const GRANTS: Record<string, readonly string[]> = {
  admin: ['production:oil_batch_balance:read', 'production:oil_batch_remnant:write', 'production:oil_batch:write_off'],
  production: ['production:oil_batch_balance:read', 'production:oil_batch_remnant:write', 'production:oil_batch:write_off'],
  compounding: ['production:oil_batch_balance:read', 'production:oil_batch_remnant:write'],
  packaging: ['production:oil_batch_balance:read', 'production:oil_batch_remnant:write'],
  filling: ['production:oil_batch_balance:read'],
  packing: ['production:oil_batch_balance:read'],
  qc: ['production:oil_batch_balance:read'],
  mixer: ['production:floor_mix:reveal_name'],
  procurement: ['masterdata:material_import:write'],
};

/** true -> `role` holds `permission` under STOCK-FIX-RP's grants. */
export const stkGrant = (role: string) => (permission: string) => (GRANTS[role] ?? []).includes(permission);
