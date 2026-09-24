/**
 * MaterialFactsClient — the Vault box's ONLY source of masterdata reads (material code/name,
 * RM_ALIAS), implemented as a signed HTTP call to the main app box instead of a local
 * `PG_CLIENT`-backed `MASTERDATA_DB` connection. Bound to `MASTERDATA_LOOKUP` by
 * `formula.module.ts` when `VAULT_MODE=true` (see that file's header for the design tradeoff:
 * a live read-only proxy call, chosen over a synced local catalog, so there is no replication
 * pipeline to keep fresh and no second copy of masterdata data at rest on the Vault box).
 *
 * This is the ONLY main-DB-shaped data the Vault box ever sees, and only ever the same minimal
 * shape `MasterdataLookup` already exposes to every other cluster — id + code/name/alias refs,
 * never cost/vendor/QC fields, never formula data flowing this direction. Deliberately NOT the
 * `FactsModule` (PB-06's RawProd Facts API, `backend/api/src/facts`) — that surface's own
 * contract (`facts.contract.ts`) explicitly closes off anything formula/vault-SHAPED
 * (`isNeverResolvable('vault_material_search') === true`); reusing it here would mean punching
 * a vault-shaped hole through a boundary that exists specifically to refuse one. This is a
 * separate, internal-only, signed channel (`internal-bridge-signing.ts`) that a browser can
 * never reach (no CORS, no user JWT accepted — see `InternalBridgeGuard`).
 *
 * Every call signs the outgoing request the same way `VaultPortHttpClient` does for the
 * opposite direction — see that file's doc comment for why HMAC-over-raw-bytes rather than a
 * bearer token.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService, computeInternalBridgeSignature } from '@core/backend-kernel';
import type { AliasRef, MasterdataLookup, MaterialRef } from '@ra/cluster-masterdata';

@Injectable()
export class MaterialFactsClient implements MasterdataLookup {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async findMaterial(materialId: string): Promise<MaterialRef | null> {
    return this.get<MaterialRef | null>(`/internal/vault-bridge/material/${encodeURIComponent(materialId)}`);
  }

  async findAliasForMaterial(materialId: string): Promise<AliasRef | null> {
    return this.get<AliasRef | null>(`/internal/vault-bridge/material-alias/${encodeURIComponent(materialId)}`);
  }

  async findAliasesForMaterials(materialIds: string[]): Promise<Map<string, AliasRef>> {
    if (materialIds.length === 0) return new Map();
    const entries = await this.post<Array<[string, AliasRef]>>('/internal/vault-bridge/material-aliases-batch', {
      materialIds,
    });
    return new Map(entries);
  }

  async searchMaterials(query: string, limit: number): Promise<MaterialRef[]> {
    const path = `/internal/vault-bridge/material-search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}`;
    return this.get<MaterialRef[]>(path);
  }

  private baseUrl(): string {
    const url = this.config.get('MAIN_API_INTERNAL_URL');
    if (!url) {
      throw new Error(
        'MAIN_API_INTERNAL_URL is not configured — the Vault box cannot reach the main API\'s ' +
          'material-facts bridge (MaterialFactsClient). Required whenever VAULT_MODE=true.',
      );
    }
    return url;
  }

  private key(): string {
    const key = this.config.get('INTERNAL_BRIDGE_KEY');
    if (!key) {
      throw new Error(
        'INTERNAL_BRIDGE_KEY is not configured — the Vault box cannot sign material-facts ' +
          'bridge requests (MaterialFactsClient). Required whenever VAULT_MODE=true.',
      );
    }
    return key;
  }

  private async get<T>(path: string): Promise<T> {
    return this.call<T>('GET', path, '');
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>('POST', path, JSON.stringify(body));
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body: string): Promise<T> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeInternalBridgeSignature(this.key(), { method, path, body, timestamp });
    const res = await fetch(`${this.baseUrl()}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-internal-signature': signature,
        'x-internal-timestamp': timestamp,
      },
      body: method === 'GET' ? undefined : body,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as { data?: T; error?: { message?: string } }) : {};
    if (!res.ok) {
      throw new Error(
        `material-facts bridge call ${method} ${path} failed (${res.status}): ${json.error?.message ?? text}`,
      );
    }
    return json.data as T;
  }
}
