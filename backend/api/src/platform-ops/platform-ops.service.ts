/**
 * PlatformOpsService — read-only operational visibility for the Platform Ops console
 * (P0_UI_PARITY_PUBLIC_GREEN_ADDENDUM.md §6, ALEMBIC_RAWPROD_FINAL_LAUNCH_DIRECTIVE_V4.md
 * §113). Closes the four gaps web-platform/platform.js flagged as "not available":
 *
 *   tenants()   → org_master rows via ClusterOrgModule's OrgService, mapped down to
 *                 id/code/name/status ONLY — no address/GST/other org_master column. This
 *                 backend is currently single-tenant (RawProd/RAC itself); the endpoint is
 *                 honest about that (see PlatformOpsController doc comment), not multi-tenant
 *                 SaaS billing data.
 *   deepHealth()→ DB ping (same probe as GET /health) + PER-SCHEMA outbox backlog/lag,
 *                 discovered generically via information_schema (every cluster's outbox table
 *                 has the identical shape the kernel's outboxTable() factory produces — see
 *                 backend/backend-kernel/src/events/outbox.registry.ts). Deliberately reads
 *                 only schemas reachable off the SHARED PG_CLIENT pool — the Vault's
 *                 `formula` schema lives on its OWN isolated connection (FORMULA_DATABASE_URL)
 *                 and is never queried here. "No vault data" (§6) is structural, not a filter.
 *   providers() → bridge.connector_config STATUS fields only (enabled, configured_at/by,
 *                 whether a webhook URL + secret are set) — never `hmac_secret_sealed`
 *                 (sealed ciphertext) or the webhook URL's contents beyond a boolean.
 *   buildIdentity() → GIT_SHA/BUILD_TIME from env (ConfigService, falling back to the
 *                 RENDER_GIT_COMMIT the hosting platform injects) — null, not fabricated,
 *                 when unset.
 *
 * Every method here is read-only against columns that were already non-secret before this
 * lane (org_master status, outbox row COUNTS, connector_config's status columns, env vars) —
 * nothing decrypts, nothing touches formula.*, nothing returns a secret column.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';
import { ConfigService, PG_CLIENT } from '@core/backend-kernel';
import { OrgService } from '@ra/cluster-org';
import { BRIDGE_DB, bridgeSchema, type BridgeDb } from '../bridge/bridge.tokens.js';

const { connectorConfig } = bridgeSchema;

/** Identifier-only: matches Postgres's `[A-Za-z_][A-Za-z0-9_]*` unquoted-identifier shape.
 * Schema names here come from information_schema (trusted catalog data), but every value
 * that gets string-interpolated into raw SQL is validated against this before use anyway —
 * belt-and-braces, never trust-by-provenance alone for a query string. */
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

export interface TenantRow {
  organizationId: string;
  organizationCode: string | null;
  organizationName: string | null;
  status: string | null;
}

export interface OutboxSchemaHealth {
  schema: string;
  backlog: number;
  oldestUnpublishedSeconds: number | null;
}

export interface DeepHealth {
  database: 'up' | 'down';
  outbox: OutboxSchemaHealth[];
  at: string;
  note: string;
}

export interface ProviderHealth {
  id: string;
  enabled: boolean;
  webhookConfigured: boolean;
  secretConfigured: boolean;
  configuredAt: string | null;
  configuredBy: string | null;
}

export interface BuildIdentity {
  gitSha: string | null;
  buildTime: string | null;
  appEnv: string;
}

@Injectable()
export class PlatformOpsService {
  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    @Inject(BRIDGE_DB) private readonly bridgeDb: BridgeDb,
    private readonly org: OrgService,
    private readonly config: ConfigService,
  ) {}

  /** Tenant/organization list — identity + status only (§6). */
  async tenants(): Promise<TenantRow[]> {
    const page = await this.org.listOrgs({ limit: 100 });
    return page.items.map((r) => ({
      organizationId: r.organizationId,
      organizationCode: r.organizationCode,
      organizationName: r.organizationName,
      status: r.status,
    }));
  }

  /** DB + outbox backlog/lag across every schema on the SHARED pool (never `formula`). */
  async deepHealth(): Promise<DeepHealth> {
    let database: 'up' | 'down' = 'down';
    try {
      await this.sql`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }

    const schemaRows = await this.sql<{ table_schema: string }[]>`
      select distinct table_schema from information_schema.tables where table_name = 'outbox'
    `;
    const outbox: OutboxSchemaHealth[] = [];
    for (const row of schemaRows) {
      const schema = row.table_schema;
      if (!SAFE_IDENT.test(schema)) continue; // defensive; information_schema never violates this
      const [stat] = await this.sql.unsafe<{ backlog: string; oldest_seconds: number | null }[]>(
        `select count(*) filter (where published_at is null) as backlog,
                extract(epoch from (now() - min(occurred_at) filter (where published_at is null))) as oldest_seconds
         from "${schema}".outbox`,
      );
      outbox.push({
        schema,
        backlog: Number(stat?.backlog ?? 0),
        oldestUnpublishedSeconds: stat?.oldest_seconds != null ? Number(stat.oldest_seconds) : null,
      });
    }

    return {
      database,
      outbox,
      at: new Date().toISOString(),
      note:
        'outbox = unpublished-row backlog + age of the oldest unpublished row per schema (a ' +
        'worker-lag proxy — no live worker heartbeat exists in this backend). The formula ' +
        '(Vault) schema is intentionally excluded — it runs on its own isolated connection, ' +
        'never the shared pool this query reads.',
    };
  }

  /** bridge.connector_config — status only, never the sealed HMAC secret. */
  async providers(): Promise<ProviderHealth[]> {
    const rows = await this.bridgeDb.select().from(connectorConfig);
    return rows.map((r) => ({
      id: r.id,
      enabled: !!r.enabled,
      webhookConfigured: !!r.webhookUrl,
      secretConfigured: !!r.hmacSecretSealed,
      configuredAt: r.configuredAt ? r.configuredAt.toISOString() : null,
      configuredBy: r.configuredBy ?? null,
    }));
  }

  /** Build identity — env-populated at deploy time; honest null when unset. */
  buildIdentity(): BuildIdentity {
    return {
      gitSha: this.config.get('GIT_SHA') ?? process.env.RENDER_GIT_COMMIT ?? null,
      buildTime: this.config.get('BUILD_TIME') ?? null,
      appEnv: this.config.get('APP_ENV'),
    };
  }
}
