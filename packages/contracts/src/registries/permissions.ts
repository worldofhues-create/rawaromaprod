import { z } from 'zod';

/**
 * Permission registry. Convention: `domain:resource:action`.
 * A permission MUST be registered here before any backend route or frontend guard uses it
 * (lint rule downstream). The DB (`iam.permissions`) is the runtime store; this is the typed source.
 */
export const PERMISSIONS = [
  // identity / admin
  'iam:user:read',
  'iam:user:write',
  'iam:user:suspend',
  'iam:role:read',
  'iam:role:write',
  'iam:permission:assign',
  'iam:org:read',
  'iam:org:write',
  'iam:session:read',
  'iam:session:revoke',
  'iam:audit:read',
  // platform / control plane
  'platform:flag:read',
  'platform:flag:write',
  'platform:geo:read',
  'platform:geo:write',
  'platform:master:read',
  'platform:master:write',
  'platform:theme:write',
  'platform:content:write',
] as const;

export const permission = z.enum(PERMISSIONS);
/**
 * A permission key (`domain:resource:action`). The @core base keys (iam + platform)
 * autocomplete; domain clusters pass their OWN keys (declared in their `@ra/contracts-*`
 * registries, e.g. MASTERDATA_PERMISSIONS) — the type stays OPEN so @core need not
 * enumerate domain keys (the one-way tier boundary). The PermissionsGuard checks
 * set-membership against the caller's granted permissions at runtime, not this type; the
 * RBAC seed composes `[...PERMISSIONS, ...domainPermissions]` into the iam catalog.
 */
export type Permission = (typeof PERMISSIONS)[number] | (string & {});

/** The 7 Phase-1 portals — every JWT carries one as its audience claim. */
export const PORTALS = [
  'buyer',
  'owner',
  'builder',
  'inspector',
  'ops',
  'finance',
  'admin',
] as const;
export const portal = z.enum(PORTALS);
export type Portal = z.infer<typeof portal>;
