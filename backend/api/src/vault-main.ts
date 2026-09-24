/**
 * vault-main entrypoint (PB-03 remainder, V4 §109.1) — NestJS on Fastify, boots `VaultAppModule`
 * instead of `AppModule`. Run on the standalone Vault EC2 ONLY
 * (`infra/aws/systemd/vault-api.service`, `ExecStart=... backend/api/src/vault-main.ts`).
 *
 * THE PROBLEM THIS FILE FIXES: `main.ts` boots `AppModule`, which (via
 * `BackendKernelModule.forRoot()`) unconditionally needs `DATABASE_URL` — the main schema
 * Postgres connection every non-formula cluster reads through. The isolated Vault box has
 * (correctly, per V4 §109.1) no network path to that database and must never be handed its
 * credential, so `main.ts` cannot boot there at all; the previous state of
 * `vault-api.service` ran the full `AppModule` anyway, pointing `DATABASE_URL` at the SAME
 * shared `rawprod` database the main app box uses — exactly the shared-credential path §109.1
 * exists to close (see that file's own former header comment, kept in git history, for the
 * honest account of that interim compromise).
 *
 * This file boots `VaultAppModule` (`vault-app.module.ts`) instead — see that module's header
 * for exactly what it does and does not import, and the identity-design note explaining why
 * ALEMBIC-assertion LOGIN is deliberately not re-implemented here. Everything below mirrors
 * `main.ts`'s edge setup (Fastify adapter, the raw-body-preserving JSON parser the internal
 * bridge's HMAC needs, CORS, shutdown hooks) MINUS the pieces that only make sense for the main
 * app process: `WorkerModule`/`RUN_WORKER_IN_PROCESS` (no outbox lives here) and
 * `assertMainRoleCannotReadVault` (that check queries `PG_CLIENT`, which this process never has
 * — the isolation it proves is structurally true here by construction: there is no connection to
 * revoke a grant on).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@core/backend-kernel';
import { VaultAppModule } from './vault-app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    VaultAppModule,
    new FastifyAdapter({ trustProxy: true }),
  );

  // Same reasoning as main.ts: Nest's FastifyAdapter registers its default JSON parser lazily
  // inside app.init(), so replacing it has to happen after init(). Every route keeps its normal
  // parsed body; the exact bytes are ALSO stashed on req.rawBody — InternalBridgeGuard verifies
  // the HMAC over these exact bytes (a re-serialization can produce different bytes than the
  // sender signed, the identical reason BridgeModule's HMAC needs this on the main app box).
  await app.init();
  const fastifyInstance = app.getHttpAdapter().getInstance();
  fastifyInstance.removeContentTypeParser('application/json');
  fastifyInstance.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body: string, done: (err: Error | null, body?: unknown) => void) => {
      (_req as unknown as { rawBody?: string }).rawBody = body;
      try {
        done(null, body.length ? JSON.parse(body) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  const config = app.get(ConfigService);

  // Boot-time sanity check that the right entrypoint is running the right module (see
  // config.schema.ts's VAULT_MODE doc) — a vault.env missing VAULT_MODE=true would otherwise
  // silently boot with FormulaModule's plaintext routes UNMOUNTED and MASTERDATA_LOOKUP
  // resolving nowhere (ClusterMasterdataModule was never imported either) — fail loudly instead.
  if (!config.get('VAULT_MODE')) {
    throw new Error(
      'vault-main.ts requires VAULT_MODE=true in its environment — refusing to boot with the ' +
        'Vault console\'s own routes unmounted. (Set it in /etc/rawprod/vault.env.)',
    );
  }

  // CORS — fail CLOSED in prod, same rule main.ts applies (web-vault/vault.js's own origin must
  // be explicitly allow-listed; an unset value never reflects-any with credentials).
  const corsOrigins = (config.get('CORS_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (config.get('APP_ENV') === 'prod' && corsOrigins.length === 0) {
    throw new Error(
      'CORS_ORIGINS must be set to the exact Vault console origin when APP_ENV=prod (refusing ' +
        'to reflect any origin).',
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
  new Logger('Bootstrap').log(`vault-api listening on :${port} (${config.get('APP_ENV')})`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
