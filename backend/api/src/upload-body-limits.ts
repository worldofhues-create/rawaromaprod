/**
 * FACTORY-DOCS — the GC-MS PDF upload, and the only place a request body may exceed Fastify's 1 MiB.
 *
 * Round 1 raised the limit on the public `/rpc` tunnel, so ANY caller, signed in or not, could make the
 * server buffer 11 MiB per request: the tunnel's session token is inside the encrypted body, so nothing
 * can be checked before the body is read. Round 2 takes the upload OUT of the tunnel:
 *
 *   POST /v1/batch-coas/:id/gcms   body = the raw PDF bytes (`content-type: application/pdf`), the
 *                                  lab's details in the query string, `authorization: Bearer <token>`.
 *
 *   1. onRequest (before ANY byte of the body is read): no bearer token, or one that does not verify
 *      (signature, expiry, audience: JwtService.verifyAccess, the guard's own check) -> 401 at once.
 *   2. Only then the route's own body limit applies (GCMS_UPLOAD_BODY_LIMIT_BYTES, 8 MiB). It is larger
 *      than the 5 MB the service accepts so a 6 MB file reaches the service and is refused in plain
 *      words, not by Fastify's generic 413.
 *   3. The guard, the permission check (`production:batch_coa:write`) and the service run as for every
 *      route.
 *
 * `/rpc` and every other route keep Fastify's default 1 MiB. Install BEFORE `app.init()`: Nest registers
 * its routes inside init, and an `onRoute` hook only sees routes added after it.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

export const GCMS_UPLOAD_ROUTE = '/v1/batch-coas/:id/gcms';
export const GCMS_UPLOAD_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/** Verifies an access token; throws when it is not valid. */
export type VerifyAccess = (token: string) => Promise<unknown>;

interface RouteOptionsLike { method: string | string[]; url: string; bodyLimit?: number }
interface RequestLike { headers: Record<string, string | string[] | undefined>; routeOptions?: { url?: string }; method: string }
interface ReplyLike { code(n: number): ReplyLike; header(k: string, v: string): ReplyLike; send(b: unknown): unknown }
export interface UploadHost {
  addHook(name: 'onRoute', fn: (opts: RouteOptionsLike) => void): unknown;
  addHook(name: 'onRequest', fn: (req: RequestLike, reply: ReplyLike) => Promise<unknown>): unknown;
  addContentTypeParser(
    type: string, opts: { parseAs: 'buffer' },
    fn: (req: unknown, body: Buffer, done: (err: Error | null, body?: unknown) => void) => void,
  ): unknown;
}

const isUpload = (req: RequestLike) => req.method === 'POST' && req.routeOptions?.url === GCMS_UPLOAD_ROUTE;

export function installGcmsUploadOn(fastify: UploadHost, verify: VerifyAccess): void {
  fastify.addHook('onRoute', (opts) => {
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
    if (opts.url === GCMS_UPLOAD_ROUTE && methods.includes('POST')) opts.bodyLimit = GCMS_UPLOAD_BODY_LIMIT_BYTES;
  });
  fastify.addHook('onRequest', async (req, reply) => {
    if (!isUpload(req)) return;
    const h = req.headers.authorization;
    const token = typeof h === 'string' && /^Bearer\s+\S+$/i.test(h) ? h.replace(/^Bearer\s+/i, '') : null;
    let ok = false;
    if (token) {
      try { await verify(token); ok = true; } catch { ok = false; }
    }
    if (!ok) {
      // Answered before the body is read; the connection's remaining bytes are discarded unread.
      return reply.code(401).header('connection', 'close').send({
        data: null, error: { code: 'AUTH_TOKEN_INVALID', message: 'Sign in again to attach a GC-MS report.' },
      });
    }
  });
  // The PDF arrives as itself, not as base64 inside JSON: the body is the file.
  fastify.addContentTypeParser('application/pdf', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
}

export function installGcmsUpload(app: NestFastifyApplication, verify: VerifyAccess): void {
  installGcmsUploadOn(app.getHttpAdapter().getInstance() as unknown as UploadHost, verify);
}
