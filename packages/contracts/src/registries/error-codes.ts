import { z } from 'zod';

/**
 * Canonical error codes. Convention: `DOMAIN_REASON`. Add codes here only; the edge layer
 * maps every thrown error to one of these, so clients can branch on a stable string.
 */
export const ERROR_CODES = [
  // generic
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  // auth / access
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_OTP_INVALID',
  'AUTH_OTP_EXPIRED',
  'AUTH_OTP_THROTTLED',
  'AUTH_TOKEN_EXPIRED',
  'AUTH_TOKEN_INVALID',
  'AUTH_FORBIDDEN',
  'AUTH_PORTAL_MISMATCH',
  'AUTH_STEP_UP_REQUIRED',
  // ALEMBIC->RawProd identity assertion (PB-04 / SB-02)
  'AUTH_ASSERTION_INVALID',
  'AUTH_ASSERTION_REPLAYED',
  'AUTH_UNKNOWN_USER',
  // control plane
  'FEATURE_DISABLED',
  'FEATURE_DEGRADED',
  // tutorial engine (G4) — client's cached lesson totalSteps/version is stale against the
  // server-side registry (see backend/api/src/tutorial/tutorial.service.ts).
  'TUTORIAL_STALE_VERSION',
] as const;

export const errorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCode>;
