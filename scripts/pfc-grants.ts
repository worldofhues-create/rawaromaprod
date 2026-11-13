// Lane pf-c (production floor P3/P4, 2026-11-05) — the permissions behind devices, print jobs,
// maceration, the packing and logistics stations and the courier connectors, and which existing
// roles hold them. `owner` holds all of them through its blanket grant. Lane A's floor roles
// packing and logistics hold the station permissions.
//
// Early maceration release is admin-only by the plan (section 8): owner and admin, nobody else.
// PROM-2 (LD-85): an early release is Stop, second person. QC and production may ASK for it
// (release_early_request); the owner and admin APPROVE it (release_early), never their own request.
export const PFC_PERMISSIONS = [
  'packaging:packing_station:write',
  'platform:courier_connector:read',
  'platform:courier_connector:write',
  'platform:device:read',
  'platform:device:write',
  'platform:print_job:read',
  'platform:print_job:write',
  'production:maceration:read',
  'production:maceration:release_early',
  'production:maceration:release_early_request',
  'production:maceration:write',
  'production:maceration_setting:write',
  'sales:logistics:write',
  'sales:shipment:read',
] as const;

const GRANTS: Record<string, readonly string[]> = {
  admin: [
    'platform:device:read', 'platform:device:write', 'platform:print_job:read',
    'platform:courier_connector:read', 'platform:courier_connector:write',
    'production:maceration:read', 'production:maceration_setting:write', 'production:maceration:release_early',
    'production:maceration:release_early_request', 'sales:shipment:read',
  ],
  production: ['platform:device:read', 'platform:print_job:read', 'platform:print_job:write', 'production:maceration:read', 'production:maceration:write',
    'production:maceration:release_early_request'],
  qc: ['production:maceration:read', 'platform:print_job:read', 'platform:print_job:write', 'production:maceration:release_early_request'],
  // SCAN-9 (owner: every step of both flows prints its label): the raw-flow steps belong to these
  // roles (PO, gate entry, receiving audit, GRN, incoming QC). Print rights only: a label carries the
  // opaque id the next step scans, never a name, CAS or percentage (the renderer refuses those).
  procurement: ['platform:print_job:read', 'platform:print_job:write'],
  receiving: ['platform:print_job:read', 'platform:print_job:write'],
  warehouse: ['platform:print_job:read', 'platform:print_job:write'],
  packaging: ['platform:print_job:read', 'platform:print_job:write', 'sales:shipment:read', 'production:maceration:read'],
  sales: ['platform:print_job:read', 'platform:print_job:write', 'sales:shipment:read', 'sales:logistics:write', 'platform:courier_connector:read'],
  // Lane A's floor roles (PROD-A-3).
  packing: ['platform:print_job:read', 'platform:print_job:write', 'sales:shipment:read', 'packaging:packing_station:write', 'production:maceration:read'],
  logistics: ['platform:print_job:read', 'platform:print_job:write', 'sales:shipment:read', 'sales:logistics:write', 'platform:courier_connector:read'],
};

/** true -> `role` holds `permission` under lane pf-c's grants. */
export const pfcGrant = (role: string) => (permission: string) => (GRANTS[role] ?? []).includes(permission);
