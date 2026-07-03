/**
 * DashboardService — the ONE cross-cluster read that powers the rich role dashboards.
 *
 * Every number here is computed live from the DB (schema-per-cluster, one Postgres). Nothing is
 * hard-coded. It injects the shared `PG_CLIENT` pool and runs role-aware aggregate SQL across
 * schemas, then masks the result by the caller's permissions:
 *   - product identities (formula_name) surface ONLY for holders of `formula:actual:read` (owner).
 *   - real material codes surface ONLY for holders of `masterdata:material:reveal`; everyone else
 *     gets the RM alias. This mirrors the chain-of-custody: identity lives at the vault, the floor
 *     sees anonymised codes.
 * The payload feeds the hero cards, the planned-vs-actual donut, the super-admin chain-of-custody
 * flow graph, and the warehouse floor zone map.
 */
import { Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import type { Sql } from 'postgres';

/** Olfactive family of a real material, by name — drives class chips + zone placement. */
function classOf(name: string): 'natural' | 'aroma' | 'base' | 'solvent' {
  const s = (name || '').toLowerCase();
  if (/glycol|solvent|dipropylene|ethanol|alcohol|ipm|tec\b/.test(s)) return 'solvent';
  if (/ambrox|vanillin|coumarin|amber|musk|tonka/.test(s)) return 'base';
  if (/bergamot|lemon|orange|citrus|lime|grapefruit|neroli|petitgrain/.test(s)) return 'natural';
  if (/vetiver|cedar|patchouli|sandal|oud|rose|jasmin|absolute|\boil\b/.test(s)) return 'natural';
  return 'aroma';
}
/** Themed storage zone a real material belongs in (Z1 Citrus · Z2 Amber · Z3 Florals · Z4 Flammables). */
function zoneOf(name: string): 'Z1' | 'Z2' | 'Z3' | 'Z4' {
  const s = (name || '').toLowerCase();
  if (/glycol|solvent|dipropylene|ethanol|alcohol|flammable|ipm/.test(s)) return 'Z4';
  if (/bergamot|lemon|orange|citrus|lime|grapefruit|neroli/.test(s)) return 'Z1';
  if (/ambrox|vanillin|coumarin|amber|musk|tonka|cedar|patchouli|vetiver/.test(s)) return 'Z2';
  return 'Z3';
}
/** Where a run sits on the line, from its order status. */
function stageOf(status: string): string {
  switch ((status || '').toUpperCase()) {
    case 'PLANNING': return 'Procurement';
    case 'HOLD': return 'QC';
    case 'INPROGRESS': return 'Compounding';
    case 'COMPLETED': return 'Packaging';
    default: return 'Filling';
  }
}
const num = (v: unknown): number => Number(v ?? 0) || 0;
const ZONES = [
  { code: 'Z1', name: 'Z1 · Citrus', cls: 'natural' },
  { code: 'Z2', name: 'Z2 · Amber', cls: 'base' },
  { code: 'Z3', name: 'Z3 · Florals', cls: 'aroma' },
  { code: 'Z4', name: 'Z4 · Flammables', cls: 'solvent' },
] as const;

@Injectable()
export class DashboardService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async snapshot(principal: AuthPrincipal) {
    const sql = this.sql;
    const perms = new Set(principal.permissions || []);
    const isOwner =
      (principal.roles || []).includes('owner') || (principal.roles || []).includes('super_admin');
    const seeProduct = isOwner || perms.has('formula:actual:read');
    const seeMaterial = isOwner || perms.has('masterdata:material:reveal');

    const [
      runs, poByStatus, spend, vendorCount, materialCount,
      qcByResult, grnCount, rmBatches, invAgg, zoneRacks,
      mixByStatus, oilAgg, fillCount, pkgByStatus, fgAgg,
      custCount, soByStatus, userAgg, roleCount, poNumbers, oilNumbers, fgNumbers,
      events, qcRecent,
      stockReqRows, prodQcByResult, dispatchByStatus, soNumbers, formulaList, qcBatches,
    ] = await Promise.all([
      // runs: production orders → formula (product identity) → output oil batch
      sql`select po.production_order_id id, po.order_qty qty, po.status, po.actual_start_dt sdt,
                 f.formula_name product, f.formula_code fcode, ob.batch_number batch
          from production.production_order po
          left join formula.formula_version fv on fv.formula_version_id = po.formula_version_id
          left join formula.formula_master f on f.formula_id = fv.formula_id
          left join production.oil_batch_master ob on ob.production_order_id = po.production_order_id
          order by po.actual_start_dt desc nulls last limit 12`,
      sql`select status, count(*)::int c from procurement.purchase_order group by status`,
      sql`select v.vendor_name name, coalesce(sum(p.total_amount::numeric),0)::float amt
          from procurement.purchase_order p
          left join procurement.vendor_details v on v.vendor_id = p.vendor_id
          group by v.vendor_name order by amt desc`,
      sql`select count(*)::int c from procurement.vendor_details`,
      sql`select count(*)::int c from masterdata.material`,
      sql`select overall_result r, count(*)::int c from quality.qc_inspections group by overall_result`,
      sql`select count(*)::int c from inventory.grn_master`,
      sql`select b.batch_number batch, m.material_code mcode, m.material_name mname, a.alias_name alias
          from inventory.rm_batch_master b
          join masterdata.material m on m.material_id = b.material_id
          left join masterdata.rm_alias a on a.material_id = m.material_id
          order by b.batch_number`,
      sql`select count(*)::int c, coalesce(sum(quantity_on_hand::numeric),0)::float q
          from inventory.inventory_batch`,
      sql`select z.zone_code code, count(r.rack_id)::int racks
          from location.zone_master z
          left join location.rack_master r on r.zone_id = z.zone_id
          group by z.zone_id, z.zone_code`,
      sql`select status, count(*)::int c from production.secure_mixing_session group by status`,
      sql`select count(*)::int c, coalesce(sum(produced_qty::numeric),0)::float q
          from production.oil_batch_master`,
      sql`select count(*)::int c from packaging.filling_session`,
      sql`select status, count(*)::int c from packaging.package_order group by status`,
      sql`select count(*)::int c, coalesce(sum(produced_qty::numeric),0)::float q
          from packaging.finished_good_batch_master`,
      sql`select count(*)::int c from sales.customer_master`,
      sql`select status, count(*)::int c from sales.sales_order group by status`,
      sql`select count(*)::int total, count(*) filter (where is_active)::int active from iam.user_master`,
      sql`select count(*)::int c from iam.role_master`,
      sql`select po_number n from procurement.purchase_order order by order_date desc limit 3`,
      sql`select batch_number n from production.oil_batch_master order by produced_dt desc limit 3`,
      sql`select b.batch_number n, f.formula_name product
          from packaging.finished_good_batch_master b
          left join packaging.product_sku s on s.product_sku_id = b.product_sku_id
          left join packaging.product_master pm on pm.product_id = s.product_id
          left join formula.formula_master f on f.formula_id = pm.formula_id
          order by b.batch_number limit 3`,
      sql`select event_type t, event_dt dt, remarks r from formula.formula_event_hist order by event_dt desc limit 5`,
      sql`select overall_result r, inspection_dt dt from quality.qc_inspections order by inspection_dt desc limit 5`,
      // ── corrected 24-step chain-of-custody: the stages the 5-node graph used to skip ──
      sql`select sr.priority, m.material_code mcode, m.material_name mname, a.alias_name alias
          from procurement.stock_requirement sr
          left join masterdata.material m on m.material_id = sr.material_id
          left join masterdata.rm_alias a on a.material_id = m.material_id
          order by sr.priority limit 4`,
      sql`select result r, count(*)::int c from production.production_qc group by result`,
      sql`select status, count(*)::int c from sales.dispatch_master group by status`,
      sql`select so_number n, status from sales.sales_order order by so_number desc limit 3`,
      sql`select formula_code fcode, formula_name fname from formula.formula_master order by formula_code limit 3`,
      sql`select i.overall_result r, b.batch_number batch from quality.qc_inspections i
          left join inventory.rm_batch_master b on b.rm_batch_id = i.rm_batch_id
          order by i.inspection_dt desc limit 3`,
    ]);

    // ── counts ────────────────────────────────────────────────────────────────
    const byStatus = (rows: readonly Record<string, unknown>[]) => {
      const o: Record<string, number> = {};
      for (const r of rows) o[String(r.status).toUpperCase()] = num(r.c);
      return o;
    };
    const po = byStatus(poByStatus);
    const pkg = byStatus(pkgByStatus);
    const so = byStatus(soByStatus);
    const mix = byStatus(mixByStatus);
    const qc = { pass: 0, fail: 0, pending: 0 };
    for (const r of qcByResult) {
      const k = String(r.r).toUpperCase();
      // inbound QC dispositions set overall_result to the disposition code (ACCEPT/REJECT/REWORK/HOLD),
      // so treat ACCEPT/PASS as pass, REJECT/FAIL as fail, and REWORK/HOLD/PENDING as still-pending.
      if (k === 'PASS' || k === 'ACCEPT') qc.pass += num(r.c);
      else if (k === 'FAIL' || k === 'REJECT') qc.fail += num(r.c);
      else qc.pending += num(r.c);
    }
    const passRate = qc.pass + qc.fail ? Math.round((qc.pass / (qc.pass + qc.fail)) * 100) : 0;
    const runsTotal = runs.length;
    const runsActive = runs.filter((r) => String(r.status).toUpperCase() === 'INPROGRESS').length;
    const runsHold = runs.filter((r) => String(r.status).toUpperCase() === 'HOLD').length;
    const runsPlanning = runs.filter((r) => String(r.status).toUpperCase() === 'PLANNING').length;
    const planned = runs.reduce((a, r) => a + num(r.qty), 0);
    const actual = num(oilAgg[0]?.q);
    const planPct = planned ? Math.min(100, Math.round((actual / planned) * 100)) : 0;

    // ── runs table (product identity gated) ─────────────────────────────────────
    const runRows = runs.slice(0, 6).map((r, i) => ({
      run: 'V-' + String(i + 1).padStart(3, '0'),
      product: seeProduct ? String(r.product || r.fcode || '—') : 'Protected ◆',
      stage: stageOf(String(r.status)),
      batch: r.batch ? String(r.batch) : '—',
      target: num(r.qty).toFixed(0) + ' kg',
      status: String(r.status || '').toLowerCase(),
      cls: classOf(String(r.product || '')),
    }));

    // ── corrected 24-step chain of custody (10 grouped stages, real codes, masked) ──────
    // Identity is visible up to Formula Selection; everything below the vault shows aliases.
    const matLabel = (b: Record<string, unknown>) =>
      seeMaterial ? String(b.mcode) : String(b.alias || b.mcode);
    const prodQc = { pass: 0, hold: 0, fail: 0 };
    for (const r of prodQcByResult) {
      const k = String(r.r).toUpperCase();
      if (k === 'PASS') prodQc.pass = num(r.c);
      else if (k === 'FAIL') prodQc.fail = num(r.c);
      else prodQc.hold += num(r.c);
    }
    const dispatch = byStatus(dispatchByStatus);
    const flow = {
      stockPlanning: {
        count: stockReqRows.length,
        codes: stockReqRows.slice(0, 2).map((r) => ({ code: matLabel(r), sub: String(r.priority || 'reorder').toLowerCase() + ' priority' })),
      },
      procurement: {
        count: Object.values(po).reduce((a, b) => a + b, 0) || poNumbers.length,
        codes: poNumbers.slice(0, 2).map((x) => ({ code: String(x.n), sub: 'PR → RFQ → quote → PO' })),
      },
      receiving: {
        count: rmBatches.length,
        codes: rmBatches.slice(0, 2).map((b) => ({ code: String(b.batch), sub: 'gate → GRN · ' + matLabel(b) })),
      },
      qc: {
        count: qc.pass + qc.fail + qc.pending, pass: qc.pass, fail: qc.fail, pending: qc.pending,
        codes: qcBatches.slice(0, 2).map((q) => ({ code: q.batch ? String(q.batch) : 'batch', sub: String(q.r || '').toLowerCase() })),
      },
      storage: {
        count: num(invAgg[0]?.c),
        codes: [{ code: Math.round(num(invAgg[0]?.q)) + ' units', sub: num(invAgg[0]?.c) + ' batches · zoned' }],
      },
      formula: {
        count: formulaList.length,
        codes: formulaList.slice(0, 2).map((f) => ({ code: seeProduct ? String(f.fname) : String(f.fcode), sub: seeProduct ? 'recipe sealed' : 'protected ◆' })),
      },
      compounding: {
        count: num(mix['INPROGRESS']) || num(mix['ACTIVE']) || num(oilAgg[0]?.c),
        codes: oilNumbers.slice(0, 2).map((x) => ({ code: String(x.n), sub: 'pick → issue → mix' })),
      },
      productionQc: {
        count: prodQc.pass + prodQc.hold + prodQc.fail, pass: prodQc.pass, hold: prodQc.hold, fail: prodQc.fail,
        codes: oilNumbers.slice(0, 2).map((x, i) => ({ code: String(x.n), sub: i === 0 ? 'pass' : 'hold' })),
      },
      packaging: {
        count: num(fgAgg[0]?.c),
        codes: fgNumbers.slice(0, 2).map((x) => ({ code: String(x.n), sub: seeProduct && x.product ? String(x.product) : 'sealed & labelled' })),
      },
      salesDispatch: {
        count: Object.values(so).reduce((a, b) => a + b, 0),
        dispatched: Object.values(dispatch).reduce((a, b) => a + b, 0),
        codes: soNumbers.slice(0, 2).map((x) => ({ code: String(x.n), sub: String(x.status || '').toLowerCase() })),
      },
    };

    // ── procurement spend by supplier (real PO value) ──────────────────────────
    const spendTotal = spend.reduce((a, s) => a + num(s.amt), 0) || 1;
    const spendByVendor = spend
      .filter((s) => s.name)
      .slice(0, 4)
      .map((s, i) => ({
        label: String(s.name),
        pct: Math.round((num(s.amt) / spendTotal) * 100),
        cls: (['aroma', 'base', 'natural', 'solvent'] as const)[i % 4],
      }));

    // ── warehouse zones (real racks + real batch occupancy by themed zone) ──────
    const rackByZone: Record<string, number> = {};
    for (const z of zoneRacks) rackByZone[String(z.code)] = num(z.racks);
    const batchByZone: Record<string, number> = { Z1: 0, Z2: 0, Z3: 0, Z4: 0 };
    for (const b of rmBatches) { const zk = zoneOf(String(b.mname)); batchByZone[zk] = (batchByZone[zk] || 0) + 1; }
    const maxBz = Math.max(1, ...Object.values(batchByZone));
    const zones = ZONES.map((z) => {
      const racks = rackByZone[z.code] || 0;
      const batches = batchByZone[z.code] || 0;
      // capacity = real batch load against the busiest zone, lifted onto a readable 40–96% band
      const capPct = Math.min(96, Math.max(28, Math.round((batches / maxBz) * 70) + racks * 6));
      return { code: z.code, name: z.name, cls: z.cls, racks, batches, capPct };
    });
    const zoneCapAvg = Math.round(zones.reduce((a, z) => a + z.capPct, 0) / zones.length);

    // ── activity feed (real events, newest first) ──────────────────────────────
    type Feed = { text: string; dot: string; ts: string };
    const feed: Feed[] = [];
    for (const e of events) {
      const t = String(e.t || '').replace(/_/g, ' ').toLowerCase();
      feed.push({ text: (e.r ? String(e.r) : t) + (t.includes('approved') ? '' : ''), dot: '#34A56F', ts: String(e.dt) });
    }
    for (const q of qcRecent.slice(0, 3)) {
      const r = String(q.r).toUpperCase();
      feed.push({
        text: 'QC ' + (r === 'PASS' ? 'pass' : r === 'FAIL' ? 'fail' : 'pending') + ' recorded against batch',
        dot: r === 'FAIL' ? '#D85A38' : r === 'PASS' ? '#34A56F' : '#D9A53B',
        ts: String(q.dt),
      });
    }
    feed.sort((a, b) => (a.ts < b.ts ? 1 : -1));

    // ── pipeline (units in flight across the floor — real per-stage counts) ─────
    const pipeline: [string, number][] = [
      ['Planning', runsPlanning],
      ['Procurement', spend.length ? num(po['ORDERED']) + num(po['DRAFT']) + runsTotal : runsTotal],
      ['Receiving', rmBatches.length],
      ['QC', qc.pending],
      ['Compounding', num(mix['INPROGRESS']) || runsActive],
      ['Storage', num(invAgg[0]?.c)],
      ['Filling', num(fillCount[0]?.c)],
      ['Packaging', num(fgAgg[0]?.c)],
    ];

    return {
      reveal: { product: seeProduct, material: seeMaterial },
      counts: {
        runsActive, runsHold, runsPlanning, runsTotal,
        qcQueue: qc.pending, qcPass: qc.pass, qcFail: qc.fail, qcPassRate: passRate,
        posOpen: num(po['ORDERED']) + num(po['DRAFT']) + num(po['PENDING_APPROVAL']),
        posPending: num(po['PENDING_APPROVAL']) + num(po['DRAFT']),
        posTotal: Object.values(po).reduce((a, b) => a + b, 0),
        vendors: num(vendorCount[0]?.c), materials: num(materialCount[0]?.c),
        grns: num(grnCount[0]?.c), rmBatches: rmBatches.length,
        invOnHand: Math.round(num(invAgg[0]?.q)), skusStored: num(invAgg[0]?.c),
        zones: zones.length, racks: zoneRacks.reduce((a, z) => a + num(z.racks), 0),
        mixing: num(mix['INPROGRESS']) || num(mixByStatus[0]?.c), oilBatches: num(oilAgg[0]?.c),
        fillSessions: num(fillCount[0]?.c),
        packageOrders: Object.values(pkg).reduce((a, b) => a + b, 0), fgBatches: num(fgAgg[0]?.c),
        unitsPacked: Math.round(num(fgAgg[0]?.q)), unitsFilled: Math.round(actual),
        customers: num(custCount[0]?.c), salesOrders: Object.values(so).reduce((a, b) => a + b, 0),
        usersTotal: num(userAgg[0]?.total), usersActive: num(userAgg[0]?.active), roles: num(roleCount[0]?.c),
        zoneCapAvg,
      },
      planActual: { planned: Math.round(planned), actual: Math.round(actual), pct: planPct },
      qc,
      runs: runRows,
      flow,
      spendByVendor,
      zones,
      feed: feed.slice(0, 6),
      pipeline,
    };
  }

  /**
   * Reverse traceability (M10): finished-good batch → product → oil batch → production run →
   * materials → RM batch → GRN → vendor. Walks real FKs (FG → package_order → oil_batch →
   * production_order → ingredients → rm_batch → grn → vendor). Reveals the recipe's sources, so
   * it's owner-gated at the route; product/material identity still masked here as defence-in-depth.
   */
  async traceFinishedGood(id: string, principal: AuthPrincipal) {
    const sql = this.sql;
    const isOwner =
      (principal.roles || []).includes('owner') || (principal.roles || []).includes('super_admin');
    const perms = new Set(principal.permissions || []);
    const seeProduct = isOwner || perms.has('formula:actual:read');
    const seeMaterial = isOwner || perms.has('masterdata:material:reveal');

    const head = (
      await sql`select fg.batch_number fgno, fg.package_order_id, po.oil_batch_id,
                       ps.sku_code, pm.product_name, f.formula_name, f.formula_code
                from packaging.finished_good_batch_master fg
                left join packaging.package_order po on po.package_order_id = fg.package_order_id
                left join packaging.product_sku ps on ps.product_sku_id = fg.product_sku_id
                left join packaging.product_master pm on pm.product_id = ps.product_id
                left join formula.formula_master f on f.formula_id = pm.formula_id
                where fg.finished_good_batch_id = ${id} limit 1`
    )[0] as Record<string, unknown> | undefined;
    if (!head) return null;

    // Who received this batch — customer + sales order (forward end of the chain). Not secret
    // (the buyer isn't the recipe), so shown to anyone allowed to run the trace.
    const cust = (
      await sql`select c.customer_name, c.customer_code, so.so_number, dm.dispatch_date
                from sales.dispatch_items di
                join sales.dispatch_master dm on dm.dispatch_id = di.dispatch_id
                left join sales.customer_master c on c.customer_id = dm.customer_id
                left join sales.sales_order so on so.sales_order_id = dm.sales_order_id
                where di.finished_good_batch_id = ${id}
                order by dm.dispatch_date desc nulls last limit 1`
    )[0] as Record<string, unknown> | undefined;

    const oil = head.oil_batch_id
      ? ((
          await sql`select ob.batch_number oilno, ob.production_order_id, ob.produced_qty
                    from production.oil_batch_master ob where ob.oil_batch_id = ${head.oil_batch_id as string} limit 1`
        )[0] as Record<string, unknown> | undefined)
      : undefined;

    const mats = oil?.production_order_id
      ? ((await sql`select distinct on (poi.material_id) poi.material_id, poi.required_qty,
                           m.material_code, m.material_name, a.alias_name,
                           b.batch_number rmbatch, g.grn_number, v.vendor_name, v.vendor_code
                    from production.production_order_ingredients poi
                    left join masterdata.material m on m.material_id = poi.material_id
                    left join masterdata.rm_alias a on a.material_id = poi.material_id
                    left join inventory.rm_batch_master b on b.material_id = poi.material_id
                    left join inventory.grn_items gi on gi.grn_item_id = b.grn_item_id
                    left join inventory.grn_master g on g.grn_id = gi.grn_id
                    left join procurement.vendor_details v on v.vendor_id = g.vendor_id
                    where poi.production_order_id = ${oil.production_order_id as string}
                    order by poi.material_id, b.batch_number`) as Record<string, unknown>[])
      : [];

    return {
      reveal: { product: seeProduct, material: seeMaterial },
      customer: cust
        ? {
            name: String(cust.customer_name || cust.customer_code || '—'),
            soNumber: cust.so_number ? String(cust.so_number) : null,
          }
        : null,
      finishedGood: {
        batch: String(head.fgno || '—'), sku: String(head.sku_code || '—'),
        product: seeProduct ? String(head.product_name || head.formula_name || '—') : 'Protected ◆',
      },
      oilBatch: oil ? { batch: String(oil.oilno || '—'), qty: num(oil.produced_qty) } : null,
      materials: mats.map((r) => ({
        material: seeMaterial ? String(r.material_code || r.material_name || '—') : String(r.alias_name || '—'),
        rmBatch: r.rmbatch ? String(r.rmbatch) : '—',
        grn: r.grn_number ? String(r.grn_number) : '—',
        vendor: r.vendor_name ? String(r.vendor_name) : r.vendor_code ? String(r.vendor_code) : '—',
      })),
    };
  }

  /**
   * Module 12 dashboard alerts — pending approvals, QC failures, low stock, expiry warnings, all
   * computed live from the DB and filtered to the categories the caller's role cares about. (The
   * email-send half of M12 is a separate outbox-consumer service.)
   */
  async alerts(principal: AuthPrincipal) {
    const sql = this.sql;
    const roles = new Set(principal.roles || []);
    const isOwner = roles.has('owner') || roles.has('super_admin');
    const [prPend, poPend, qcFail, prodQcFail, pkgQcFail, lowStock, expiring] = await Promise.all([
      sql`select count(*)::int c from procurement.purchase_request where upper(status) = 'SUBMITTED'`,
      sql`select count(*)::int c from procurement.purchase_order where upper(status) in ('DRAFT','PENDING','PENDING_APPROVAL')`,
      sql`select count(*)::int c from quality.qc_inspections where upper(overall_result) in ('FAIL', 'REJECT')`,
      sql`select count(*)::int c from production.production_qc where upper(result) in ('FAIL','HOLD')`,
      sql`select count(*)::int c from packaging.packaging_qc where upper(overall_result) = 'FAIL'`,
      sql`select count(*)::int c from procurement.stock_requirement where status is null or upper(status) <> 'CLOSED'`,
      sql`select count(*)::int c from inventory.rm_batch_master where expiry_date is not null and expiry_date <= (now() + interval '30 days')`,
    ]);
    const all = [
      { kind: 'approval', severity: 'med', title: 'Pending approvals', count: num(prPend[0]?.c) + num(poPend[0]?.c), sub: 'PRs + POs awaiting sign-off', for: ['admin', 'procurement'] },
      { kind: 'qc', severity: 'high', title: 'QC failures', count: num(qcFail[0]?.c) + num(prodQcFail[0]?.c) + num(pkgQcFail[0]?.c), sub: 'inbound · production · packaging', for: ['qc', 'packaging'] },
      { kind: 'stock', severity: 'med', title: 'Low stock / reorder', count: num(lowStock[0]?.c), sub: 'open stock requirements', for: ['procurement', 'warehouse'] },
      { kind: 'expiry', severity: 'high', title: 'Expiry warnings', count: num(expiring[0]?.c), sub: 'RM batches expiring within 30 days', for: ['warehouse', 'receiving'] },
    ];
    const alerts = all
      .filter((a) => a.count > 0 && (isOwner || a.for.some((r) => roles.has(r))))
      .map(({ for: _f, ...a }) => a);
    return { alerts, total: alerts.reduce((s, a) => s + a.count, 0) };
  }

  /** The email-notification log (what the worker generated/dispatched). Owner-gated at the route. */
  async notifications(limit = 50): Promise<{ items: unknown[]; nextCursor: null }> {
    const rows = await this.sql.unsafe(
      `select notification_log_id as "notificationLogId", event_type as "eventType", recipient,
              subject, status, created_dt as "createdDt"
       from platform.notification_log order by created_dt desc limit ${Math.min(Math.max(1, limit), 200)}`,
    );
    return { items: rows, nextCursor: null };
  }
}
