/**
 * BackendKernelModule — the one import that gives a deployable the reusable core:
 * validated config, the per-schema Drizzle clients, JWT signer/verifier, the in-memory
 * flag snapshot, the event bus (+ optional outbox publisher), and `/health`.
 *
 * The edge guards/interceptors/filters/middleware are EXPORTED for the composition root
 * to register globally (via `APP_GUARD` tokens or `app.useGlobal*`) — the kernel doesn't
 * force a global guard policy so a deployable can opt routes in/out. Both `api` and
 * `worker` import this; only the worker passes `outbox.withPublisher: true`.
 */
import { type DynamicModule, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from './config/config.module.js';
import { DrizzleModule } from './db/drizzle.module.js';
import { JwtModule } from './edge/jwt.module.js';
import { FlagsModule } from './flags/flags.module.js';
import { HealthModule } from './health/health.module.js';
import { OutboxModule, type OutboxModuleOptions } from './events/outbox.module.js';

export interface BackendKernelOptions {
  /** Outbox wiring. Pass `{ withPublisher: true, sources }` in the worker only. */
  outbox?: OutboxModuleOptions;
  /** Register the @nestjs/schedule root (needed by the outbox publisher / cron). */
  enableScheduling?: boolean;
}

@Module({})
export class BackendKernelModule {
  static forRoot(options: BackendKernelOptions = {}): DynamicModule {
    const imports: NonNullable<DynamicModule['imports']> = [
      ConfigModule,
      DrizzleModule,
      JwtModule,
      FlagsModule,
      OutboxModule.forRoot(options.outbox),
      HealthModule,
    ];

    if (options.enableScheduling ?? options.outbox?.withPublisher) {
      imports.push(ScheduleModule.forRoot());
    }

    return {
      module: BackendKernelModule,
      imports,
      exports: [
        ConfigModule,
        DrizzleModule,
        JwtModule,
        FlagsModule,
        OutboxModule,
      ],
    };
  }
}
