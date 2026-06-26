import { z } from 'zod';
import { uuid } from '../../primitives/ids.js';

export const orgType = z.enum(['builder', 'partner', 'internal']);
export const orgUnitType = z.enum(['branch', 'department', 'team']);
export const memberRole = z.enum(['owner', 'admin', 'member']);

export const organization = z.object({
  id: uuid,
  type: orgType,
  name: z.string().min(1).max(160),
  reraNo: z.string().nullable(),
  gstin: z.string().nullable(),
  status: z.string(),
});
export const createOrgRequest = organization.pick({ type: true, name: true, reraNo: true, gstin: true }).partial({ reraNo: true, gstin: true });

export const orgUnit = z.object({
  id: uuid,
  orgId: uuid,
  parentId: uuid.nullable(),
  type: orgUnitType,
  name: z.string().min(1).max(120),
});

export const orgMember = z.object({
  id: uuid,
  orgId: uuid,
  userId: uuid,
  orgUnitId: uuid.nullable(),
  role: memberRole,
  status: z.string(),
});
export const addMemberRequest = z.object({
  userId: uuid,
  orgUnitId: uuid.optional(),
  role: memberRole,
});
