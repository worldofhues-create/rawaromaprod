/**
 * RequestIdMiddleware — assigns/propagates `x-request-id` for correlation across the
 * clusters, logs, audit rows, and event envelopes (doc 06 §9, §11). Reuses an inbound id
 * (Cloudflare/Caddy may set one) or mints a UUIDv7; echoes it on the response header and
 * stashes it on the request for the interceptor + audit interceptor to read.
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { uuidv7 } from '@core/data-kernel';
import type { RequestWithUser } from './principal.js';

interface ResponseLike {
  setHeader(name: string, value: string): void;
  header?(name: string, value: string): void;
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: RequestWithUser, res: ResponseLike, next: () => void): void {
    const inbound = req.headers['x-request-id'];
    const requestId = (Array.isArray(inbound) ? inbound[0] : inbound) || uuidv7();
    req.requestId = requestId;
    // Fastify exposes `header()`; Express exposes `setHeader()` — support both.
    if (typeof res.header === 'function') res.header('x-request-id', requestId);
    else res.setHeader('x-request-id', requestId);
    next();
  }
}
