/**
 * FACTORY-DOCS — the two routes a GC-MS PDF travels through get a larger body limit than Fastify's
 * 1 MiB default, and no other route does. A 5 MB PDF (GCMS_MAX_BYTES) rides the console's encrypted
 * channel as base64 inside JSON, sealed and base64'd again: about 9.4 MB at `/rpc`, about 7 MB at the
 * inner `POST /v1/batch-coas/:id/gcms` the tunnel replays. 11 MiB covers both and stays under nginx's
 * 12m client_max_body_size, so a too-large file is refused by the API with a message, not by nginx.
 *
 * Install BEFORE `app.init()`: Nest registers its routes inside init, and an `onRoute` hook only sees
 * routes added after it.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

export const UPLOAD_BODY_LIMIT_BYTES = 11 * 1024 * 1024;
export const UPLOAD_ROUTES: ReadonlyArray<{ method: string; url: string }> = [
  { method: 'POST', url: '/rpc' },
  { method: 'POST', url: '/v1/batch-coas/:id/gcms' },
];

interface RouteOptionsLike { method: string | string[]; url: string; bodyLimit?: number }
interface HookHost { addHook(name: 'onRoute', fn: (opts: RouteOptionsLike) => void): unknown }

export function installUploadBodyLimitsOn(fastify: HookHost): void {
  fastify.addHook('onRoute', (opts) => {
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
    if (UPLOAD_ROUTES.some((r) => r.url === opts.url && methods.includes(r.method))) opts.bodyLimit = UPLOAD_BODY_LIMIT_BYTES;
  });
}

export function installUploadBodyLimits(app: NestFastifyApplication): void {
  installUploadBodyLimitsOn(app.getHttpAdapter().getInstance() as unknown as HookHost);
}
