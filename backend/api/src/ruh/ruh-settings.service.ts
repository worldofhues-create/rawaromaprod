/**
 * RuhSettingsService — Ruh's thresholds, set in the app (platform.ruh_setting; no .env, no
 * redeploy). Every key has a default that works out of the box; a stored value replaces it once a
 * person with `platform:ruh_setting:write` changes it. Each change is audited.
 *
 * The watch engine re-reads them every tick (cached for a few seconds), so a new interval or
 * threshold takes effect without a restart. The Vault's bulk-approval threshold travels to the
 * Vault box on the next sync (RuhVaultSync).
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { cleanOrigin, type ConsoleLinks } from './ruh.contract.js';

const hours = z.number().min(0).max(24 * 90);
const pct = z.number().min(0).max(100);
const origin = z.string().max(300).nullable().refine((v) => v === null || v === '' || cleanOrigin(v) !== null, 'an https address, like https://rawfactory.example.com');

/** Every setting, its type and its default. */
export const RUH_SETTINGS = z.object({
  /** How often the watch engine runs (seconds). 0 turns the engine off. */
  'watch.intervalSeconds': z.number().int().min(0).max(86_400).default(300),
  /** Mirror insights and overrides to ALEMBIC (C3). Off keeps everything local. */
  'signals.enabled': z.boolean().default(true),
  /** The consoles' public addresses, for links that open a record from ALEMBIC or another console. */
  'links.factoryUrl': origin.default(null),
  'links.platformUrl': origin.default(null),
  'links.vaultUrl': origin.default(null),
  /** An oil batch with no COA results after this many hours. */
  'qc.coaWaitHours': hours.default(24),
  /** A COA that passed but was not released after this many hours. */
  'qc.releaseWaitHours': hours.default(12),
  /** An open put-away or pick older than this. */
  'shelf.taskOverdueHours': hours.default(8),
  /** How many different batches one bin should hold. */
  'shelf.binMaxBatches': z.number().int().min(1).max(1000).default(4),
  /** Most units one bin should hold (null: not checked). */
  'shelf.binMaxQty': z.number().positive().max(1e9).nullable().default(null),
  /** "Nearly full" from this share of the limit. */
  'shelf.binNearPct': pct.default(80),
  /** Warn when a raw material's stock runs out within this many days at its recent use. */
  'stock.runoutWarnDays': z.number().min(0).max(365).default(7),
  /** How many days of issues the use rate is worked out from. */
  'stock.consumptionWindowDays': z.number().int().min(1).max(365).default(30),
  /** How many days of finished oil batches the production rate is worked out from. */
  'production.throughputWindowDays': z.number().int().min(1).max(365).default(14),
  /** Outbound events to ALEMBIC waiting longer than this mean the bridge is failing. */
  'bridge.staleMinutes': z.number().int().min(1).max(10_080).default(30),
  /** ALEMBIC's catalogue not refreshed for this long. */
  'catalogue.staleHours': hours.default(48),
  /** A COA value this close to a spec limit (share of the spec range) is "at the edge". */
  'guard.coaEdgeMarginPct': pct.default(5),
  /** Approving at least this many recipes at once, with calculation warnings, needs a reason. */
  'guard.bulkApproveMinVersions': z.number().int().min(1).max(200).default(5),
  /** Warn about turning pick-to-light off / to the simulator only in the production deployment. */
  'guard.pickLightProductionOnly': z.boolean().default(true),
});
export type RuhSettings = z.infer<typeof RUH_SETTINGS>;
export type RuhSettingKey = keyof RuhSettings;
export const RUH_SETTING_KEYS = Object.keys(RUH_SETTINGS.shape) as RuhSettingKey[];
export const RUH_DEFAULTS: RuhSettings = RUH_SETTINGS.parse({});

const CACHE_MS = 5_000;

export function linksOf(s: RuhSettings): ConsoleLinks {
  return { factory: cleanOrigin(s['links.factoryUrl']), platform: cleanOrigin(s['links.platformUrl']), vault: cleanOrigin(s['links.vaultUrl']) };
}

@Injectable()
export class RuhSettingsService {
  private cache: { at: number; value: RuhSettings } | null = null;

  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async get(): Promise<RuhSettings> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const rows = (await this.sql`select setting_key, value from platform.ruh_setting`) as Array<{ setting_key: string; value: unknown }>;
    const stored: Record<string, unknown> = {};
    for (const r of rows) {
      if (!(RUH_SETTING_KEYS as string[]).includes(r.setting_key)) continue;
      // A value that no longer validates falls back to the default for that key only.
      const one = (RUH_SETTINGS.shape as Record<string, z.ZodTypeAny>)[r.setting_key]!.safeParse(r.value);
      if (one.success) stored[r.setting_key] = one.data;
    }
    const value = RUH_SETTINGS.parse(stored);
    this.cache = { at: Date.now(), value };
    return value;
  }

  /** The settings, each with its default and whether it was changed. */
  async describe() {
    const v = await this.get();
    return RUH_SETTING_KEYS.map((key) => ({ key, value: v[key], default: RUH_DEFAULTS[key], changed: JSON.stringify(v[key]) !== JSON.stringify(RUH_DEFAULTS[key]) }));
  }

  /** Changes some settings; refuses the whole change if any value is not valid. Audited. */
  async update(input: Record<string, unknown>, principal: AuthPrincipal) {
    const entries = Object.entries(input ?? {});
    if (entries.length === 0) throw new BadRequestException('Name at least one setting to change.');
    const parsed: Array<[RuhSettingKey, unknown]> = [];
    for (const [key, raw] of entries) {
      if (!(RUH_SETTING_KEYS as string[]).includes(key)) throw new BadRequestException(`There is no Ruh setting called "${key}".`);
      const schema = (RUH_SETTINGS.shape as Record<string, z.ZodTypeAny>)[key]!;
      const value = raw === '' ? null : raw;
      const r = schema.safeParse(value);
      if (!r.success) throw new BadRequestException(`${key}: ${r.error.issues[0]?.message ?? 'not a valid value'}.`);
      parsed.push([key as RuhSettingKey, typeof r.data === 'string' ? (cleanOrigin(r.data) ?? r.data) : r.data]);
    }
    const before = await this.get();
    await this.sql.begin(async (tx) => {
      for (const [key, value] of parsed) {
        await tx`
          insert into platform.ruh_setting (setting_key, value, updated_by, updated_at)
          values (${key}, ${JSON.stringify(value)}::jsonb, ${principal.userId}::uuid, now())
          on conflict (setting_key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
      }
      await tx`
        insert into platform.audit_events (actor_id, action, entity_type, entity_id, before, after)
        values (${principal.userId}::uuid, 'ruh.settings.changed', 'ruh_setting', null,
                ${JSON.stringify(Object.fromEntries(parsed.map(([k]) => [k, before[k]])))}::jsonb,
                ${JSON.stringify(Object.fromEntries(parsed))}::jsonb)`;
    });
    this.cache = null;
    return this.describe();
  }
}
