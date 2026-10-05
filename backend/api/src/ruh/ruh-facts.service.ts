/**
 * RuhFactsService — what Ruh looks at, read-only: one loader per detector group (ruh-detectors.ts).
 * Raw cross-schema SQL on the shared pool (the BFF read-model idiom), counts and ids; the Vault is
 * asked over the signed internal channel for COUNTS only (VaultApiClient.ruhSync), which also hands
 * back the overrides people made on the Vault box (RuhVaultSync turns those into admin alerts).
 *
 * Every loader is independent: when one fails (the Vault does not answer, a table is busy), only
 * that group's insights are left as they were this tick.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Sql } from 'postgres';
import { bridge as bridgeContracts } from '@core/contracts';
import { PG_CLIENT } from '@core/backend-kernel';
import { ProduceQueueService } from '@ra/cluster-production';
import { VaultApiClient, type VaultRuhOverride } from '@ra/cluster-formula';
import { SetupStatusService } from '../factory-setup/setup-status.service.js';
import { isoOf } from '../pg-timestamp.js';
import type {
  BridgeFacts, MaterialFacts, ProductionFacts, QcFacts, SetupFacts, ShelfFacts, StockFact, VaultFacts,
} from './ruh-detectors.js';
import type { RuhSettings } from './ruh-settings.service.js';
import { RuhSignalService } from './ruh-signal.service.js';
import { RUH_PRINCIPAL } from '@ra/cluster-org';

const num = (v: unknown) => Number(v ?? 0) || 0;
const hoursSince = (v: Date | string | null, now: Date) => (v ? (now.getTime() - new Date(isoOf(v)).getTime()) / 3_600_000 : 0);

@Injectable()
export class RuhFactsService {
  private readonly setupStatus: SetupStatusService;

  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    private readonly signals: RuhSignalService,
    @Optional() private readonly queue?: ProduceQueueService,
    @Optional() @Inject(VaultApiClient) private readonly vaultApi?: Pick<VaultApiClient, 'ruhSync'>,
  ) {
    // Counts only; the "formulas approved" figure (a Vault call) is not needed by Ruh's setup note.
    this.setupStatus = new SetupStatusService(sql);
  }

  /* ── production ─────────────────────────────────────────────────────────────────────── */

  async production(s: RuhSettings): Promise<ProductionFacts> {
    if (!this.queue) throw new Error('the production queue is not available here');
    const { items } = await this.queue.queue(500);
    const windowDays = s['production.throughputWindowDays'];
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const made = (await this.sql`
      select b.produced_qty::float as qty, u.uom_code
        from production.oil_batch_master b
        left join platform.uom_master u on u.uom_id = b.uom_id
       where coalesce(b.produced_dt, b.created_dt) >= ${since}::timestamptz
         and upper(coalesce(b.status, '')) <> 'FAILED' and b.produced_qty is not null`) as unknown as Array<{ qty: number; uom_code: string | null }>;
    let kg = 0;
    let batches = 0;
    for (const m of made) {
      const per = bridgeContracts.kgPerUnit(m.uom_code ?? 'kg');
      if (per === null) continue;
      kg += Number(m.qty) * per;
      batches++;
    }
    return {
      queue: items.filter((r) => r.lifecycleStatus !== 'CANCELLED').map((r) => ({
        id: r.alembicRequirementId, position: r.position, orderRef: r.orderRef, sku: r.sku, productCode: r.productCode,
        qtyKg: r.qtyKg, uom: r.uom, neededBy: r.neededBy, priorityRank: r.priorityRank, highValue: r.highValue,
        stage: r.stage, blockReason: r.blockReason,
      })),
      throughput: { kg, batches, windowDays },
    };
  }

  /* ── QC ─────────────────────────────────────────────────────────────────────────────── */

  async qc(now: Date): Promise<QcFacts> {
    const missing = (await this.sql`
      select b.oil_batch_id::text as id, b.batch_number, coalesce(b.produced_dt, b.created_dt) as at
        from production.oil_batch_master b
       where not exists (select 1 from production.batch_coa c where c.oil_batch_id = b.oil_batch_id)
         and upper(coalesce(b.status, '')) not in ('FAILED', 'REWORK')
       order by coalesce(b.produced_dt, b.created_dt) asc limit 500`) as unknown as Array<{ id: string; batch_number: string | null; at: Date | string | null }>;
    const waiting = (await this.sql`
      select c.batch_coa_id::text as id, b.batch_number, c.tested_dt as at
        from production.batch_coa c
        left join production.oil_batch_master b on b.oil_batch_id = c.oil_batch_id
       where c.status = 'TESTED' and c.overall_result = 'PASS'
       order by c.tested_dt asc limit 500`) as unknown as Array<{ id: string; batch_number: string | null; at: Date | string | null }>;
    const noSpec = (await this.sql`
      select p.product_id::text as id, p.product_code,
             (select count(*) from production.oil_batch_master b
               join production.production_order o on o.production_order_id = b.production_order_id
               join bridge.production_requirement r on r.production_order_id = o.production_order_id
               join packaging.product_sku s on s.sku_code = r.mapped_sku and s.product_id = p.product_id
              where not exists (select 1 from production.batch_coa c where c.oil_batch_id = b.oil_batch_id))::int as pending,
             (select count(*) from bridge.production_requirement r
               join packaging.product_sku s on s.sku_code = r.mapped_sku and s.product_id = p.product_id
              where r.lifecycle_status = 'ACCEPTED')::int as open_reqs
        from packaging.product_master p
       where not exists (select 1 from production.product_qc_spec q where q.product_id = p.product_id)
         and exists (select 1 from packaging.product_sku s join bridge.production_requirement r on r.mapped_sku = s.sku_code
                      where s.product_id = p.product_id and r.lifecycle_status = 'ACCEPTED')
       limit 200`) as unknown as Array<{ id: string; product_code: string | null; pending: number; open_reqs: number }>;
    const [props] = (await this.sql`
      select count(*) filter (where kind = 'qc_spec')::int as qc, count(*) filter (where kind = 'rack_layout')::int as rack
        from production.setup_proposal where status = 'proposed'`) as unknown as Array<{ qc: number; rack: number }>;
    return {
      coaMissing: missing.map((m) => ({ oilBatchId: m.id, batchNumber: m.batch_number, ageHours: hoursSince(m.at, now) })),
      releaseWaiting: waiting.map((w) => ({ batchCoaId: w.id, batchNumber: w.batch_number, ageHours: hoursSince(w.at, now) })),
      noSpec: noSpec.map((p) => ({ productId: p.id, productCode: p.product_code, pendingBatches: num(p.pending), openRequirements: num(p.open_reqs) })),
      proposals: { qcSpec: num(props?.qc), rackLayout: num(props?.rack) },
    };
  }

  /* ── factory setup ──────────────────────────────────────────────────────────────────── */

  async setup(): Promise<SetupFacts> {
    const c = await this.setupStatus.counts();
    return {
      catalogueProducts: c.catalogue.products,
      packsNeedingDensity: c.packs.productsNeedingDensity,
      qcSpecsMissing: c.qcSpecs.missing,
      bins: c.racks.bins,
      rackProposed: c.racks.proposed,
      pickLightMode: c.pickLight.mode,
      formulasUnlinked: Math.max(0, c.formulas.products - c.formulas.linked),
    };
  }

  /* ── the Vault (counts) + its overrides ─────────────────────────────────────────────── */

  /** Counts for the Vault insights, and the Vault's new overrides after `afterSeq` (null: Vault not wired). */
  async vault(s: RuhSettings, afterSeq: number): Promise<{ facts: VaultFacts; overrides: VaultRuhOverride[] | null }> {
    const [blocked] = (await this.sql`
      select count(*)::int as n from bridge.production_requirement
       where lifecycle_status = 'ACCEPTED' and production_order_id is null
         and produce_block_reason in ('NO_APPROVED_FORMULA', 'NO_FORMULA_LINK')`) as unknown as Array<{ n: number }>;
    const [grant] = (await this.sql`
      select count(*)::int as n from iam.vault_role_grant_request g
        join iam.user_master u on u.user_id = g.user_id
       where g.grant_status = 'PENDING' and g.expires_dt > now() and lower(u.email) = ${RUH_PRINCIPAL.email.toLowerCase()}`) as unknown as Array<{ n: number }>;
    let counts: VaultFacts['counts'] = null;
    let overrides: VaultRuhOverride[] | null = null;
    if (this.vaultApi) {
      try {
        const r = await this.vaultApi.ruhSync({ afterSeq, limit: 100, bulkApproveMinVersions: s['guard.bulkApproveMinVersions'] }, { timeoutMs: 8000 });
        counts = r.counts;
        overrides = r.overrides;
      } catch {
        counts = null; // the Vault did not answer: its counts are unknown this tick
      }
    }
    return { facts: { counts, formulaBlocked: num(blocked?.n), ruhGrantPending: num(grant?.n) > 0 }, overrides };
  }

  /* ── shelves and stock on hold ──────────────────────────────────────────────────────── */

  async shelf(now: Date): Promise<ShelfFacts> {
    const tasks = (await this.sql`
      select kind, count(*)::int as n, min(created_dt) as oldest,
             (array_agg(shelf_task_id::text order by created_dt asc))[1] as oldest_id
        from location.shelf_task where status = 'OPEN' and kind in ('PUTAWAY', 'PICK') group by kind`) as unknown as Array<{ kind: 'PUTAWAY' | 'PICK'; n: number; oldest: Date | string; oldest_id: string }>;
    const bins = (await this.sql`
      select bn.bin_id::text as id, rk.rack_code, sh.shelf_code, bn.bin_code,
             count(distinct st.finished_good_batch_id)::int as batches, coalesce(sum(st.qty), 0)::float as qty
        from location.fg_bin_stock st
        join location.bin_master bn on bn.bin_id = st.bin_id
        left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
        left join location.rack_master rk on rk.rack_id = sh.rack_id
       where st.qty > 0
       group by bn.bin_id, rk.rack_code, sh.shelf_code, bn.bin_code`) as unknown as Array<{ id: string; rack_code: string | null; shelf_code: string | null; bin_code: string | null; batches: number; qty: number }>;
    const [q] = (await this.sql`
      select count(*)::int as n, min(created_dt) as oldest from inventory.rm_batch_master where status = 'QUARANTINE'`) as unknown as Array<{ n: number; oldest: Date | string | null }>;
    const [pl] = (await this.sql`select count(*)::int as n from location.pick_light_command where status = 'PARKED'`) as unknown as Array<{ n: number }>;
    return {
      overdue: tasks.map((t) => ({ kind: t.kind, count: num(t.n), oldestHours: hoursSince(t.oldest, now), oldestTaskId: t.oldest_id })),
      bins: bins.map((b) => ({ binId: b.id, label: bridgeContracts.locationLabel(b.rack_code, b.shelf_code, b.bin_code) ?? b.bin_code ?? b.id.slice(0, 8), batches: num(b.batches), qty: num(b.qty) })),
      quarantine: { count: num(q?.n), oldestHours: hoursSince(q?.oldest ?? null, now) },
      pickLightParked: num(pl?.n),
    };
  }

  /* ── materials ──────────────────────────────────────────────────────────────────────── */

  async materials(s: RuhSettings): Promise<MaterialFacts> {
    const [nf] = (await this.sql`
      select count(*)::int as n,
             (array_agg(coalesce(m.material_code, m.material_name) order by m.material_code nulls last))[1:3] as sample
        from masterdata.material m
       where upper(coalesce(m.status, 'ACTIVE')) = 'ACTIVE'
         and not exists (select 1 from masterdata.rm_alias a where a.material_id = m.material_id
                          and upper(coalesce(a.status, 'ACTIVE')) = 'ACTIVE')`) as unknown as Array<{ n: number; sample: string[] | string | null }>;
    const window = s['stock.consumptionWindowDays'];
    const since = new Date(Date.now() - window * 86_400_000).toISOString();
    const rows = (await this.sql`
      with avail as (
        select ib.material_id, sum(greatest(coalesce(ib.quantity_on_hand, 0) - coalesce(r.reserved, 0), 0))::float as available,
               min(um.uom_code) as uom
          from inventory.inventory_batch ib
          left join platform.uom_master um on um.uom_id = ib.uom_id
          left join (select inventory_batch_id, sum(reserved_qty) reserved from inventory.stock_reservation
                      where released_dt is null and coalesce(status, 'ACTIVE') <> 'RELEASED' group by inventory_batch_id) r
                 on r.inventory_batch_id = ib.inventory_batch_id
          left join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
         where ib.material_id is not null and coalesce(rb.status, '') <> 'QUARANTINE'
         group by ib.material_id),
      used as (
        select ib.material_id, sum(abs(t.transaction_qty))::float as qty,
               count(distinct date_trunc('day', t.transaction_dt))::int as days
          from inventory.inventory_transaction t
          join inventory.inventory_batch ib on ib.inventory_batch_id = t.inventory_batch_id
          left join inventory.inventory_transaction_type_master tt on tt.inventory_transaction_type_id = t.inventory_transaction_type_id
         where t.transaction_dt >= ${since}::timestamptz
           and upper(coalesce(tt.type_code, '')) ~ '(ISSUE|CONSUME|OUT|PICK)'
         group by ib.material_id),
      planned as (
        select i.material_id, sum(coalesce(i.required_qty, 0))::float as need
          from production.production_order_ingredients i
          join production.production_order o on o.production_order_id = i.production_order_id
         where coalesce(i.issued_qty, false) = false and i.material_id is not null
           and upper(coalesce(o.status, '')) in ('PLANNING', 'INPROGRESS')
         group by i.material_id)
      select m.material_id::text as id, m.material_code, m.material_name,
             coalesce(a.available, 0)::float as available, a.uom,
             coalesce(us.qty, 0)::float as used, coalesce(us.days, 0)::int as days,
             (coalesce(p.need, 0) > coalesce(a.available, 0)) as short
        from masterdata.material m
        left join avail a on a.material_id = m.material_id
        left join used us on us.material_id = m.material_id
        left join planned p on p.material_id = m.material_id
       where (us.qty > 0 or p.need > 0)
       limit 2000`) as unknown as Array<{ id: string; material_code: string | null; material_name: string | null; available: number; uom: string | null; used: number; days: number; short: boolean }>;
    const sample = Array.isArray(nf?.sample) ? nf!.sample : typeof nf?.sample === 'string' ? nf.sample.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : [];
    const stock: StockFact[] = rows.map((r) => ({
      materialId: r.id, code: r.material_code, name: r.material_name, available: num(r.available), uom: r.uom,
      dailyUse: num(r.used) / window, shortForPlannedRuns: !!r.short, issueDays: num(r.days),
    }));
    return { noFloorCode: { count: num(nf?.n), sample: sample.map((x) => x.replace(/^"|"$/g, '')) }, stock };
  }

  /* ── the bridge and Ruh's own queue ─────────────────────────────────────────────────── */

  async bridge(): Promise<BridgeFacts> {
    const [conn] = (await this.sql`
      select enabled, (webhook_url is not null and hmac_secret_sealed is not null) as configured
        from bridge.connector_config where id = 'default'`) as unknown as Array<{ enabled: boolean; configured: boolean }>;
    const [out] = (await this.sql`
      select count(*) filter (where o.published_at is null and (d.outbox_id is null or (d.parked_at is null and d.discarded_at is null)))::int as waiting,
             count(*) filter (where o.published_at is null and d.parked_at is not null and d.discarded_at is null)::int as parked,
             min(o.occurred_at) filter (where o.published_at is null and d.parked_at is null and d.discarded_at is null) as oldest
        from bridge.outbox o left join bridge.outbox_delivery d on d.outbox_id = o.id`) as unknown as Array<{ waiting: number; parked: number; oldest: Date | string | null }>;
    const [cat] = (await this.sql`select count(*)::int as n, max(synced_at) as last from bridge.catalogue_item`) as unknown as Array<{ n: number; last: Date | string | null }>;
    const ruh = await this.signals.counts();
    return {
      connector: { configured: !!conn?.configured, enabled: !!conn?.enabled },
      outbound: { waiting: num(out?.waiting), parked: num(out?.parked), oldestWaitingAt: out?.oldest ? isoOf(out.oldest) : null },
      catalogue: { items: num(cat?.n), lastSyncedAt: cat?.last ? isoOf(cat.last) : null },
      ruhQueue: { waiting: ruh.waiting, parked: ruh.parked, oldestWaitingAt: ruh.oldestWaitingAt },
    };
  }
}
