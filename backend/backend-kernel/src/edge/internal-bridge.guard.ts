/**
 * InternalBridgeGuard — the receiving-side check for the signed internal channel
 * (`internal-bridge-signing.ts`). Applied with `@UseGuards(InternalBridgeGuard)` at the
 * CONTROLLER level on the one internal-only surface this bridge has (never globally):
 *   - `vault-port-internal.controller.ts` (Vault box) — main → vault. (The main box's former
 *     `material-facts.controller.ts`, vault → main, was retired by lane fread-rp: the Vault
 *     receives a pushed material catalogue instead and never calls the main box.)
 *
 * That controller ALSO carries `@Public()` (these are process-to-process calls, not a user
 * session — there is no bearer JWT to check) — `@Public()` only skips `JwtAuthGuard`/
 * `PermissionsGuard`; THIS guard is the actual access control for those routes, so it does
 * not itself consult `@Public()`/`@Permissions()` metadata.
 *
 * Reads `x-internal-signature` + `x-internal-timestamp` and verifies against the exact raw
 * body bytes (`request.rawBody` — the same field `main.ts`'s custom content-type parser already
 * stashes for `BridgeModule`'s HMAC, for the identical "re-serialization can change the signed
 * bytes" reason) using `INTERNAL_BRIDGE_KEY`. FAILS CLOSED: an unset key, a missing header, or a
 * bad/replayed signature all refuse (401) — never a silent pass, same posture every other
 * optional security config in this codebase takes (`ALEMBIC_ASSERTION_VERIFY_KEY`,
 * `FORMULA_KEK`, …).
 *
 * L1: a valid signature is accepted ONCE — `InternalBridgeReplayCache` (in-memory, bounded,
 * per-process; see its doc for the single-process assumption) refuses a reused signature within
 * the skew window.
 */
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service.js';
import { DomainError } from './domain-error.js';
import { InternalBridgeReplayCache, verifyInternalBridgeSignature } from './internal-bridge-signing.js';

interface InternalBridgeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: string;
}

function header(req: InternalBridgeRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

@Injectable()
export class InternalBridgeGuard implements CanActivate {
  private readonly replayCache = new InternalBridgeReplayCache();

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<InternalBridgeRequest>();
    const key = this.config.get('INTERNAL_BRIDGE_KEY');
    if (!key) {
      throw DomainError.unauthorized(
        'INTERNAL_BRIDGE_UNAUTHORIZED',
        'INTERNAL_BRIDGE_KEY is not configured; the internal bridge is unavailable.',
      );
    }

    const signature = header(request, 'x-internal-signature');
    const timestamp = header(request, 'x-internal-timestamp');
    const nonce = header(request, 'x-internal-nonce');
    if (!signature || !timestamp) {
      throw DomainError.unauthorized(
        'INTERNAL_BRIDGE_UNAUTHORIZED',
        'Missing x-internal-signature/x-internal-timestamp.',
      );
    }

    const ok = verifyInternalBridgeSignature(
      key,
      {
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        body: request.rawBody ?? '',
        timestamp,
        ...(nonce ? { nonce } : {}),
      },
      signature,
    );
    if (!ok) {
      throw DomainError.unauthorized(
        'INTERNAL_BRIDGE_UNAUTHORIZED',
        'Invalid or expired internal bridge signature.',
      );
    }
    // Only record AFTER the signature verified, so unauthenticated junk can't fill the cache.
    if (!this.replayCache.checkAndRecord(signature)) {
      throw DomainError.unauthorized(
        'INTERNAL_BRIDGE_UNAUTHORIZED',
        'Replayed internal bridge signature.',
      );
    }
    return true;
  }
}
