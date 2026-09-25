/**
 * MaterialCatalogueSyncService — the MAIN box's half of the Vault console's material picker
 * (lane fread-rp, design (b)). Every VAULT_CATALOGUE_SYNC_MS it reads this box's material master
 * (id + code + name, nothing else) and makes sure the Vault holds exactly that catalogue:
 *
 *   1. probe  POST /internal/vault/material-catalogue { digest }            -> { current }
 *   2. only when not current: push the canonical rows in parts of MATERIAL_CATALOGUE_PART_SIZE,
 *      { digest, part, parts, materials }; the Vault swaps them in when the last part lands and
 *      the digest checks out (@ra/cluster-formula facts-bridge/material-catalogue.ts).
 *
 * The Vault box therefore never calls this box: the picker used to search through a Vault -> main
 * proxy (MaterialFactsClient, MAIN_API_INTERNAL_URL) that production and demo never had a network
 * path for. A new/renamed material reaches the picker within one interval; a restarted Vault gets
 * its catalogue back on the next probe. A failed round is retried after a short delay.
 *
 * Runs in the worker (WorkerModule; in production the in-process worker of main.ts). Does nothing
 * when this box has no VAULT_API_INTERNAL_URL / INTERNAL_BRIDGE_KEY (a single-box dev setup).
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService, PG_CLIENT } from '@core/backend-kernel';
import {
  VaultApiClient,
  catalogueParts,
  materialCatalogueDigest,
  type MaterialCatalogueEntry,
} from '@ra/cluster-formula';
import type { Sql } from 'postgres';

/** After a failed round, try again this soon (never later than the regular interval). */
export const CATALOGUE_RETRY_MS = 3_000;

export type CatalogueSyncResult = 'current' | 'pushed' | 'disabled';

@Injectable()
export class MaterialCatalogueSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaterialCatalogueSyncService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private lastError: string | null = null;

  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    @Inject(VaultApiClient) private readonly vault: Pick<VaultApiClient, 'materialCatalogue'>,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  private enabled(): boolean {
    return !!(this.config.get('VAULT_API_INTERNAL_URL') && this.config.get('INTERNAL_BRIDGE_KEY'));
  }

  onModuleInit(): void {
    if (!this.enabled()) {
      this.logger.log('Vault material catalogue sync is off: VAULT_API_INTERNAL_URL / INTERNAL_BRIDGE_KEY not set on this box.');
      return;
    }
    this.schedule(1_000);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    const interval = this.config.get('VAULT_CATALOGUE_SYNC_MS');
    let next = interval;
    try {
      await this.sync();
      if (this.lastError) this.logger.log('Vault material catalogue sync recovered.');
      this.lastError = null;
    } catch (err) {
      const msg = (err as Error).message;
      // Log a failure once, not on every retry, until it changes or recovers.
      if (msg !== this.lastError) this.logger.warn(`Vault material catalogue sync failed: ${msg}`);
      this.lastError = msg;
      next = Math.min(CATALOGUE_RETRY_MS, interval);
    } finally {
      this.schedule(next);
    }
  }

  /** One round: probe, and push when the Vault's catalogue differs from this box's. (Rounds never
   *  overlap: the next one is scheduled only after this one settles.) */
  async sync(): Promise<CatalogueSyncResult> {
    if (!this.enabled()) return 'disabled';
    const entries = await this.readCatalogue();
    const digest = materialCatalogueDigest(entries);
    if ((await this.vault.materialCatalogue({ digest })).current) return 'current';
    const parts = catalogueParts(entries);
    let current = false;
    for (const [part, materials] of parts.entries()) {
      current = (await this.vault.materialCatalogue({ digest, part, parts: parts.length, materials })).current;
    }
    if (!current) throw new Error('the Vault did not accept the pushed material catalogue');
    this.logger.log(`Vault material catalogue updated: ${entries.length} material(s) in ${parts.length} part(s).`);
    return 'pushed';
  }

  /** The three picker fields of every material, nothing else (no alias, cost, vendor, stock, QC). */
  private async readCatalogue(): Promise<MaterialCatalogueEntry[]> {
    const rows = await this.sql<{ material_id: string; material_code: string | null; material_name: string | null }[]>`
      select material_id::text as material_id, material_code, material_name from masterdata.material`;
    return rows.map((r) => ({ materialId: r.material_id, materialCode: r.material_code, materialName: r.material_name }));
  }
}
