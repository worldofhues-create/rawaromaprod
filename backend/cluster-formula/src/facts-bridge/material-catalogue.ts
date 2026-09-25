/**
 * The material catalogue the Vault console's draft editor searches (`GET /v1/vault/materials`),
 * PUSHED by the main app box over the existing main -> Vault signed channel and held in the Vault
 * process's memory. Bound to `MASTERDATA_LOOKUP` by `formula.module.ts` when `VAULT_MODE=true`.
 *
 * WHY A PUSH, NOT A VAULT -> MAIN CALL (release-convergence lane fread-rp). The Vault box used to
 * call the main API's material-facts bridge for every search (`MaterialFactsClient`,
 * MAIN_API_INTERNAL_URL). Production and demo never had that path: vault.env has no
 * MAIN_API_INTERNAL_URL, the app box's security group admits nothing from the Vault box, and
 * nginx does not proxy /internal/. Opening it would mean a new inbound rule on the app box (the
 * box ALEMBIC also runs on) and rawprod-api's whole port reachable from the Vault, i.e. two-way
 * trust between the boxes. Pushing keeps the one direction that already exists: the Vault box
 * never initiates a connection, and a compromised Vault gains no path into the main box.
 *
 * WHAT IS PUSHED: material id + code + name, the three fields the picker shows and the formulator
 * legitimately sees (they are the same fields the bridge returned). Never a floor code (RM alias),
 * cost, vendor, stock or QC field. Held in memory only: nothing about masterdata is written to
 * the Vault's disk or database, and a restarted Vault is refilled by the main box's next sync
 * (`MaterialCatalogueSyncService`, every VAULT_CATALOGUE_SYNC_MS). Until then a search says so
 * (503) instead of returning an empty list that looks like "no such material".
 *
 * PROTOCOL (`POST /internal/vault/material-catalogue`, InternalBridgeGuard-signed):
 *   { digest }                                   -> { current }   is this catalogue already held?
 *   { digest, part, parts, materials[<=500] }    -> { current }   one part of a full replacement;
 *     the Vault assembles the parts of ONE digest and swaps them in only when every part has
 *     arrived and the digest of what it received equals `digest`. A part of another digest starts
 *     over, so a sync interrupted halfway never leaves a mixed catalogue behind.
 */
import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AliasRef, MasterdataLookup, MaterialRef } from '@ra/cluster-masterdata';

/** One catalogue row: what the picker shows. */
export interface MaterialCatalogueEntry {
  materialId: string;
  materialCode: string | null;
  materialName: string | null;
}

/** Rows per push (a part stays well under the 1 MiB default request body limit). */
export const MATERIAL_CATALOGUE_PART_SIZE = 500;
/** Upper bound on parts in one catalogue (500 x 400 = 200,000 materials). */
export const MATERIAL_CATALOGUE_MAX_PARTS = 400;

/** Both boxes' canonical order: by material id (lower-cased), so the digest is order-independent. */
export function canonicalCatalogue(entries: readonly MaterialCatalogueEntry[]): MaterialCatalogueEntry[] {
  return entries
    .map((e) => ({
      materialId: e.materialId.trim().toLowerCase(),
      materialCode: e.materialCode ?? null,
      materialName: e.materialName ?? null,
    }))
    .sort((a, b) => (a.materialId < b.materialId ? -1 : a.materialId > b.materialId ? 1 : 0));
}

/** sha256 over the canonical rows — computed by the main box before a push, checked by the Vault. */
export function materialCatalogueDigest(entries: readonly MaterialCatalogueEntry[]): string {
  const rows = canonicalCatalogue(entries).map((e) => [e.materialId, e.materialCode, e.materialName]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** The canonical rows split into push-sized parts (at least one part, so an empty catalogue syncs). */
export function catalogueParts(entries: readonly MaterialCatalogueEntry[]): MaterialCatalogueEntry[][] {
  const rows = canonicalCatalogue(entries);
  const parts: MaterialCatalogueEntry[][] = [];
  for (let i = 0; i < rows.length; i += MATERIAL_CATALOGUE_PART_SIZE) parts.push(rows.slice(i, i + MATERIAL_CATALOGUE_PART_SIZE));
  return parts.length ? parts : [[]];
}

export interface CatalogueUpdate {
  digest: string;
  part?: number;
  parts?: number;
  materials?: MaterialCatalogueEntry[];
}

@Injectable()
export class MaterialCatalogue implements MasterdataLookup {
  private rows: MaterialCatalogueEntry[] | null = null;
  private byId = new Map<string, MaterialCatalogueEntry>();
  private digest: string | null = null;
  private pending: { digest: string; parts: number; received: Map<number, MaterialCatalogueEntry[]> } | null = null;

  /** Apply one probe or one part (see the header's protocol). */
  receive(update: CatalogueUpdate): { current: boolean } {
    if (update.materials === undefined) return { current: update.digest === this.digest };
    const parts = update.parts ?? 1;
    const part = update.part ?? 0;
    if (!Number.isInteger(parts) || parts < 1 || parts > MATERIAL_CATALOGUE_MAX_PARTS || !Number.isInteger(part) || part < 0 || part >= parts) {
      throw new BadRequestException(`material catalogue: part ${part} of ${parts} is out of range`);
    }
    if (!this.pending || this.pending.digest !== update.digest || this.pending.parts !== parts) {
      this.pending = { digest: update.digest, parts, received: new Map() };
    }
    this.pending.received.set(part, update.materials);
    if (this.pending.received.size < parts) return { current: false };

    const all: MaterialCatalogueEntry[] = [];
    for (let i = 0; i < parts; i++) all.push(...(this.pending.received.get(i) ?? []));
    this.pending = null;
    if (materialCatalogueDigest(all) !== update.digest) {
      throw new ConflictException('material catalogue: the received rows do not match their digest; kept the previous catalogue');
    }
    this.rows = [...all].sort((a, b) => cmpCode(a.materialCode, b.materialCode));
    this.byId = new Map(this.rows.map((r) => [r.materialId.toLowerCase(), r]));
    this.digest = update.digest;
    return { current: true };
  }

  /** Rows held (null until the first catalogue arrives). */
  size(): number | null {
    return this.rows ? this.rows.length : null;
  }

  private held(): MaterialCatalogueEntry[] {
    if (!this.rows) {
      throw new ServiceUnavailableException(
        'The material catalogue has not arrived from the RawProd factory box yet (it is pushed over the ' +
          'signed internal channel every VAULT_CATALOGUE_SYNC_MS). Try again shortly.',
      );
    }
    return this.rows;
  }

  async findMaterial(materialId: string): Promise<MaterialRef | null> {
    this.held();
    const row = this.byId.get(materialId.trim().toLowerCase());
    return row ? { ...row, uomId: null } : null;
  }

  /**
   * Same semantics as the main box's `MasterdataLookupService.searchMaterials`: case-insensitive
   * substring of code or name, ordered by code, capped to 1..50.
   */
  async searchMaterials(query: string, limit: number): Promise<MaterialRef[]> {
    const rows = this.held();
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const cap = Math.max(1, Math.min(limit, 50));
    const out: MaterialRef[] = [];
    for (const r of rows) {
      if ((r.materialCode ?? '').toLowerCase().includes(q) || (r.materialName ?? '').toLowerCase().includes(q)) {
        out.push({ ...r, uomId: null });
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  /** Floor codes (RM aliases) are not pushed to the Vault: the main box resolves them itself
   *  (keyed material references, material-ref.ts). Refuse rather than answer "no alias". */
  async findAliasForMaterial(_materialId: string): Promise<AliasRef | null> {
    throw new ServiceUnavailableException('Floor codes are not held on the Vault box; the main box resolves them.');
  }

  async findAliasesForMaterials(_materialIds: string[]): Promise<Map<string, AliasRef>> {
    throw new ServiceUnavailableException('Floor codes are not held on the Vault box; the main box resolves them.');
  }
}

/** Code order with nulls last, like Postgres' default `order by material_code`. */
function cmpCode(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}
