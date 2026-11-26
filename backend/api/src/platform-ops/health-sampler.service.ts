/**
 * HealthSamplerService (B09, STUB-075): the history behind the Platform console's health tiles,
 * `GET /v1/platform/health/samples` (RAC OS apps/console/lib/platform/paths.js `rpHealthSamples`,
 * inventory HE-6: one sample every 30 s, kept 7 days, each series oldest first).
 *
 * Every SAMPLE_EVERY_MS this process takes one sample of what the tiles show:
 *   services          how many of the checks this box can make answer up: the main database
 *                     (the same SELECT 1 as GET /health) and, where a link is configured, the Vault
 *                     (its own /health over VAULT_API_INTERNAL_URL);
 *   servicesTotal     how many of those checks there were;
 *   outboxLagSeconds  the age of the oldest unpublished outbox row across every schema on the
 *                     shared pool (PlatformOpsService.deepHealth: the worker-lag proxy), 0 when none
 *                     waits;
 *   devicesOffline    devices marked offline (devices.service.ts sweepOffline: silent 60 s).
 * A figure that could not be read (the database was down) is null in its series, never a guess.
 *
 * The samples are held IN THIS PROCESS'S MEMORY, a ring of SAMPLES_KEPT (7 days at 30 s). Nothing
 * is written to any table: a restart starts the history again, and the answer says since when it
 * holds samples. Counts and seconds only: no row, no name, no payload.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';
import { PlatformOpsService } from './platform-ops.service.js';
import { PlatformReadsService, clampInt } from './platform-reads.service.js';

export const SAMPLE_EVERY_MS = 30_000;
export const SAMPLES_KEPT = (7 * 24 * 3600 * 1000) / SAMPLE_EVERY_MS; // 20 160
export const SAMPLES_DEFAULT = 7;
export const SAMPLES_MAX = 2_880; // one day

export interface HealthSample {
  at: string;
  services: number;
  servicesTotal: number;
  outboxLagSeconds: number | null;
  devicesOffline: number | null;
}

export interface HealthSamples {
  intervalSeconds: number;
  keptFor: string;
  /** The oldest sample this process holds (null before the first). */
  since: string | null;
  /** Samples held in all. */
  held: number;
  /** One entry per sample in this page, oldest first, the same length as every series. */
  at: string[];
  services: number[];
  servicesTotal: number[];
  outboxLagSeconds: (number | null)[];
  devicesOffline: (number | null)[];
  /** Skip this many newest samples to read the page before this one; null when there is none. */
  nextCursor: string | null;
  note: string;
}

@Injectable()
export class HealthSamplerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthSamplerService.name);
  private readonly ring: HealthSample[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    private readonly ops: PlatformOpsService,
    private readonly reads: PlatformReadsService,
  ) {}

  onModuleInit(): void {
    const tick = () => { this.sampleOnce().catch(() => this.logger.warn('a health sample could not be taken')); };
    tick();
    this.timer = setInterval(tick, SAMPLE_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Take one sample now and keep it (the oldest is dropped past SAMPLES_KEPT). */
  async sampleOnce(now: Date = new Date()): Promise<HealthSample> {
    let dbUp = false;
    let lag: number | null = null;
    try {
      const deep = await this.ops.deepHealth();
      dbUp = deep.database === 'up';
      lag = Math.max(0, ...deep.outbox.map((o) => (o.oldestUnpublishedSeconds == null ? 0 : Math.round(o.oldestUnpublishedSeconds))));
    } catch {
      dbUp = false;
      lag = null;
    }
    let offline: number | null = null;
    try {
      const [row] = await this.sql<Array<{ n: number }>>`select count(*)::int as n from platform.device_master where status = 'offline'`;
      offline = Number(row?.n ?? 0);
    } catch {
      offline = null;
    }
    const vault = await this.reads.vaultHealth().catch(() => null);
    const checks = [dbUp, ...(vault && vault.configured ? [vault.reachable === true && vault.status === 'ok'] : [])];
    const sample: HealthSample = {
      at: now.toISOString(), services: checks.filter(Boolean).length, servicesTotal: checks.length,
      outboxLagSeconds: lag, devicesOffline: offline,
    };
    this.ring.push(sample);
    if (this.ring.length > SAMPLES_KEPT) this.ring.splice(0, this.ring.length - SAMPLES_KEPT);
    return sample;
  }

  /** The newest `limit` samples (skipping `cursor` newer ones), oldest first. */
  samples(input: { limit?: unknown; cursor?: unknown } = {}): HealthSamples {
    const limit = clampInt(input.limit, SAMPLES_DEFAULT, 1, SAMPLES_MAX);
    const skip = clampInt(input.cursor, 0, 0, SAMPLES_KEPT);
    const end = Math.max(0, this.ring.length - skip);
    const page = this.ring.slice(Math.max(0, end - limit), end);
    const startIdx = end - page.length;
    return {
      intervalSeconds: SAMPLE_EVERY_MS / 1000, keptFor: '7 days', since: this.ring[0]?.at ?? null, held: this.ring.length,
      at: page.map((s) => s.at), services: page.map((s) => s.services), servicesTotal: page.map((s) => s.servicesTotal),
      outboxLagSeconds: page.map((s) => s.outboxLagSeconds), devicesOffline: page.map((s) => s.devicesOffline),
      nextCursor: startIdx > 0 ? String(skip + page.length) : null,
      note: 'Held in this process\'s memory, one sample every 30 s for 7 days; a restart starts the history again.',
    };
  }
}
