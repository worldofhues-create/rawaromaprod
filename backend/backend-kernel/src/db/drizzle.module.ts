/**
 * DrizzleModule — provides one postgres-js pool and a per-schema Drizzle client for
 * each cluster schema (iam, platform). Global so any cluster can `@Inject` its own
 * client token. New clusters add their schema barrel + a token here (the only edit
 * needed to wire a new schema into the pool).
 */
import { Global, Module, type OnModuleDestroy, Inject } from '@nestjs/common';
import postgres, { type Sql } from 'postgres';
import { ConfigService } from '../config/config.service.js';
import {
  IAM_DB,
  PG_CLIENT,
  PLATFORM_DB,
  drizzle,
  iamSchema,
  platformSchema,
} from './drizzle.tokens.js';

@Global()
@Module({
  providers: [
    {
      provide: PG_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Sql => {
        const url = config.get('DATABASE_URL');
        if (!url) {
          // DATABASE_URL became optional in configSchema (PB-03 remainder) so vault-main.ts
          // (VaultAppModule) can boot without a main-DB credential at all — but DrizzleModule
          // itself is never imported there. Every deployable that DOES import it (main.ts's
          // AppModule, worker.ts's WorkerModule) still needs a main schema connection to
          // function at all — fail fast here with the same "clear boot error, never a mysterious
          // runtime failure" rule createFormulaClient already follows for FORMULA_DATABASE_URL.
          throw new Error(
            'DATABASE_URL is required to boot this deployable (DrizzleModule/PG_CLIENT). ' +
              'The Vault-only deployment must use vault-main.ts/VaultAppModule instead, which ' +
              'never imports DrizzleModule and has no main-DB credential by design (V4 §109.1).',
          );
        }
        return postgres(url, {
          max: 10,
          // postgres-js parses bigint identity columns; keep them as JS bigint to match
          // the data layer's `{ mode: "bigint" }` outbox.seq.
          types: {},
        });
      },
    },
    {
      provide: IAM_DB,
      inject: [PG_CLIENT],
      useFactory: (client: Sql) => drizzle(client, { schema: iamSchema }),
    },
    {
      provide: PLATFORM_DB,
      inject: [PG_CLIENT],
      useFactory: (client: Sql) => drizzle(client, { schema: platformSchema }),
    },
  ],
  exports: [PG_CLIENT, IAM_DB, PLATFORM_DB],
})
export class DrizzleModule implements OnModuleDestroy {
  constructor(@Inject(PG_CLIENT) private readonly client: Sql) {}

  /** Close the pool on shutdown so the process exits cleanly. */
  async onModuleDestroy(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}
