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
import { ConfigService } from '@core/backend-kernel';
import { AppModule } from './app.module.js';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
  );

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
