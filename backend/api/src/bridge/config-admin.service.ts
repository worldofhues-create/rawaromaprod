/**
 * ConfigAdminService — self-service admin config for the bridge connector, the mirror of
 * ALEMBIC's `rawprod_bridge` connector. Sets the outbound webhook URL (non-secret) and
 * seals a new HMAC secret at rest (`secret-box.ts`). Never returns the secret back —
 * same "value never leaves" rule ALEMBIC's integration registry documents.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { BRIDGE_DB, bridgeSchema, type BridgeDb } from './bridge.tokens.js';
import { sealSecret } from './secret-box.js';

const { connectorConfig } = bridgeSchema;

export interface ConfigureInput {
  readonly enabled?: boolean;
  readonly webhookUrl?: string;
  readonly hmacSecret?: string;
}

export interface ConfigStatus {
  readonly enabled: boolean;
  readonly webhookUrl: string | null;
  readonly hasSecret: boolean;
  readonly configuredAt: string | null;
}

@Injectable()
export class ConfigAdminService {
  constructor(@Inject(BRIDGE_DB) private readonly db: BridgeDb) {}

  async configure(input: ConfigureInput, actorId: string): Promise<ConfigStatus> {
    const existing = (await this.db.select().from(connectorConfig)
      .where(eq(connectorConfig.id, 'default')).limit(1))[0];

    const next = {
      enabled: input.enabled ?? existing?.enabled ?? false,
      webhookUrl: input.webhookUrl ?? existing?.webhookUrl ?? null,
      hmacSecretSealed: input.hmacSecret ? sealSecret(input.hmacSecret) : (existing?.hmacSecretSealed ?? null),
      configuredAt: new Date(),
      configuredBy: actorId,
    };

    if (existing) {
      await this.db.update(connectorConfig).set(next).where(eq(connectorConfig.id, 'default'));
    } else {
      await this.db.insert(connectorConfig).values({ id: 'default', ...next });
    }

    return {
      enabled: next.enabled,
      webhookUrl: next.webhookUrl,
      hasSecret: Boolean(next.hmacSecretSealed),
      configuredAt: next.configuredAt.toISOString(),
    };
  }
}
