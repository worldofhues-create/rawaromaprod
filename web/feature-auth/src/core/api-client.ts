import type { z } from 'zod';
import { identity } from '@core/contracts';

/**
 * Types derived from the single source of truth — @core/contracts zod schemas.
 * No shapes are re-declared here; they always track the contract.
 */
export type LoginRequest = z.infer<typeof identity.auth.loginRequest>;
export type RegisterRequest = z.infer<typeof identity.auth.registerRequest>;
export type ForgotPasswordRequest = z.infer<typeof identity.auth.forgotPasswordRequest>;
export type AuthResult = z.infer<typeof identity.auth.authResult>;
export type AuthUser = z.infer<typeof identity.auth.authUser>;
export type TokenPair = z.infer<typeof identity.auth.tokenPair>;

/**
 * The auth transport this feature needs, INJECTED by the host app. The feature owns
 * zero networking — the app wires a real typed client (generated from the contracts'
 * OpenAPI spec) or a mock. This keeps feature-auth transport-agnostic and testable.
 */
export interface AuthApiClient {
  login(body: LoginRequest): Promise<AuthResult>;
  register(body: RegisterRequest): Promise<AuthResult>;
  forgotPassword(body: ForgotPasswordRequest): Promise<{ ok: true }>;
}
