/**
 * ProduceQueueService — the Factory's PRODUCTION QUEUE (lane produce, owner requirement
 * 2026-09-29): "alerts to PRODUCE based on FIFO + high-value orders first".
 *
 * ALEMBIC ranks (priority.rank, with reason high_value | fifo | promised_date — an order of
 * ₹25,000 or more is high value, owner decision 2026-09-29) and RawProd honours it: the queue is
 * every OPEN requirement (ACCEPTED, or REJECTED_MAPPING so an unknown SKU is visible), ordered by
 * priority.rank, then needed_by, then arrival — never re-ranked here. Each row says where the
 * requirement stands on the floor (to plan / blocked / planned / in production / QC / on the
 * shelf), the run serving it, and that run's formula as CODE + VERSION only (from the Vault over
 * the signed channel — never a name, material or percentage; the floor's coded manufacturing
 * instruction is the existing route, gated on production:manufacturing_instruction:read).
 *
 * Also: the counters (open, kg to produce, overdue, high value, blocked), the alert feed every
 * console polls (production.produce_alert after a cursor, role-filtered), the overdue sweep that
 * raises an alert once when an open requirement passes its need-by date, and the "formula needed"
 * list the Vault console shows its formulators/approvers.
 *
 * Read-only apart from the overdue sweep. Cross-schema reads are raw SQL inside this cluster, the
 * same idiom CoaService/PlanningService use.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { bridge as bridgeContracts } from '@core/contracts';
import { recordProduceAlert, type AuthPrincipal } from '@core/backend-kernel';
import { VaultApiClient } from '@ra/cluster-formula';
import { PRODUCTION_DB, type ProductionDb } from '../production.tokens.js';

/** Every factory console hears "produce this" alerts; owner sees every alert anyway. */
export const PRODUCE_ALERT_ROLES = ['production', 'compounding', 'qc', 'packaging', 'warehouse', 'filling'];
/** Who hears that a product has no approved formula: the two Vault roles and production. */
export const FORMULA_ALERT_ROLES = ['formulator', 'vault_approver', 'production'];

export type QueueStage =
  | 'UNKNOWN_SKU' | 'BLOCKED' | 'TO_PLAN' | 'PLANNED' | 'IN_PRODUCTION'
  | 'QC_PENDING' | 'QC_FAILED' | 'QC_PASSED' | 'QC_RELEASED' | 'READY_FOR_PUTAWAY' | 'ON_SHELF';

export interface QueueRow {
  alembicRequirementId: string;
  position: number;
  orderRef: string;
  orderRefs: string[];
  sku: string;
  packSize: string | null;
  productCode: string | null;
  qty: string;
  uom: string;
  qtyKg: number | null;
  neededBy: string;
  receivedAt: string;
  priorityRank: number | null;
  priorityReason: string | null;
  orderValueInr: number | null;
  lotPolicy: string | null;
  highValue: boolean;
  overdue: boolean;
  lifecycleStatus: string;
  stage: QueueStage;
  blockReason: string | null;
  blockMessage: string | null;
  productionOrderId: string | null;
  runStatus: string | null;
  runQty: string | null;
  formula: { code: string | null; version: number | null } | null;
  batchNo: string | null;
  qcStatus: string | null;
  fgBatchId: string | null;
  rack: string | null;
}

/** One alert in the consoles' feed (GET /v1/produce/alerts). */
export interface ProduceAlertRow {
  seq: number;
  kind: string;
  severity: string;
  title: string;
  detail: string | null;
  refType: string | null;
  refId: string | null;
  createdAt: string | Date;
}

export interface QueueCounters {
  open: number;
  kgToProduce: number;
  overdue: number;
  highValue: number;
  blocked: number;
  toPlan: number;
  qcFailed: number;
  readyForPutaway: number;
}

/** Plain words for the floor, one per block reason. */
export const BLOCK_MESSAGES: Record<string, string> = {
  NO_APPROVED_FORMULA: 'No approved formula for this product in the Vault — a formulator must seal and approve one',
  NO_FORMULA_LINK: 'No approved formula for this product in the Vault — a formulator must seal and approve one, and the product must be linked to it',
  UNKNOWN_SKU: 'This SKU is not in the factory catalogue — add it on the Product SKUs screen',
  QTY_NOT_IN_KG: 'The quantity is not in a unit of mass, so a run size cannot be worked out — ask ALEMBIC to resend it in kg',
};

interface RawQueueRow {
  alembic_requirement_id: string;
  order_ref: string;
  order_refs: unknown;
  mapped_sku: string;
  pack_size: string | null;
  product_code: string | null;
  formula_id: string | null;
  qty: string;
  uom: string;
  qty_kg: string | null;
  needed_by: Date | string;
  created_dt: Date | string;
  priority_rank: number | null;
  priority_reason: string | null;
  order_value_inr: string | null;
  lot_policy: string | null;
  lifecycle_status: string;
  produce_block_reason: string | null;
  production_order_id: string | null;
  run_status: string | null;
  run_qty: string | null;
  formula_version_id: string | null;
  batch_no: string | null;
  coa_status: string | null;
  coa_result: string | null;
  oil_batch_id: string | null;
  fg_batch_id: string | null;
  rack_code: string | null;
  shelf_code: string | null;
  bin_code: string | null;
  /** Filled in from the three codes after the query (bridge.locationLabel). */
  rack?: string | null;
}

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/** kg for a requirement: its qty_kg, else its qty converted from a mass unit; null otherwise. */
export function requirementKg(qtyKg: string | null, qty: string, uom: string): number | null {
  if (qtyKg !== null && qtyKg !== undefined && qtyKg !== '') return Number(qtyKg);
  const per = bridgeContracts.kgPerUnit(uom);
  return per === null ? null : Math.round(Number(qty) * per * 10_000) / 10_000;
}

/** Where a requirement stands on the floor. Pure — the queue test pins it. */
export function queueStage(r: Pick<RawQueueRow, 'lifecycle_status' | 'produce_block_reason' | 'production_order_id' | 'run_status' | 'oil_batch_id' | 'coa_status' | 'coa_result' | 'fg_batch_id' | 'rack'>): QueueStage {
  if (r.lifecycle_status === 'REJECTED_MAPPING') return 'UNKNOWN_SKU';
  if (!r.production_order_id) return r.produce_block_reason ? 'BLOCKED' : 'TO_PLAN';
  if (r.rack) return 'ON_SHELF';
  if (r.fg_batch_id && r.coa_status === 'RELEASED') return 'READY_FOR_PUTAWAY';
  if (r.coa_status === 'REJECTED' || (r.coa_status === 'TESTED' && r.coa_result === 'FAIL')) return 'QC_FAILED';
  if (r.coa_status === 'RELEASED') return 'QC_RELEASED';
  if (r.coa_status === 'TESTED') return 'QC_PASSED';
  if (r.oil_batch_id) return 'QC_PENDING';
  return String(r.run_status ?? '').toUpperCase() === 'PLANNING' ? 'PLANNED' : 'IN_PRODUCTION';
}

@Injectable()
export class ProduceQueueService {
  private readonly logger = new Logger(ProduceQueueService.name);

  constructor(
    @Inject(PRODUCTION_DB) private readonly db: ProductionDb,
    @Optional() @Inject(VaultApiClient) private readonly vault?: Pick<VaultApiClient, 'formulaLabels'>,
  ) {}

  /** The ranked queue of OPEN requirements (up to `limit`, default 200). */
  async queue(limit = 200): Promise<{ items: QueueRow[]; counters: QueueCounters; formulaLabels: 'ok' | 'unavailable' | 'none' }> {
    const lim = Math.min(Math.max(Math.trunc(limit) || 200, 1), 500);
    const raw = (await this.db.execute(sql`
      select r.alembic_requirement_id::text, r.order_ref, r.order_refs, r.mapped_sku, r.pack_size,
             pm.product_code, pm.formula_id::text,
             r.qty::text, r.uom, r.qty_kg::text, r.needed_by, r.created_dt,
             r.priority_rank, r.priority_reason, r.order_value_inr::text, r.lot_policy,
             r.lifecycle_status, r.produce_block_reason,
             r.production_order_id::text, o.status as run_status, o.order_qty::text as run_qty,
             o.formula_version_id::text,
             ob.batch_number as batch_no, ob.oil_batch_id::text, c.status as coa_status, c.overall_result as coa_result,
             fg.finished_good_batch_id::text as fg_batch_id, loc.rack_code, loc.shelf_code, loc.bin_code
        from bridge.production_requirement r
        left join lateral (
          select s.product_id from packaging.product_sku s where s.sku_code = r.mapped_sku order by s.product_sku_id limit 1
        ) sku on true
        left join packaging.product_master pm on pm.product_id = sku.product_id
        left join production.production_order o on o.production_order_id = r.production_order_id
        left join lateral (
          select b.oil_batch_id, b.batch_number from production.oil_batch_master b
           where b.production_order_id = r.production_order_id order by b.created_dt desc limit 1
        ) ob on true
        left join production.batch_coa c on c.oil_batch_id = ob.oil_batch_id
        left join lateral (
          select f.finished_good_batch_id from packaging.finished_good_batch_master f
            join packaging.package_order po on po.package_order_id = f.package_order_id
           where po.oil_batch_id = ob.oil_batch_id order by f.created_dt desc limit 1
        ) fg on true
        left join lateral (
          select rk.rack_code, sh.shelf_code, bn.bin_code
            from location.fg_bin_stock st
            join location.bin_master bn on bn.bin_id = st.bin_id
            left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
            left join location.rack_master rk on rk.rack_id = sh.rack_id
           where st.finished_good_batch_id = fg.finished_good_batch_id and st.qty > 0
           order by st.put_away_dt limit 1
        ) loc on true
       where r.lifecycle_status in ('ACCEPTED', 'REJECTED_MAPPING', 'CREATED')
       order by r.priority_rank asc nulls last, r.needed_by asc, r.created_dt asc, r.alembic_requirement_id asc
       limit ${lim}
    `)) as unknown as RawQueueRow[];

    for (const r of raw) r.rack = bridgeContracts.locationLabel(r.rack_code, r.shelf_code, r.bin_code);
    const labels = await this.formulaLabels(raw);
    const now = Date.now();
    const items: QueueRow[] = raw.map((r, i) => {
      const stage = queueStage(r);
      const kg = requirementKg(r.qty_kg, r.qty, r.uom);
      const onShelf = stage === 'ON_SHELF';
      const version = r.formula_version_id ? labels.versions.get(r.formula_version_id) : undefined;
      const approved = !r.formula_version_id && r.formula_id ? labels.approved.get(r.formula_id) : undefined;
      const formula = version ?? approved ?? null;
      return {
        alembicRequirementId: r.alembic_requirement_id,
        position: i + 1,
        orderRef: r.order_ref,
        orderRefs: Array.isArray(r.order_refs) ? (r.order_refs as string[]) : [r.order_ref],
        sku: r.mapped_sku,
        packSize: r.pack_size,
        productCode: r.product_code,
        qty: r.qty,
        uom: r.uom,
        qtyKg: kg,
        neededBy: iso(r.needed_by),
        receivedAt: iso(r.created_dt),
        priorityRank: r.priority_rank,
        priorityReason: r.priority_reason,
        orderValueInr: r.order_value_inr === null ? null : Number(r.order_value_inr),
        lotPolicy: r.lot_policy,
        highValue: bridgeContracts.isHighValue(r.priority_reason, r.order_value_inr),
        overdue: !onShelf && new Date(r.needed_by).getTime() < now,
        lifecycleStatus: r.lifecycle_status,
        stage,
        blockReason: stage === 'UNKNOWN_SKU' ? 'UNKNOWN_SKU' : stage === 'BLOCKED' ? r.produce_block_reason : null,
        blockMessage: stage === 'UNKNOWN_SKU' ? BLOCK_MESSAGES.UNKNOWN_SKU!
          : stage === 'BLOCKED' ? (BLOCK_MESSAGES[r.produce_block_reason ?? ''] ?? r.produce_block_reason) : null,
        productionOrderId: r.production_order_id,
        runStatus: r.run_status,
        runQty: r.run_qty,
        formula,
        batchNo: r.batch_no,
        qcStatus: r.coa_status === 'REJECTED' ? 'FAILED' : r.coa_status === 'RELEASED' ? 'RELEASED'
          : r.coa_status === 'TESTED' ? (r.coa_result === 'PASS' ? 'PASSED' : 'FAILED') : r.oil_batch_id ? 'PENDING' : null,
        fgBatchId: r.fg_batch_id,
        rack: r.rack ?? null,
      };
    });
    return { items, counters: countersOf(items), formulaLabels: labels.state };
  }

  /** Code + version for every run's version, and the approved version of every unplanned product's formula. */
  private async formulaLabels(rows: RawQueueRow[]) {
    const versionIds = [...new Set(rows.map((r) => r.formula_version_id).filter((v): v is string => !!v))];
    const formulaIds = [...new Set(rows.filter((r) => !r.formula_version_id).map((r) => r.formula_id).filter((v): v is string => !!v))];
    const versions = new Map<string, { code: string | null; version: number | null }>();
    const approved = new Map<string, { code: string | null; version: number | null }>();
    if ((versionIds.length === 0 && formulaIds.length === 0) || !this.vault) {
      return { versions, approved, state: 'none' as const };
    }
    try {
      const l = await this.vault.formulaLabels({ formulaVersionIds: versionIds, formulaIds }, { timeoutMs: 4000 });
      for (const v of l.versions) versions.set(v.formulaVersionId, { code: v.formulaCode, version: v.versionNumber });
      for (const f of l.formulas) {
        if (f.approvedVersion) approved.set(f.formulaId, { code: f.formulaCode, version: f.approvedVersion.versionNumber });
      }
      return { versions, approved, state: 'ok' as const };
    } catch (err) {
      this.logger.warn(`formula labels unavailable for the production queue: ${(err as Error).message}`);
      return { versions, approved, state: 'unavailable' as const };
    }
  }

  /**
   * Raises the overdue alert once for every open requirement that has passed its need-by date and
   * is not yet on a shelf. Idempotent (dedupe key + overdue_alerted_at). Returns how many it raised.
   */
  async sweepOverdue(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const due = (await tx.execute(sql`
        select r.alembic_requirement_id::text as id, r.mapped_sku, r.pack_size, r.qty::text, r.uom,
               r.qty_kg::text, r.needed_by, r.order_ref, r.order_refs
          from bridge.production_requirement r
         where r.lifecycle_status = 'ACCEPTED' and r.needed_by < now() and r.overdue_alerted_at is null
         order by r.needed_by
         limit 200
         for update skip locked
      `)) as unknown as Array<{ id: string; mapped_sku: string; pack_size: string | null; qty: string; uom: string; qty_kg: string | null; needed_by: Date | string; order_ref: string; order_refs: unknown }>;
      let raised = 0;
      for (const r of due) {
        const kg = requirementKg(r.qty_kg, r.qty, r.uom);
        const refs = Array.isArray(r.order_refs) ? (r.order_refs as string[]).join(', ') : r.order_ref;
        const isNew = await recordProduceAlert(tx, {
          kind: 'overdue_requirement', severity: 'high',
          title: `Overdue: ${r.mapped_sku}${r.pack_size ? ` (${r.pack_size})` : ''}`,
          detail: `${kg !== null ? `${kg} kg` : `${r.qty} ${r.uom}`} for ${refs} was needed by ${iso(r.needed_by).slice(0, 10)}`,
          roles: PRODUCE_ALERT_ROLES, refType: 'production_requirement', refId: r.id,
          dedupeKey: `overdue:${r.id}`,
        });
        await tx.execute(sql`update bridge.production_requirement set overdue_alerted_at = now() where alembic_requirement_id = ${r.id}::uuid`);
        if (isNew) raised++;
      }
      return raised;
    });
  }

  /** The alert feed after `after` (a seq), newest last, filtered to the caller's roles. */
  async alerts(principal: AuthPrincipal, after: number | null, limit = 50) {
    await this.sweepOverdue().catch((err) => this.logger.warn(`overdue sweep failed: ${(err as Error).message}`));
    const roles = principal.roles ?? [];
    const all = roles.includes('owner') || roles.includes('super_admin');
    const lim = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const rows = (await this.db.execute(sql`
      select seq, kind, severity, title, detail, ref_type as "refType", ref_id::text as "refId", created_at as "createdAt"
        from production.produce_alert
       where (${all} or roles && ${`{${roles.map((r) => `"${r.replace(/["\\{},]/g, '')}"`).join(',')}}`}::text[])
         and (${after}::bigint is null or seq > ${after}::bigint)
       order by seq desc
       limit ${lim}
    `)) as unknown as Array<Omit<ProduceAlertRow, 'seq'> & { seq: string | number }>;
    const items: ProduceAlertRow[] = rows.map((r) => ({ ...r, seq: Number(r.seq) })).reverse();
    const lastSeq = items.length ? items[items.length - 1]!.seq : after;
    return { items, lastSeq };
  }

  /**
   * Products the factory cannot plan because the Vault has no approved formula for them — the
   * Vault console's "formula needed" list. Product code + SKU + how much is waiting: no formula
   * content (this box has none to give).
   */
  async formulaNeeds() {
    return (await this.db.execute(sql`
      select coalesce(pm.product_code, r.mapped_sku) as "productCode",
             array_agg(distinct r.mapped_sku) as "skuCodes",
             count(*)::int as "requirementCount",
             sum(coalesce(r.qty_kg, 0))::float as "qtyKg",
             min(r.needed_by) as "earliestNeededBy",
             bool_or(r.priority_reason = 'high_value' or r.order_value_inr >= ${bridgeContracts.HIGH_VALUE_THRESHOLD_INR}) as "highValue",
             max(r.produce_blocked_at) as "blockedAt"
        from bridge.production_requirement r
        left join lateral (
          select s.product_id from packaging.product_sku s where s.sku_code = r.mapped_sku order by s.product_sku_id limit 1
        ) sku on true
        left join packaging.product_master pm on pm.product_id = sku.product_id
       where r.lifecycle_status = 'ACCEPTED' and r.production_order_id is null
         and r.produce_block_reason in ('NO_APPROVED_FORMULA', 'NO_FORMULA_LINK')
       group by coalesce(pm.product_code, r.mapped_sku)
       order by min(r.needed_by)
    `)) as unknown as Array<Record<string, unknown>>;
  }
}

/** Pure: the counters over the queue rows. */
export function countersOf(items: QueueRow[]): QueueCounters {
  const open = items.filter((r) => r.lifecycleStatus === 'ACCEPTED');
  const notYetMade = open.filter((r) => !['QC_RELEASED', 'READY_FOR_PUTAWAY', 'ON_SHELF'].includes(r.stage));
  return {
    open: open.length,
    kgToProduce: Math.round(notYetMade.reduce((s, r) => s + (r.qtyKg ?? 0), 0) * 1000) / 1000,
    overdue: open.filter((r) => r.overdue).length,
    highValue: open.filter((r) => r.highValue && r.stage !== 'ON_SHELF').length,
    blocked: open.filter((r) => r.stage === 'BLOCKED').length,
    toPlan: open.filter((r) => r.stage === 'TO_PLAN').length,
    qcFailed: open.filter((r) => r.stage === 'QC_FAILED').length,
    readyForPutaway: open.filter((r) => r.stage === 'READY_FOR_PUTAWAY').length,
  };
}
