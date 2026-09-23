/**
 * `@FreshAuth()` — gate a route behind a recently-issued token (§109.5: "fresh authentication
 * before high-risk plaintext/decrypt operations"). `FreshAuthGuard` 403s
 * (`AUTH_STEP_UP_REQUIRED`) when the caller's access token is older than the window, so the
 * client can react by re-running `POST /auth/login` (re-entering the password/OTP the caller
 * already has — this launch does not add a second MFA factor, per §109.5) and retrying with
 * the freshly-minted token.
 *
 * Default window: 300s (5 minutes). Pass a smaller/larger window per route if needed.
 */
import { SetMetadata } from '@nestjs/common';
import { META_FRESH_AUTH } from './metadata.keys.js';

export const FreshAuth = (maxAgeSeconds = 300): MethodDecorator & ClassDecorator =>
  SetMetadata(META_FRESH_AUTH, maxAgeSeconds);
