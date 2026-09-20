/**
 * RateLimitGuard — PLACEHOLDER. The production limiter is a Redis sliding-window keyed
 * by IP (anon: search 60/min, auth 10/min) and userId (writes 30/min) per doc 06 §9. We
 * ship the seam now (guard + decorator metadata) with an in-memory fixed-window fallback
 * so the wiring typechecks and works single-node; swap the store for Redis at Stage 1
 * without touching call sites. Not registered globally by default — apply per sensitive
 * route or globally in the composition root once Redis is present.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { DomainError } from './domain-error.js';
import type { RequestWithUser } from './principal.js';

interface Window {
  count: number;
  resetAt: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  /** In-memory fallback store. Replace with a Redis client (INCR + EXPIRE) at Stage 1. */
  private readonly windows = new Map<string, Window>();
  private readonly limit = 60;
  private readonly windowMs = 60_000;

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const key = request.user?.userId ?? request.ip ?? 'anon';
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || existing.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    existing.count += 1;
    if (existing.count > this.limit) {
      throw new DomainError('RATE_LIMITED', 'Too many requests', 429);
    }
    return true;
  }
}
