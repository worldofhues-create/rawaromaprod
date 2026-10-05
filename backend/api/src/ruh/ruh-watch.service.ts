/**
 * RuhWatchService — the always-on watch engine (owner rulings 2026-10-06). Runs in the WORKER on a
 * timer whose interval is a Ruh setting (`watch.intervalSeconds`, default 5 minutes; 0 turns it
 * off), and on demand ("Check now"). Each pass:
 *
 *   1. gathers each detector group's facts (RuhFactsService) — deterministic reads and counts; no
 *      model is called on a tick (the AI budget is for a person pressing "Why?" in ALEMBIC);
 *   2. runs the pure detectors (ruh-detectors.ts) with the settings and the clock;
 *   3. syncs the insight store for the groups that ran (RuhInsightsService.sync): new findings
 *      open, changed ones update, gone ones clear — mirrored to ALEMBIC through the durable queue;
 *   4. turns overrides people made on the Vault box (pulled over the signed channel with the
 *      Vault's counts) into urgent admin alerts + C3 override signals, advancing a cursor in the
 *      same transaction so each is told once.
 *
 * A group whose facts fail to load is skipped for this pass and keeps its insights as they were.
 */
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { Sql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { RUH_VAULT_BULK_ACTION, type VaultRuhOverride } from '@ra/cluster-formula';
import {
  DETECTOR_KINDS, detectBridge, detectMaterials, detectProduction, detectQc, detectSetup, detectShelf, detectVault,
  type DetectorGroup,
} from './ruh-detectors.js';
import type { InsightDraft } from './ruh.contract.js';
import { RuhFactsService } from './ruh-facts.service.js';
import { RuhInsightsService, type SyncResult } from './ruh-insights.service.js';
import { RuhSettingsService } from './ruh-settings.service.js';
import { RuhSignalService } from './ruh-signal.service.js';

export const RUH_VAULT_CURSOR_ID = 'ruh_overrides';
/** The Vault-related insights this box can tell without asking the Vault. */
const VAULT_LOCAL_KINDS: readonly string[] = ['vault.formula_needed', 'vault.ruh_grant_pending'];
const TICK_MS = 15_000;

export interface WatchRun {
  at: string;
  ran: DetectorGroup[];
  failed: Array<{ group: DetectorGroup; error: string }>;
  insights: number;
  sync: SyncResult;
  vaultOverrides: number;
}

const VAULT_ACTION_LABELS: Record<string, string> = {
  [RUH_VAULT_BULK_ACTION]: 'approved many recipes at once in the Vault',
};

@Injectable()
export class RuhWatchService implements OnModuleDestroy {
  private readonly logger = new Logger(RuhWatchService.name);
  private running = false;
  private stopped = false;
  private lastRunAt = 0;
  private lastRun: WatchRun | null = null;

  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    private readonly settings: RuhSettingsService,
    private readonly facts: RuhFactsService,
    private readonly insights: RuhInsightsService,
    @Optional() private readonly signals?: RuhSignalService,
  ) {}

  onModuleDestroy(): void {
    this.stopped = true;
  }

  status() {
    return { lastRun: this.lastRun };
  }

  /** The worker's timer: runs a pass when the configured interval has passed (0 = off). */
  @Interval('ruh-watch', TICK_MS)
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    try {
      const every = (await this.settings.get())['watch.intervalSeconds'];
      if (every <= 0 || Date.now() - this.lastRunAt < every * 1000) return;
      await this.runOnce();
    } catch (err) {
      this.logger.warn(`ruh watch pass failed: ${(err as Error).message}`);
    }
  }

  /** The durable C3 queue drains on its own, faster timer. */
  @Interval('ruh-signal-drain', 5_000)
  async drainSignals(): Promise<void> {
    if (!this.stopped && this.signals) await this.signals.tick();
  }

  /** One full pass. Public: "Check now" and the tests call it with a fixed clock. */
  async runOnce(now: Date = new Date()): Promise<WatchRun> {
    if (this.running) return this.lastRun ?? this.emptyRun(now);
    this.running = true;
    try {
      const s = await this.settings.get();
      const drafts: InsightDraft[] = [];
      const ran: DetectorGroup[] = [];
      const failed: WatchRun['failed'] = [];
      let vaultOverrides: VaultRuhOverride[] | null = null;
      const partial: string[] = [];
      const group = async (name: DetectorGroup, fn: () => Promise<InsightDraft[] | { drafts: InsightDraft[]; kinds: readonly string[] }>) => {
        try {
          const r = await fn();
          if (Array.isArray(r)) { drafts.push(...r); ran.push(name); return; }
          drafts.push(...r.drafts);
          partial.push(...r.kinds);
        } catch (err) {
          failed.push({ group: name, error: (err as Error).message.slice(0, 300) });
        }
      };
      await group('production', async () => detectProduction(await this.facts.production(s), now));
      await group('qc', async () => detectQc(await this.facts.qc(now), s));
      await group('setup', async () => detectSetup(await this.facts.setup()));
      await group('vault', async () => {
        const cursor = await this.vaultCursor();
        const v = await this.facts.vault(s, cursor);
        vaultOverrides = v.overrides;
        if (v.facts.counts) return detectVault(v.facts);
        // The Vault did not answer (or is not wired here): its counts' insights stay as they were;
        // the two this box knows by itself are still checked.
        const kinds = VAULT_LOCAL_KINDS;
        return { drafts: detectVault(v.facts).filter((d) => kinds.includes(d.kind)), kinds };
      });
      await group('shelf', async () => detectShelf(await this.facts.shelf(now), s));
      await group('materials', async () => detectMaterials(await this.facts.materials(s), s, now));
      await group('bridge', async () => detectBridge(await this.facts.bridge(), s, now));

      const scope = [...ran.flatMap((g) => [...DETECTOR_KINDS[g]]), ...partial];
      const sync = await this.insights.sync(scope, drafts, now.toISOString());
      const told = vaultOverrides ? await this.applyVaultOverrides(vaultOverrides) : 0;
      if (failed.length) this.logger.warn(`ruh watch: ${failed.map((f) => `${f.group} (${f.error})`).join('; ')}`);
      this.lastRunAt = Date.now();
      this.lastRun = { at: now.toISOString(), ran, failed, insights: drafts.length, sync, vaultOverrides: told };
      return this.lastRun;
    } finally {
      this.running = false;
    }
  }

  private emptyRun(now: Date): WatchRun {
    return { at: now.toISOString(), ran: [], failed: [], insights: 0, sync: { opened: 0, updated: 0, cleared: 0 }, vaultOverrides: 0 };
  }

  private async vaultCursor(): Promise<number> {
    const [r] = (await this.sql`select last_seq from bridge.vault_sync_cursor where id = ${RUH_VAULT_CURSOR_ID}`) as unknown as Array<{ last_seq: string | number }>;
    return Number(r?.last_seq ?? 0);
  }

  /** Each Vault override → an urgent admin insight + a C3 override signal, once (cursor in the same transaction). */
  async applyVaultOverrides(overrides: readonly VaultRuhOverride[]): Promise<number> {
    let told = 0;
    for (const o of [...overrides].sort((a, b) => a.seq - b.seq)) {
      await this.sql.begin(async (tx) => {
        const [cur] = (await tx`select last_seq from bridge.vault_sync_cursor where id = ${RUH_VAULT_CURSOR_ID} for update`) as unknown as Array<{ last_seq: string | number }>;
        if (cur && Number(cur.last_seq) >= o.seq) return; // already told
        const principal = { userId: o.actorId, roles: [], permissions: [] } as unknown as AuthPrincipal;
        await this.insights.recordOverride({
          principal,
          guard: o.action,
          actionLabel: VAULT_ACTION_LABELS[o.action] ?? 'went ahead in the Vault despite a Ruh warning',
          reason: o.reason,
          risks: o.risks,
          console: 'vault',
          deepLink: '#/review',
          subject: { type: 'vault' },
          route: 'vault',
        }, tx);
        await tx`
          insert into bridge.vault_sync_cursor (id, last_seq, updated_at) values (${RUH_VAULT_CURSOR_ID}, ${o.seq}, now())
          on conflict (id) do update set last_seq = excluded.last_seq, updated_at = now()`;
        told++;
      });
    }
    return told;
  }
}
