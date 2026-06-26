/**
 * Inferred DTO types for the auth surface, derived from the `@core/contracts` zod
 * schemas so the controller/service share ONE source of truth with the API contract.
 */
import type { z } from 'zod';
import { identity } from '@core/contracts';

export type RegisterRequest = z.infer<typeof identity.auth.registerRequest>;
export type LoginRequest = z.infer<typeof identity.auth.loginRequest>;
export type RefreshRequest = z.infer<typeof identity.auth.refreshRequest>;
export type TokenPair = z.infer<typeof identity.auth.tokenPair>;
export type AuthResult = z.infer<typeof identity.auth.authResult>;
export type AuthUser = z.infer<typeof identity.auth.authUser>;
export type MeProfile = z.infer<typeof identity.me.meProfile>;
