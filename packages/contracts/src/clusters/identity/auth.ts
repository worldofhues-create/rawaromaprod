import { z } from 'zod';
import { uuid } from '../../primitives/ids.js';
import { portal } from '../../registries/permissions.js';

export const otpChannel = z.enum(['sms', 'email', 'whatsapp']);

export const registerRequest = z.object({
  mobile: z.string().regex(/^\+?[1-9]\d{7,14}$/).optional(),
  email: z.string().email().optional(),
  fullName: z.string().min(1).max(120),
  portal,
  referralCode: z.string().max(64).optional(),
  acceptedTerms: z.literal(true),
  acceptedPrivacy: z.literal(true),
}).refine((v) => v.mobile || v.email, { message: 'mobile or email required' });

export const sendOtpRequest = z.object({
  target: z.string().min(3),
  channel: otpChannel,
});
export const verifyOtpRequest = z.object({
  target: z.string().min(3),
  code: z.string().length(6),
});

export const loginRequest = z.object({
  identifier: z.string().min(3).describe('mobile or email'),
  password: z.string().min(1).optional(),
  otp: z.string().length(6).optional(),
  portal,
  deviceFingerprint: z.string().optional(),
}).refine((v) => v.password || v.otp, { message: 'password or otp required' });

export const tokenPair = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().describe('access token TTL seconds'),
});

export const refreshRequest = z.object({ refreshToken: z.string() });

export const forgotPasswordRequest = z.object({ identifier: z.string().min(3) });
export const resetPasswordRequest = z.object({
  token: z.string(),
  newPassword: z.string().min(8).max(128),
});

export const authUser = z.object({
  id: uuid,
  fullName: z.string(),
  mobile: z.string().nullable(),
  email: z.string().nullable(),
  status: z.enum(['active', 'suspended', 'pending']),
  roles: z.array(z.string()),
  portal,
});

export const authResult = z.object({ user: authUser, tokens: tokenPair });
