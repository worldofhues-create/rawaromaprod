/**
 * api entrypoint (doc 01 §0) — NestJS on Fastify. The edge layer (guards, envelope
 * interceptor, exception filter, request-id middleware) is wired globally in AppModule,
 * so this file just builds the app, applies app-level concerns (CORS, shutdown hooks),
 * and listens on `PORT`. Validation is per-route via the `ZodValidationPipe` (zod from
 * @core/contracts) rather than a global class-validator pipe.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';
import { ConfigService, JwtService, PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { AppModule } from './app.module.js';
import { installRawJsonParser } from './raw-json-parser.js';
import { installGcmsUpload } from './upload-body-limits.js';
import { WorkerModule } from './worker.module.js';
import { assertMainRoleCannotReadVault } from './vault-isolation-check.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
  );

  /* Nest's FastifyAdapter registers its own default `application/json` parser lazily,
   * inside `app.init()` (which `app.listen()` calls internally) — not here, at
   * `NestFactory.create()`. So replacing it has to happen AFTER `init()`, once Nest's own
   * parser actually exists to remove; adding one before that point collides with Nest's
   * own registration a moment later (`FST_ERR_CTP_ALREADY_PRESENT`). */
  // FACTORY-DOCS: the GC-MS PDF upload is the one route allowed more than Fastify's 1 MiB, and only after
  // its bearer token verifies, before the body is read (upload-body-limits.ts). Before init: the hook
  // must see the routes as init registers them.
  const jwtForUpload = app.get(JwtService);
  installGcmsUpload(app, (token) => jwtForUpload.verifyAccess(token));

  await app.init();

  // The bytes-in-hand JSON parser the bridge HMAC needs: raw-json-parser.ts (FLOOR-FIX-10).
  installRawJsonParser(app);

  const config = app.get(ConfigService);

  // CORS — fail CLOSED in prod (BFF masking §7, LEAK-8): an unset CORS_ORIGINS under
  // APP_ENV=prod is a boot error, never a reflect-any with credentials. In dev, unset =
  // permissive reflect so local portals work without config.
  const corsOrigins = (config.get('CORS_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (config.get('APP_ENV') === 'prod' && corsOrigins.length === 0) {
    throw new Error(
      'CORS_ORIGINS must be set to the exact portal origins when APP_ENV=prod (refusing to reflect any origin).',
    );
  }
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'x-ra-key'],
  });
  app.enableShutdownHooks();

  // PB-03 / SB-01 (V4 §109.1, FINAL_OS §7.2): boot-time self-check that the MAIN app DB role
  // — the one every other cluster's PG_CLIENT queries run as — cannot read the vault's
  // crown-jewel ciphertext tables. Prod-only (dev/CI may legitimately run both roles as the
  // same Postgres user). A successful read here means the ra_vault isolation
  // (scripts/provision-vault-isolation.sql) was never applied, or was applied against a
  // different database than the one DATABASE_URL points at — fail CLOSED: refuse to boot
  // rather than serve traffic with the wall down.
  if (config.get('APP_ENV') === 'prod') {
    await assertMainRoleCannotReadVault(app.get<Sql>(PG_CLIENT));
  }

  const port = config.get('PORT');

  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`api listening on :${port} (${config.get('APP_ENV')})`);

  // Free single-service deploy: run the worker (outbox drain + schedulers) IN this
  // process instead of a separate dyno. (Free infra §8 — RUN_WORKER_IN_PROCESS.)
  if (config.get('RUN_WORKER_IN_PROCESS')) {
    const worker = await NestFactory.createApplicationContext(WorkerModule);
    worker.enableShutdownHooks();
    new Logger('Bootstrap').log('worker running in-process (outbox publisher draining)');
  }
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
