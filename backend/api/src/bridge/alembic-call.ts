/**
 * One way to call ALEMBIC's internal RawProd routes, server to server — the channel the two systems
 * already trust (lane UX-H's Aria forward, lane catalogue's QC drafts, lane ruh-factory's C3 signals):
 *
 *   - ALEMBIC's address is the ORIGIN of the admin-configured bridge webhook URL
 *     (`bridge.connector_config.webhook_url`) plus the route's path — no second URL, nothing in .env;
 *   - the credential is that row's sealed HMAC secret (opened with BRIDGE_HMAC_KEK);
 *   - the signed material is `${timestamp}.${nonce}.${rawBody}` (HMAC-SHA256, `sha256=<hex>`), sent as
 *     x-bridge-timestamp / x-bridge-nonce / x-bridge-signature, plus a fresh x-bridge-request-id.
 *     ALEMBIC checks the 300 s window and spends the nonce once (bridge_request_nonce);
 *   - the tenant is ALEMBIC_ASSERTION_TENANT_ID.
 *
 * Unconfigured is not open: any missing piece gives null and the caller says so honestly.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { bridgeSchema, type BridgeDb } from './bridge.tokens.js';
import { openSecret } from './secret-box.js';
import { signBody } from './signing.js';

/** `origin(webhookUrl) + path`, or null when the webhook URL is missing or not http(s). */
export function alembicUrl(webhookUrl: string | null | undefined, path: string): string | null {
  if (!webhookUrl) return null;
  try {
    const u = new URL(webhookUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.origin}${path}`;
  } catch {
    return null;
  }
}

/** The four signed headers for one request body (fresh timestamp and nonce each call). */
export function signedBridgeHeaders(rawBody: string, secret: string, nowMs: number = Date.now()): Record<string, string> {
  const timestamp = String(Math.floor(nowMs / 1000));
  const nonce = randomUUID();
  return {
    'content-type': 'application/json',
    'x-bridge-request-id': randomUUID(),
    'x-bridge-timestamp': timestamp,
    'x-bridge-nonce': nonce,
    'x-bridge-signature': signBody(`${timestamp}.${nonce}.${rawBody}`, secret),
  };
}

export interface AlembicLink {
  readonly url: string;
  readonly secret: string;
  readonly tenantId: string;
}

/** The bridge's half of a call to `path`, or null when the connector, its secret or the tenant is missing. */
export async function alembicLink(bridgeDb: BridgeDb, tenantId: string | null | undefined, path: string): Promise<AlembicLink | null> {
  if (!tenantId) return null;
  const config = (await bridgeDb.select().from(bridgeSchema.connectorConfig)
    .where(eq(bridgeSchema.connectorConfig.id, 'default')).limit(1))[0];
  if (!config?.enabled) return null;
  const url = alembicUrl(config.webhookUrl, path);
  const secret = config.hmacSecretSealed ? openSecret(config.hmacSecretSealed) : null;
  if (!url || !secret) return null;
  return { url, secret, tenantId };
}
