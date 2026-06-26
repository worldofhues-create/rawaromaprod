import { z } from 'zod';
import { uuid } from '../../primitives/ids.js';

export const meProfile = z.object({
  id: uuid,
  fullName: z.string(),
  mobile: z.string().nullable(),
  email: z.string().nullable(),
  photoKey: z.string().nullable(),
});
export const updateMeRequest = meProfile.pick({ fullName: true, photoKey: true }).partial();

export const sessionView = z.object({
  id: uuid,
  platform: z.enum(['web', 'ios', 'android']),
  lastSeenAt: z.string().datetime().nullable(),
  current: z.boolean(),
});

export const consentRequest = z.object({
  type: z.enum(['tnc', 'privacy', 'marketing']),
  version: z.string(),
});
export const consentView = consentRequest.extend({
  id: uuid,
  grantedAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});

export const changePasswordRequest = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});
