/**
 * AlembicDraftsClient (FACTORY-SETUP) — asks ALEMBIC for Ruh's QC-spec drafts. ALEMBIC holds the
 * uploaded supplier SDS / lab COA files, the catalogue facts and the AI gateway with its monthly
 * budget, so the drafting happens there; this box only names its factory SKU codes (== ALEMBIC
 * SKU codes) and stores what comes back as proposals for its QC role to approve.
 *
 * The channel the two systems already trust — exactly AriaBridgeService's: the bridge's sealed
 * HMAC secret, `${timestamp}.${nonce}.${rawBody}` signed, ALEMBIC's address = the origin of the
 * configured bridge webhook, the tenant = ALEMBIC_ASSERTION_TENANT_ID. No formula and no material
 * identity beyond the SKU code is sent; only physical figures come back.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ConfigService } from '@core/backend-kernel';
import { BRIDGE_DB, bridgeSchema, type BridgeDb } from '../bridge/bridge.tokens.js';
import { openSecret } from '../bridge/secret-box.js';
import { signBody } from '../bridge/signing.js';

export const ALEMBIC_QC_DRAFTS_PATH = '/api/v1/internal/rawprod/factory-setup/qc-drafts';
export const ALEMBIC_DRAFTS_FETCH = Symbol('ALEMBIC_DRAFTS_FETCH');
const TIMEOUT_MS = 120_000;

export type DraftsResult =
  | { ok: true; ai: string; items: Array<{ sku_code: string; draft: unknown; source: string | null; missing: string[]; reason: string | null }> }
  | { ok: false; reason: 'not_configured' | 'refused' | 'unreachable'; message: string };

const { connectorConfig } = bridgeSchema;

@Injectable()
export class AlembicDraftsClient {
  private readonly doFetch: typeof fetch;

  constructor(
    @Inject(BRIDGE_DB) private readonly bridgeDb: BridgeDb,
    @Inject(ConfigService) private readonly config: Pick<ConfigService, 'get'>,
    @Optional() @Inject(ALEMBIC_DRAFTS_FETCH) fetchImpl?: typeof fetch,
  ) {
    this.doFetch = fetchImpl ?? fetch;
  }

  async qcDrafts(skuCodes: string[], subject: string | null): Promise<DraftsResult> {
    const tenantId = this.config.get('ALEMBIC_ASSERTION_TENANT_ID');
    const cfg = (await this.bridgeDb.select().from(connectorConfig).where(eq(connectorConfig.id, 'default')).limit(1))[0];
    const secret = cfg?.hmacSecretSealed ? openSecret(cfg.hmacSecretSealed) : null;
    let url: string | null = null;
    try { url = cfg?.webhookUrl ? `${new URL(cfg.webhookUrl).origin}${ALEMBIC_QC_DRAFTS_PATH}` : null; } catch { url = null; }
    if (!tenantId || !cfg?.enabled || !secret || !url) {
      return { ok: false, reason: 'not_configured', message: 'This factory is not connected to ALEMBIC yet, so Ruh cannot draft. Finish the ALEMBIC bridge connection first.' };
    }
    const body = JSON.stringify({ tenantId, subject, skuCodes });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-bridge-request-id': randomUUID(),
          'x-bridge-timestamp': timestamp, 'x-bridge-nonce': nonce,
          'x-bridge-signature': signBody(`${timestamp}.${nonce}.${body}`, secret),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: 'unreachable', message: 'ALEMBIC could not be reached, so nothing was drafted. Try again shortly.' };
    }
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !raw || raw.ok !== true || !Array.isArray(raw.items)) {
      const outcome = raw && typeof raw.outcome === 'string' ? raw.outcome : `status ${res.status}`;
      return {
        ok: false, reason: 'refused',
        message: outcome === 'unknown_subject' || outcome === 'inactive' || outcome === 'no_roles'
          ? 'ALEMBIC does not recognise your linked account, so it would not draft. Ask an ALEMBIC administrator.'
          : 'ALEMBIC refused the request, so nothing was drafted.',
      };
    }
    return { ok: true, ai: typeof raw.ai === 'string' ? raw.ai : 'not_needed', items: raw.items as DraftsResult extends { items: infer I } ? I : never };
  }
}
