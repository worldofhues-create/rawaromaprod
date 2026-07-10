/**
 * Create-body zod schemas for the user + security tables (user, role, permission,
 * role↔permission, user↔role, location authority). Dictionary columns only — the service
 * sets created_by/updated_by/status. `passwordHash` is provided directly for now; the
 * auth service will own credential minting later.
 */
import { z } from 'zod';

export const createUserBody = z
  .object({
    organizationId: z.string().uuid().optional(),
    employeeCode: z.string().optional(),
    userName: z.string(),
    email: z.string(),
    mobileNumber: z.string().optional(),
    // Provide EITHER a plaintext `password` (hashed server-side with Argon2id — the browser path)
    // OR a pre-computed `passwordHash`. At least one is required so the user can authenticate.
    password: z.string().min(8).max(200).optional(),
    passwordHash: z.string().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((b) => !!(b.password || b.passwordHash), {
    message: 'A password (or passwordHash) is required.',
    path: ['password'],
  });
export type CreateUserBody = z.infer<typeof createUserBody>;

export const createRoleBody = z.object({
  roleCode: z.string(),
  roleName: z.string(),
  description: z.string().optional(),
});
export type CreateRoleBody = z.infer<typeof createRoleBody>;

export const createPermissionBody = z.object({
  permissionCode: z.string(),
  permissionName: z.string(),
  moduleName: z.string().optional(),
});
export type CreatePermissionBody = z.infer<typeof createPermissionBody>;

export const createRolePermissionBody = z.object({
  roleId: z.string().uuid(),
  permissionId: z.string().uuid(),
});
export type CreateRolePermissionBody = z.infer<typeof createRolePermissionBody>;

export const createUserRoleBody = z.object({
  userId: z.string().uuid(),
  roleId: z.string().uuid(),
});
export type CreateUserRoleBody = z.infer<typeof createUserRoleBody>;

export const createLocationAuthorityBody = z.object({
  locationId: z.string().uuid().optional(),
  authorityUserId: z.string().uuid().optional(),
  authorityRoleId: z.string().uuid().optional(),
  authorityType: z.string(),
  effectiveFromDt: z.string().datetime().optional(),
  effectiveToDt: z.string().datetime().optional(),
});
export type CreateLocationAuthorityBody = z.infer<typeof createLocationAuthorityBody>;
