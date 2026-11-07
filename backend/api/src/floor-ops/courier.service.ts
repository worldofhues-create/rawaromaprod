/**
 * CourierService (lane pf-c, plan 9 + 12.6) — courier connectors, Shopify-style, and AWB checks.
 *
 * Phase 4 ships MANUAL AWB (scan or type). The connector infrastructure is built now:
 *   sales.courier_connector  provider, mode off | test | live, credentials SEALED with the same
 *                            AES-256-GCM KEK as the ALEMBIC connector secret (never returned, never
 *                            logged), the AWB format, health and last sync.
 *   connect                  the one-click Connect: credentials in, sealed, then a connection test.
 *   syncAll                  the worker's scheduled tracking sync, through the provider's adapter.
 *
 * No live courier integration exists yet, so no adapter is registered: Connect stores the sealed
 * credentials and reports "no integration yet", test/live refuse to turn on without an adapter,
 * and the station keeps working on manual AWB. An adapter (COURIER_ADAPTERS) is the only thing a
 * real integration adds.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { NoBridgeKek, openSecret, sealSecret } from '../bridge/secret-box.js';
import { iso } from './floor-util.js';
import { scanCode } from '../floor/scan-code.js';

export const COURIER_ADAPTERS = Symbol('COURIER_ADAPTERS');
export interface CourierAdapter {
  provider: string;
  /** Checks the credentials against the courier (test or live endpoint). */
  test(credentials: Record<string, unknown>, mode: 'test' | 'live'): Promise<{ ok: boolean; note?: string }>;
  /** Tracking for AWBs handed over to this courier. */
  track(awbs: string[], credentials: Record<string, unknown>, mode: 'test' | 'live'): Promise<Array<{ awb: string; status: string; at?: string }>>;
}

const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const AWB_RE = /^[A-Za-z0-9-]{6,40}$/;
const aad = (provider: string) => `sales:courier_connector:${provider}`;

@Injectable()
export class CourierService {
  private readonly adapters: Map<string, CourierAdapter>;
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql, @Optional() @Inject(COURIER_ADAPTERS) adapters?: CourierAdapter[]) {
    this.adapters = new Map((adapters ?? []).map((a) => [a.provider, a]));
  }

  async list() {
    const rows = await this.sql`select * from sales.courier_connector order by display_name`;
    return rows.map((r) => this.shape(r));
  }

  private async row(provider: string) {
    const [r] = await this.sql`select * from sales.courier_connector where provider = ${provider}`;
    if (!r) throw new NotFoundException(`Courier ${provider} is not set up.`);
    return r;
  }

  async upsert(provider: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    if (!PROVIDER_RE.test(provider)) throw new BadRequestException('provider: lower-case letters, digits, - or _ (e.g. delhivery).');
    const displayName = typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim().slice(0, 120) : null;
    const pattern = typeof body.awbPattern === 'string' && body.awbPattern.trim() ? body.awbPattern.trim() : null;
    if (pattern) {
      if (pattern.length > 200) throw new BadRequestException('awbPattern is too long.');
      try { new RegExp(`^(?:${pattern})$`); } catch { throw new BadRequestException('awbPattern is not a valid pattern.'); }
    }
    const tracking = typeof body.trackingUrlTemplate === 'string' && body.trackingUrlTemplate.trim() ? body.trackingUrlTemplate.trim() : null;
    if (tracking && (!/^https:\/\//.test(tracking) || !tracking.includes('{awb}') || tracking.length > 300)) {
      throw new BadRequestException('trackingUrlTemplate must be an https address containing {awb}.');
    }
    const [existing] = await this.sql`select provider from sales.courier_connector where provider = ${provider}`;
    if (!existing && !displayName) throw new BadRequestException('displayName is required for a new courier.');
    const [r] = await this.sql`
      insert into sales.courier_connector (provider, display_name, awb_pattern, tracking_url_template, updated_by, updated_at)
      values (${provider}, ${displayName ?? provider}, ${pattern}, ${tracking}, ${principal.userId}::uuid, now())
      on conflict (provider) do update set display_name = coalesce(${displayName}, sales.courier_connector.display_name),
        awb_pattern = ${pattern}, tracking_url_template = ${tracking}, updated_by = excluded.updated_by, updated_at = now()
      returning *`;
    if (body.mode !== undefined) return this.setMode(provider, body.mode, principal);
    return this.shape(r!);
  }

  /** One-click Connect: seal the credentials, then test the connection if an integration exists. */
  async connect(provider: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    await this.row(provider);
    const creds = body.credentials;
    if (!creds || typeof creds !== 'object' || Array.isArray(creds) || !Object.keys(creds).length) {
      throw new BadRequestException('credentials: the API key or login the courier gave you.');
    }
    const json = JSON.stringify(creds);
    if (json.length > 4000) throw new BadRequestException('credentials are too large.');
    let sealed: string;
    try {
      sealed = sealSecret(json, aad(provider));
    } catch (e) {
      if (e instanceof NoBridgeKek) throw new ConflictException('The server has no sealing key (BRIDGE_HMAC_KEK), so courier credentials cannot be stored. They are never stored in the clear.');
      throw e;
    }
    await this.sql`update sales.courier_connector set credentials_sealed = ${sealed}, updated_by = ${principal.userId}::uuid, updated_at = now() where provider = ${provider}`;
    return this.test(provider);
  }

  async disconnect(provider: string, principal: AuthPrincipal) {
    await this.row(provider);
    const [r] = await this.sql`
      update sales.courier_connector set credentials_sealed = null, mode = 'off', health = 'unknown', health_note = 'Disconnected.',
             updated_by = ${principal.userId}::uuid, updated_at = now() where provider = ${provider} returning *`;
    return this.shape(r!);
  }

  async test(provider: string) {
    const r = await this.row(provider);
    const adapter = this.adapters.get(provider);
    let health: string, note: string;
    if (!r.credentials_sealed) { health = 'unknown'; note = 'Not connected. The station uses manual AWB.'; }
    else if (!adapter) { health = 'no_adapter'; note = 'Credentials stored, sealed. There is no API integration for this courier yet, so the station uses manual AWB.'; }
    else {
      const creds = this.creds(r);
      if (!creds) { health = 'error'; note = 'The stored credentials cannot be opened (the sealing key changed). Connect again.'; }
      else {
        try {
          const t = await adapter.test(creds, r.mode === 'live' ? 'live' : 'test');
          health = t.ok ? 'ok' : 'error'; note = t.note ?? (t.ok ? 'Connection test passed.' : 'Connection test failed.');
        } catch (e) { health = 'error'; note = `Connection test failed: ${String((e as Error).message).slice(0, 200)}`; }
      }
    }
    const [u] = await this.sql`update sales.courier_connector set health = ${health}, health_note = ${note}, updated_at = now() where provider = ${provider} returning *`;
    return this.shape(u!);
  }

  async setMode(provider: string, mode: unknown, principal: AuthPrincipal) {
    if (mode !== 'off' && mode !== 'test' && mode !== 'live') throw new BadRequestException('mode is off, test or live.');
    const r = await this.row(provider);
    if (mode !== 'off') {
      if (!this.adapters.has(provider)) throw new ConflictException(`There is no ${mode} integration for ${r.display_name} yet. Keep it off; the station uses manual AWB.`);
      if (!r.credentials_sealed) throw new ConflictException('Connect the courier (credentials) first.');
      if (r.health !== 'ok') throw new ConflictException('Run a passing connection test before turning it on.');
    }
    const [u] = await this.sql`update sales.courier_connector set mode = ${mode}, updated_by = ${principal.userId}::uuid, updated_at = now() where provider = ${provider} returning *`;
    return this.shape(u!);
  }

  /** The scheduled tracking sync. Without an adapter nothing is called and the station is unaffected. */
  async syncAll() {
    const rows = await this.sql`select * from sales.courier_connector where mode in ('test', 'live')`;
    const out: Array<{ provider: string; tracked: number; health: string }> = [];
    for (const r of rows) {
      const adapter = this.adapters.get(String(r.provider));
      const creds = this.creds(r);
      let health = 'ok', note = '', tracked = 0;
      if (!adapter || !creds) { health = 'error'; note = adapter ? 'Credentials cannot be opened.' : 'No integration.'; }
      else {
        const awbs = (await this.sql`select awb from sales.shipment where courier_code = ${r.provider} and status = 'HANDED_OVER' and awb is not null and handed_over_at > now() - interval '30 days'`).map((s) => String(s.awb));
        try { tracked = (await adapter.track(awbs, creds, r.mode === 'live' ? 'live' : 'test')).length; note = `Tracked ${tracked}.`; }
        catch (e) { health = 'error'; note = `Sync failed: ${String((e as Error).message).slice(0, 200)}. The station falls back to manual.`; }
      }
      await this.sql`update sales.courier_connector set health = ${health}, health_note = ${note}, last_sync_at = now() where provider = ${r.provider}`;
      out.push({ provider: String(r.provider), tracked, health });
    }
    return out;
  }

  /** AWB checks: non-empty, a sane shape, and the courier's own format where we know it. */
  async validateAwb(courierCode: string, awb: unknown): Promise<string> {
    const a = typeof awb === 'string' ? scanCode(awb).toUpperCase() : ''; // SCAN-3
    if (!a) throw new BadRequestException('Scan or type the AWB.');
    if (!AWB_RE.test(a)) throw new BadRequestException('An AWB is 6 to 40 letters, digits or hyphens.');
    const [c] = await this.sql`select display_name, awb_pattern from sales.courier_connector where provider = ${courierCode}`;
    if (c?.awb_pattern && !new RegExp(`^(?:${c.awb_pattern})$`, 'i').test(a)) {
      throw new BadRequestException(`That is not a ${c.display_name} AWB (wrong format). Check the receipt.`);
    }
    return a;
  }

  private creds(r: Record<string, unknown>): Record<string, unknown> | null {
    if (!r.credentials_sealed) return null;
    const o = openSecret(String(r.credentials_sealed), aad(String(r.provider)));
    return o ? (JSON.parse(o) as Record<string, unknown>) : null;
  }

  private shape(r: Record<string, unknown>) {
    return {
      provider: String(r.provider), displayName: String(r.display_name), mode: String(r.mode),
      connected: !!r.credentials_sealed, hasIntegration: this.adapters.has(String(r.provider)),
      awbPattern: (r.awb_pattern as string | null) ?? null, trackingUrlTemplate: (r.tracking_url_template as string | null) ?? null,
      health: String(r.health), healthNote: (r.health_note as string | null) ?? null, lastSyncAt: iso(r.last_sync_at), updatedAt: iso(r.updated_at),
    };
  }
}
