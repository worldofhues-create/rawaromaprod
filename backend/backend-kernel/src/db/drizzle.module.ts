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
      useFactory: (config: ConfigService): Sql =>
        postgres(config.get('DATABASE_URL'), {
          max: 10,
          // postgres-js parses bigint identity columns; keep them as JS bigint to match
          // the data layer's `{ mode: "bigint" }` outbox.seq.
          types: {},
        }),
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
