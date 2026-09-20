import type { z } from 'zod';
import { identity } from '@core/contracts';
import type { ApiClient } from './client.js';

/**
 * Types derived from the single source of truth — @core/contracts zod schemas. No shapes are
 * re-declared; they always track the contract (same discipline as web/feature-auth).
 */
export type LoginRequest = z.infer<typeof identity.auth.loginRequest>;
export type RegisterRequest = z.infer<typeof identity.auth.registerRequest>;
export type RefreshRequest = z.infer<typeof identity.auth.refreshRequest>;
export type AuthResult = z.infer<typeof identity.auth.authResult>;
export type AuthUser = z.infer<typeof identity.auth.authUser>;
export type TokenPair = z.infer<typeof identity.auth.tokenPair>;
export type MeProfile = z.infer<typeof identity.me.meProfile>;

/**
 * Typed auth endpoints bound to an {@link ApiClient}. Each call validates its response against
 * the matching contract schema, so the returned objects are guaranteed-shape and fully typed.
 * Paths mirror the platform edge routes.
 */
export function createAuthEndpoints(api: ApiClient) {
  return {
    register(body: RegisterRequest): Promise<AuthResult> {
      return api.request('/auth/register', {
        method: 'POST',
        body,
        anonymous: true,
        responseSchema: identity.auth.authResult,
      });
    },

    login(body: LoginRequest): Promise<AuthResult> {
      return api.request('/auth/login', {
        method: 'POST',
        body,
        anonymous: true,
        responseSchema: identity.auth.authResult,
      });
    },

    refresh(body: RefreshRequest): Promise<TokenPair> {
      return api.request('/auth/refresh', {
        method: 'POST',
        body,
        anonymous: true,
        responseSchema: identity.auth.tokenPair,
      });
    },

    me(): Promise<MeProfile> {
      return api.request('/me', {
        method: 'GET',
        responseSchema: identity.me.meProfile,
      });
    },
  };
}

export type AuthEndpoints = ReturnType<typeof createAuthEndpoints>;
