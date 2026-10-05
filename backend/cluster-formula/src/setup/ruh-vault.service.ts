/**
 * RuhVaultService — Ruh on the Vault box (owner rulings 2026-10-06). COUNTS AND STATUSES ONLY:
 * nothing here reads a recipe, an ingredient, a material or a formula name, and nothing it returns
 * names a formula.
 *
 *   bulkApproveRisks  the one Vault guard: one person approving MANY recipes at once (at least
 *                     `ruh.bulk_approve_min_versions`, pushed from the main box's Ruh settings) while
 *                     the IFRA/allergen calculation shows warnings for some of their formulas (the last
 *                     calculation came back "missing data" or "not configured", or the calculation
 *                     settings are not set at all). A WARNING, never a refusal: with a typed reason
 *                     the batch approval goes ahead exactly as before — author ≠ approver, the fresh
 *                     sign-in and every per-version rule still apply unchanged in ApprovalsService.
 *   recordOverride    the person continued: formula.ruh_override (action, reason, the risks in
 *                     numbers) + the hash-chained audit row. The main box pulls it (sync) and alerts
 *                     the admins; this box never calls out.
 *   sync              for the main box over the signed internal channel: overrides after a cursor,
 *                     the Vault's counts (recipes awaiting approval, recipes needed, formulas whose
 *                     calculation is incomplete), and it stores the threshold the main box pushes.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type AuthPrincipal } from '@core/backend-kernel';
import { FORMULA_DB, type FormulaDb } from '../formula.tokens.js';
import { VaultService } from '../vault.service.js';

export const RUH_BULK_MIN_KEY = 'ruh.bulk_approve_min_versions';
export const RUH_BULK_MIN_DEFAULT = 5;
export const RUH_VAULT_BULK_ACTION = 'vault.bulk_approve';

export interface VaultRisk {
  code: string;
  title: string;
  detail: string;
  severity: 'info' | 'suggest' | 'warn' | 'urgent';
}

export interface VaultRuhOverride {
  seq: number;
  overrideId: string;
  action: string;
  actorId: string;
  reason: string;
  risks: VaultRisk[];
  createdAt: string;
}

export interface VaultRuhCounts {
  awaitingApproval: number;
  recipesNeeded: number;
  complianceWarnings: number;
}

const n = (v: unknown) => Number(v ?? 0) || 0;
const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

@Injectable()
export class RuhVaultService {
  constructor(
    @Inject(FORMULA_DB) private readonly db: FormulaDb,
    private readonly vault: VaultService,
  ) {}

  async bulkMin(): Promise<number> {
    const rows = (await this.db.execute(sql`select setting_value from formula.compliance_setting where setting_key = ${RUH_BULK_MIN_KEY}`)) as unknown as Array<{ setting_value: string | null }>;
    const v = Number(rows[0]?.setting_value ?? RUH_BULK_MIN_DEFAULT);
    return Number.isInteger(v) && v >= 1 ? v : RUH_BULK_MIN_DEFAULT;
  }

  /** What Ruh would warn about for approving these versions in one go (pure read, no writes). */
  async bulkApproveRisks(versionIds: readonly string[]): Promise<VaultRisk[]> {
    const ids = [...new Set(versionIds)];
    const min = await this.bulkMin();
    if (ids.length < min) return [];
    const [settings] = (await this.db.execute(sql`
      select count(*) filter (where setting_key = 'ifra_amendment' and coalesce(btrim(setting_value), '') <> '')::int as ifra
        from formula.compliance_setting`)) as unknown as Array<{ ifra: number }>;
    const [w] = (await this.db.execute(sql`
      select count(distinct v.formula_id)::int as formulas,
             count(distinct v.formula_id) filter (where exists (
               select 1 from formula.compliance_calc_status c
                where c.formula_id = v.formula_id and c.outcome in ('MISSING_DATA', 'NOT_CONFIGURED')))::int as warned
        from formula.formula_version v
       where v.formula_version_id in ${ids}`)) as unknown as Array<{ formulas: number; warned: number }>;
    const formulas = n(w?.formulas);
    const settingsMissing = n(settings?.ifra) === 0;
    const warned = settingsMissing ? formulas : n(w?.warned);
    if (warned === 0) return [];
    return [{
      code: 'VAULT_BULK_APPROVE_CALC_WARNINGS',
      title: `Approving ${plural(ids.length, 'recipe', 'recipes')} at once while IFRA/allergen calculations show warnings`,
      detail: settingsMissing
        ? 'The IFRA amendment is not set in the calculation settings, so none of these formulas can get a certificate yet. Approving does not change that.'
        : `${plural(warned, 'formula', 'formulas')} of the ${formulas} had an incomplete IFRA/allergen calculation (raw-material data missing). Their certificates stay incomplete after approval until the data is added.`,
      severity: 'warn',
    }];
  }

  /** The person continued past the warning: kept here and on the audit chain; the main box pulls it. */
  async recordOverride(input: { principal: AuthPrincipal; action: string; reason: string; risks: VaultRisk[]; approved: number; refused: number }): Promise<void> {
    const risks = input.risks.map((r) => ({ ...r, detail: `${r.detail} Result: ${input.approved} approved, ${input.refused} not approved.` }));
    await this.db.execute(sql`
      insert into formula.ruh_override (action, actor_id, reason, risks)
      values (${input.action}, ${input.principal.userId}::uuid, ${input.reason}, ${JSON.stringify(risks)}::text::jsonb)`);
    await this.vault.writeStandaloneAudit({
      actorId: input.principal.userId, action: 'formula.ruh.override', entityType: 'formula_version_batch', entityId: null,
      reason: input.reason,
    });
  }

  /** The signed sync the main box's worker calls. */
  async sync(input: { afterSeq: number; limit: number; bulkApproveMinVersions?: number | null }): Promise<{ overrides: VaultRuhOverride[]; counts: VaultRuhCounts }> {
    if (input.bulkApproveMinVersions != null && Number.isInteger(input.bulkApproveMinVersions) && input.bulkApproveMinVersions >= 1) {
      await this.db.execute(sql`
        insert into formula.compliance_setting (setting_key, setting_value, updated_by)
        values (${RUH_BULK_MIN_KEY}, ${String(input.bulkApproveMinVersions)}, 'ruh')
        on conflict (setting_key) do update set setting_value = excluded.setting_value, updated_dt = now(), updated_by = 'ruh'`);
    }
    const rows = (await this.db.execute(sql`
      select seq, ruh_override_id::text as id, action, actor_id::text as actor_id, reason, risks, created_at
        from formula.ruh_override where seq > ${input.afterSeq} order by seq limit ${Math.min(Math.max(input.limit, 1), 200)}`)) as unknown as Array<{
      seq: string | number; id: string; action: string; actor_id: string; reason: string; risks: unknown; created_at: Date | string;
    }>;
    const [c] = (await this.db.execute(sql`
      select
        (select count(*) from formula.formula_version v
          where v.status in ('VERSIONED', 'REVIEW')
            and exists (select 1 from formula.formula_ingredients i where i.formula_version_id = v.formula_version_id))::int as awaiting,
        (select count(*) from formula.formula_product_link l
          where not exists (select 1 from formula.formula_version v
                             where v.formula_id = l.formula_id and v.status in ('VERSIONED', 'REVIEW', 'APPROVED', 'LOCKED', 'SUPERSEDED')))::int as needed,
        (select count(distinct formula_id) from formula.compliance_calc_status where outcome in ('MISSING_DATA', 'NOT_CONFIGURED'))::int as warned
    `)) as unknown as Array<{ awaiting: number; needed: number; warned: number }>;
    return {
      overrides: rows.map((r) => ({
        seq: Number(r.seq), overrideId: r.id, action: r.action, actorId: r.actor_id, reason: r.reason,
        risks: (typeof r.risks === 'string' ? JSON.parse(r.risks) : r.risks) as VaultRisk[],
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
      })),
      counts: { awaitingApproval: n(c?.awaiting), recipesNeeded: n(c?.needed), complianceWarnings: n(c?.warned) },
    };
  }
}
