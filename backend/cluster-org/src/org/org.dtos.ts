/**
 * Create-body zod schemas for the organization tables (org group/type/org/relationship,
 * business unit). Dictionary columns only — the service sets created_by/updated_by/status.
 */
import { z } from 'zod';

export const createOrgGroupBody = z.object({
  orgGroupCode: z.string(),
  orgGroupName: z.string(),
});
export type CreateOrgGroupBody = z.infer<typeof createOrgGroupBody>;

export const createOrgTypeBody = z.object({
  orgTypeCode: z.string(),
  orgTypeName: z.string(),
});
export type CreateOrgTypeBody = z.infer<typeof createOrgTypeBody>;

export const createOrgBody = z.object({
  orgGroupId: z.string().uuid().optional(),
  orgTypeId: z.string().uuid().optional(),
  organizationCode: z.string(),
  organizationName: z.string(),
  registrationCountryId: z.string().uuid().optional(),
  baseCurrencyId: z.string().uuid().optional(),
  defaultTimezoneId: z.string().uuid().optional(),
  defaultLanguageId: z.string().uuid().optional(),
});
export type CreateOrgBody = z.infer<typeof createOrgBody>;

export const createOrgRelationshipBody = z.object({
  organizationId: z.string().uuid(),
  relatedOrganizationId: z.string().uuid(),
  relationshipType: z.string(),
});
export type CreateOrgRelationshipBody = z.infer<typeof createOrgRelationshipBody>;

export const createBusinessUnitBody = z.object({
  organizationId: z.string().uuid(),
  parentBusinessUnitId: z.string().uuid().optional(),
  businessUnitCode: z.string(),
  businessUnitName: z.string(),
});
export type CreateBusinessUnitBody = z.infer<typeof createBusinessUnitBody>;
