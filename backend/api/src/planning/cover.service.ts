/**
 * PROD-D-4 — order intelligence (production-floor plan 11, 12.9): the suggested production list.
 *
 *   inflow       ALEMBIC orders land as ProductionRequirementCreated in bridge.production_requirement
 *                (ImporterService). Demand per SKU = the `order`-origin requirements of the last 26
 *                weeks, cancelled and unmapped ones left out, dated by arrival.
 *   stock        finished goods (produced - dispatched - consumed - reserved, latest packaging QC PASS,
 *                as FgStockService), in production (linked requirements whose production order is not
 *                closed and is not macerating), in maceration (an open maceration_run on the order's oil
 *                batch, with the date it is ready), and approved suggestions not yet on the floor.
 *   lead time    station medians from finished floor jobs (pipeline.ts), QC days from batch produced to
 *                its APPROVE round, the product's formula maceration minimum, and, when raw stock would
 *                run short, the slowest short material's vendor lead time.
 *   safety       an open QC hold on a batch of the product, or a held raw lot in its bill of materials,
 *                blocks the product outright. Raw stock is checked against the last production order's
 *                bill of materials scaled per unit; a shortage is named by floor code (never the
 *                material's name) and approving raises DRAFT purchase requests for it.
 *   policy       planning.cover through PolicyService, per product. It ships with no default: until an
 *                admin publishes rules every product HOLDS, and the response says so up front.
 *
 * Nothing auto-produces. A person approves or dismisses each suggestion; the server recomputes it at
 * that moment, so the stored reasoning is what was true when it was approved. Approved suggestions
 * join the floor queue below customer orders (floor-queue.service.ts, source SUGGESTED).
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { netQty, notTotalled, uuidv7 } from '@core/data-kernel';
import { availableIn, stockPosition } from '../inventory-view/stock-position.js';
import { PolicyService, PolicyUnresolved } from '../policy/policy.service.js';
import { parseCoverRule, suggestCover, WEEKS, type CoverRule, type CoverSuggestion, type DemandOrder } from './cover-model.js';
import { stationMedians } from '../floor/pipeline.js';

const DAY = 86_400_000;
type Row = Record<string, unknown>;

export interface RawLine { materialId: string; code: string; needQty: number; availableQty: number | null; shortQty: number | null; uomId: string | null; leadDays: number | null; unitNote?: string }

export interface CoverItem extends CoverSuggestion {
  productSkuId: string | null;
  productId: string | null;
  productName: string | null;
  raw: { checked: boolean; note: string; short: RawLine[] };
  policy: { ruleId: string | null; version: number | null; explain: string };
}

function codeText(colour: string, n: number) { return `${String(colour).toUpperCase()}-${String(n).padStart(4, '0')}`; }

@Injectable()
export class CoverService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql, private readonly policies: PolicyService) {}

  /** Lead-time parts shared by every product: station medians and QC days, measured. */
  private async measured(q: Sql | TransactionSql) {
    const done = await q<{ created_dt: string; picked_dt: string | null; verified_dt: string | null; mixed_dt: string | null }[]>`
      select created_dt::text, picked_dt::text, verified_dt::text, mixed_dt::text from production.floor_job
       where stage = 'DONE' and mixed_dt is not null order by mixed_dt desc limit 50`;
    const m = stationMedians(done.map((d) => ({ createdDt: d.created_dt, pickedDt: d.picked_dt, verifiedDt: d.verified_dt, mixedDt: d.mixed_dt })));
    const qc = await q<{ d: number }[]>`
      select extract(epoch from (r.created_dt - coalesce(ob.produced_dt, ob.created_dt)))::float8 / 86400 as d
        from quality.batch_qc_round r join production.oil_batch_master ob on ob.oil_batch_id = r.oil_batch_id
       where r.decision = 'APPROVE' order by r.created_dt desc limit 50`;
    const qs = qc.map((r) => Math.max(0, Number(r.d))).sort((a, b) => a - b);
    const qcDays = qs.length ? Math.round(qs[Math.floor(qs.length / 2)]! * 10) / 10 : null;
    const stationDays = m.PICK != null && m.VERIFY != null && m.MIX != null ? Math.round(((m.PICK + m.VERIFY + m.MIX) / DAY) * 10) / 10 : null;
    return { stationDays, qcDays, samples: m.samples };
  }

  private async ruleFor(sku: string, ctx: Row): Promise<{ rule: CoverRule | null; ruleId: string | null; version: number | null; explain: string }> {
    try {
      const r = await this.policies.evaluate('planning.cover', { record_type: 'product_sku', record_id: sku, sku, ...ctx });
      try { return { rule: parseCoverRule(r.value), ruleId: r.ruleId, version: r.version, explain: r.explain }; }
      catch (e) { return { rule: null, ruleId: r.ruleId, version: r.version, explain: (e as Error).message }; }
    } catch (e) {
      if (e instanceof PolicyUnresolved) return { rule: null, ruleId: null, version: e.version, explain: e.explain };
      throw e;
    }
  }

  /** Every SKU with demand in the window, or one SKU. */
  async compute(opts: { sku?: string | null; at?: Date } = {}, q: Sql | TransactionSql = this.sql): Promise<{ items: CoverItem[]; policyStatus: { published: boolean; version: number | null; note: string }; measured: { stationDays: number | null; qcDays: number | null; samples: number } }> {
    const now = opts.at ?? new Date();
    const since = new Date(now.getTime() - WEEKS * 7 * DAY).toISOString();
    const reqs = await q<{ mapped_sku: string; order_ref: string; qty: string; created_dt: string; flag: string | null }[]>`
      select r.mapped_sku, r.order_ref, r.qty::text, r.created_dt::text, f.flag
        from bridge.production_requirement r left join production.cover_order_flag f on f.order_ref = r.order_ref
       where coalesce(r.origin, 'order') = 'order' and r.created_dt >= ${since}::timestamptz and r.created_dt <= ${now.toISOString()}::timestamptz
         and upper(r.lifecycle_status) not in ('CANCELLED', 'REJECTED_MAPPING')
         ${opts.sku ? q`and r.mapped_sku = ${opts.sku}` : q``}`;
    const bySku = new Map<string, DemandOrder[]>();
    for (const r of reqs) {
      if (r.flag === 'EXCLUDE') continue;
      const list = bySku.get(r.mapped_sku) ?? [];
      list.push({ orderRef: r.order_ref, qty: Number(r.qty), at: r.created_dt, recurring: r.flag === 'RECURRING' });
      bySku.set(r.mapped_sku, list);
    }
    if (opts.sku && !bySku.has(opts.sku)) bySku.set(opts.sku, []);
    const meas = await this.measured(q);
    const latest = (await q<{ version: number; body: unknown }[]>`select version, body from platform.policy_version where policy_key = 'planning.cover' order by version desc limit 1`)[0];
    const body = latest ? ((typeof latest.body === 'string' ? JSON.parse(latest.body) : latest.body) as { rules?: unknown[]; hasDefault?: boolean }) : null;
    const published = !!body && ((body.rules?.length ?? 0) > 0 || body.hasDefault === true);
    const policyStatus = {
      published, version: latest?.version ?? null,
      note: published ? `planning.cover v${latest!.version} is in force.`
        : 'No planning.cover rules are published yet, so every product is held: nothing is suggested until an admin publishes rules on the Rules screen.',
    };

    const items: CoverItem[] = [];
    for (const [sku, orders] of [...bySku.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      items.push(await this.one(q, sku, orders, now, meas));
    }
    const rank: Record<string, number> = { SUGGEST: 0, BLOCKED: 1, HOLD: 2, LOCKED: 3, NONE: 4 };
    items.sort((a, b) => rank[a.status]! - rank[b.status]! || b.qty - a.qty || a.sku.localeCompare(b.sku));
    return { items, policyStatus, measured: meas };
  }

  private async one(q: Sql | TransactionSql, sku: string, orders: DemandOrder[], now: Date, meas: { stationDays: number | null; qcDays: number | null }): Promise<CoverItem> {
    const ps = (await q<{ product_sku_id: string; product_id: string | null; product_name: string | null; formula_id: string | null }[]>`
      select s.product_sku_id::text, s.product_id::text, pm.product_name, pm.formula_id::text
        from packaging.product_sku s left join packaging.product_master pm on pm.product_id = s.product_id
       where s.sku_code = ${sku} limit 1`)[0];
    const skuId = ps?.product_sku_id ?? null, productId = ps?.product_id ?? null;

    const fg = skuId ? Number((await q<{ n: string }[]>`
      select coalesce(sum(case when upper(coalesce(qc.overall_result,'')) <> 'PASS' then 0
               else greatest(0, coalesce(fg.produced_qty,0) - coalesce(d.dispatched,0) - coalesce(c.consumed,0) - coalesce(r.reserved,0)) end), 0)::text as n
        from packaging.finished_good_batch_master fg
        left join (select finished_good_batch_id, sum(dispatched_qty) dispatched from sales.dispatch_items where coalesce(status, 'ACTIVE') <> 'CANCELLED' group by finished_good_batch_id) d on d.finished_good_batch_id = fg.finished_good_batch_id
        left join (select finished_good_batch_id, sum(consumed_qty) consumed from packaging.finished_goods_batch_consumption where coalesce(status, 'ACTIVE') <> 'CANCELLED' group by finished_good_batch_id) c on c.finished_good_batch_id = fg.finished_good_batch_id
        left join (select finished_good_batch_id, sum(reserved_qty) reserved from packaging.finished_good_reservation where released_dt is null and coalesce(status, 'ACTIVE') <> 'RELEASED' group by finished_good_batch_id) r on r.finished_good_batch_id = fg.finished_good_batch_id
        left join (select distinct on (finished_good_batch_id) finished_good_batch_id, overall_result from packaging.packaging_qc order by finished_good_batch_id, created_dt desc) qc on qc.finished_good_batch_id = fg.finished_good_batch_id
       where fg.product_sku_id = ${skuId}`)[0]!.n) : 0;

    // Linked requirements whose production order is still open: macerating or not.
    const open = await q<{ qty: string; macerating: boolean; ready_at: string | null }[]>`
      select r.qty::text,
             exists (select 1 from production.oil_batch_master ob join production.maceration_run mr on mr.oil_batch_id = ob.oil_batch_id and mr.status = 'MACERATING'
                      where ob.production_order_id = po.production_order_id) as macerating,
             (select min(mr.started_at + make_interval(days => mr.min_days + mr.extend_days))::text from production.oil_batch_master ob
                join production.maceration_run mr on mr.oil_batch_id = ob.oil_batch_id and mr.status = 'MACERATING'
               where ob.production_order_id = po.production_order_id) as ready_at
        from bridge.production_requirement r join production.production_order po on po.production_order_id = r.production_order_id
       where r.mapped_sku = ${sku} and upper(coalesce(po.status, '')) not in ('COMPLETED', 'COMPLETE', 'CLOSED', 'CANCELLED')
         and upper(r.lifecycle_status) not in ('CANCELLED', 'COMPLETE')`;
    let inProd = 0, inMac = 0, readyBy: string | null = null;
    for (const o of open) {
      if (o.macerating) { inMac += Number(o.qty); if (o.ready_at && (!readyBy || o.ready_at > readyBy)) readyBy = o.ready_at; }
      else inProd += Number(o.qty);
    }
    const planned = Number((await q<{ n: string }[]>`select coalesce(sum(qty_units), 0)::text as n from production.cover_suggestion where sku_code = ${sku} and status = 'APPROVED' and floor_job_id is null`)[0]!.n);

    // Maceration days: the product's formula setting (lane C), minimum days when required.
    const mac = ps?.formula_id ? (await q<{ min_days: number }[]>`select min_days from production.maceration_setting where formula_id = ${ps.formula_id} and required`)[0] : undefined;
    const macerationDays = mac ? Number(mac.min_days) : 0;

    // Never suggest a product with an open QC hold on one of its batches or a held raw lot in its BOM.
    const blocked: string[] = [];
    const heldBatches = await q<{ batch_number: string | null; reason: string }[]>`
      select distinct ob.batch_number, h.reason from inventory.lot_hold h join production.oil_batch_master ob on ob.oil_batch_id = h.subject_id
       where h.subject_type = 'OIL_BATCH' and h.released_dt is null
         and (ob.production_order_id in (select production_order_id from bridge.production_requirement where mapped_sku = ${sku} and production_order_id is not null)
              or ob.oil_batch_id in (select r.oil_batch_id from quality.batch_qc_round r join quality.qc_checkpoint_set s on s.qc_checkpoint_set_id = r.qc_checkpoint_set_id where s.product_id = ${productId}))`;
    for (const b of heldBatches) blocked.push(`batch ${b.batch_number ?? '(unnumbered)'} is on hold (${String(b.reason).slice(0, 80)})`);

    const bom = await this.bomPerUnit(q, sku);
    if (bom.length) {
      const held = await q<{ material_id: string }[]>`
        select distinct ib.material_id::text from inventory.lot_hold h join inventory.inventory_batch ib on ib.rm_batch_id = h.subject_id
         where h.subject_type = 'RM_LOT' and h.released_dt is null and ib.material_id = any(${bom.map((b) => b.materialId)}::uuid[])`;
      for (const h of held) blocked.push(`a raw lot of ${await this.code(q, h.material_id)} is on hold`);
    }

    const pol = await this.ruleFor(sku, { product_id: productId, month: now.getUTCMonth() + 1, macerated: macerationDays > 0 });
    const base = { sku, now, orders, fgUnits: fg, inProductionUnits: inProd, inMacerationUnits: inMac, macerationReadyBy: readyBy, plannedUnits: planned, blocked, rule: pol.rule, ruleExplain: pol.explain };
    let s = suggestCover({ ...base, lead: { stationDays: meas.stationDays, qcDays: meas.qcDays, macerationDays } });
    let raw = { checked: false, note: 'Raw stock not checked: no earlier production order of this SKU gives a bill of materials.', short: [] as RawLine[] };
    if (s.status === 'SUGGEST' && bom.length) {
      let short = await this.rawShort(q, bom, s.qty);
      const rmLead = Math.max(0, ...short.map((l) => l.leadDays ?? 0));
      if (short.length && rmLead > 0) {
        // Raw short: the production lead time grows by the slowest short material's vendor lead time.
        const s2 = suggestCover({ ...base, lead: { stationDays: meas.stationDays, qcDays: meas.qcDays, macerationDays: macerationDays + rmLead } });
        s2.why = s2.why.replace(/\.$/, '') + ` (includes ${rmLead} days raw-material lead time).`;
        s = s2;
        short = await this.rawShort(q, bom, s.qty);
      }
      const counted = short.filter((l) => l.shortQty !== null), unsure = short.filter((l) => l.shortQty === null);
      const notes = [
        counted.length ? `Raw stock short for ${counted.map((l) => l.code).join(', ')}: approving raises a draft purchase request.` : '',
        ...unsure.map((l) => `${l.code} could not be checked. ${l.unitNote} No purchase request is raised for it.`),
      ].filter(Boolean);
      raw = { checked: true, short, note: notes.join(' ') || 'Raw stock covers it (bill of materials from the last production order of this SKU).' };
      if (counted.length) s.why = s.why.replace(/\.$/, '') + `; raw short: ${counted.map((l) => l.code).join(', ')}.`;
    }
    return { ...s, productSkuId: skuId, productId, productName: ps?.product_name ?? null, raw, policy: { ruleId: pol.ruleId, version: pol.version, explain: pol.explain } };
  }

  /** Per-unit material need from the most recent production order linked to this SKU. */
  private async bomPerUnit(q: Sql | TransactionSql, sku: string) {
    const po = (await q<{ production_order_id: string; order_qty: string | null }[]>`
      select po.production_order_id::text, po.order_qty::text from bridge.production_requirement r
        join production.production_order po on po.production_order_id = r.production_order_id
       where r.mapped_sku = ${sku} and po.order_qty > 0 order by po.created_dt desc limit 1`)[0];
    if (!po) return [];
    const ing = await q<{ material_id: string; required_qty: string; uom_id: string | null; uom_code: string | null }[]>`
      select i.material_id::text, i.required_qty::text, i.uom_id::text, u.uom_code from production.production_order_ingredients i
        left join platform.uom_master u on u.uom_id = i.uom_id
       where i.production_order_id = ${po.production_order_id} and i.material_id is not null and i.required_qty > 0`;
    return ing.map((i) => ({ materialId: i.material_id, perUnit: Number(i.required_qty) / Number(po.order_qty), uomId: i.uom_id, uomCode: i.uom_code }));
  }

  private async code(q: Sql | TransactionSql, materialId: string): Promise<string> {
    const r = (await q<{ colour_name: string; number: number }[]>`select f.colour_name, c.number from masterdata.floor_code c join masterdata.floor_family_colour f on f.family_code = c.family_code where c.material_id = ${materialId}`)[0];
    return r ? codeText(r.colour_name, r.number) : 'an uncoded material';
  }

  private async rawShort(q: Sql | TransactionSql, bom: Array<{ materialId: string; perUnit: number; uomId: string | null; uomCode: string | null }>, units: number): Promise<RawLine[]> {
    const out: RawLine[] = [];
    const positions = await stockPosition(q, bom.map((b) => b.materialId));
    for (const b of bom) {
      const need = Math.round(b.perUnit * units * 10000) / 10000;
      // STOCK2-3: netted exactly in the BOM's unit. A line that cannot be is shown, with no figure,
      // and raises no purchase request: an order for a number nobody could work out is worse than none.
      const p = positions.get(b.materialId);
      const avail = availableIn(p, b.uomCode);
      const gap = netQty([{ qty: need.toFixed(4), uom: b.uomCode }, ...(p?.reserved ?? [])], p?.onHand ?? [], b.uomCode);
      const bad = 'refused' in avail ? avail : 'refused' in gap ? gap : null;
      if (!bad && Number((gap as { qty: string }).qty) <= 0.0001) continue;
      const lead = (await q<{ d: number | null }[]>`select lead_time_days as d from procurement.vendor_rm_mapping where material_id = ${b.materialId} order by is_preferred desc nulls last, created_dt limit 1`)[0];
      const line = { materialId: b.materialId, code: await this.code(q, b.materialId), needQty: need, uomId: b.uomId, leadDays: lead?.d ?? null };
      if (bad) out.push({ ...line, availableQty: null, shortQty: null, unitNote: notTotalled(bad as { refused: string; units: string[] }) });
      else out.push({ ...line, availableQty: Number((avail as { qty: string }).qty), shortQty: Math.round(Number((gap as { qty: string }).qty) * 10000) / 10000 });
    }
    return out;
  }

  /** A person approves one suggestion: recomputed now, stored with its reasoning; raw shortage -> draft PRs. */
  async approve(body: Row, principal: AuthPrincipal, at?: Date) {
    const sku = String(body.sku ?? '').trim();
    if (!sku) throw new BadRequestException('Choose the product to approve.');
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'cover:' + sku}))`;
      const it = (await this.compute({ sku, at }, tx)).items[0];
      if (!it) throw new NotFoundException('No suggestion for that product.');
      if (it.status !== 'SUGGEST') throw new ConflictException(`Nothing to approve: ${it.why}`);
      let qty = it.qty;
      if (body.qty != null) {
        const q = body.qty;
        if (typeof q !== 'number' || !Number.isInteger(q) || q < 1) throw new BadRequestException('The quantity is a whole number of units, 1 or more.');
        if (!String(body.note ?? '').trim() && q !== it.qty) throw new BadRequestException('Say why the approved quantity differs from the suggestion.');
        qty = q;
      }
      const prIds: string[] = [];
      const short = qty === it.qty ? it.raw.short : it.raw.checked ? await this.rawShort(tx, await this.bomPerUnit(tx, sku), qty) : [];
      for (const l of short) {
        if (l.shortQty === null) continue; // STOCK2-3: not a figure, so not an order
        const srId = uuidv7(), prId = uuidv7();
        await tx`insert into procurement.stock_requirement (stock_requirement_id, material_id, required_qty, uom_id, requirement_source, priority, status, created_by, updated_by)
                 values (${srId}, ${l.materialId}, ${l.shortQty}, ${l.uomId}, ${'COVER_SUGGESTION:' + sku}, 'NORMAL', 'OPEN', ${principal.userId}, ${principal.userId})`;
        await tx`insert into procurement.purchase_request (purchase_request_id, pr_number, stock_requirement_id, priority, status, created_by, updated_by)
                 values (${prId}, ${'PR-COVER-' + prId.replace(/-/g, '').slice(-8).toUpperCase()}, ${srId}, 'NORMAL', 'DRAFT', ${principal.userId}, ${principal.userId})`;
        await tx`insert into procurement.purchase_request_items (purchase_request_item_id, purchase_request_id, material_id, required_qty, uom_id, status, created_by, updated_by)
                 values (${uuidv7()}, ${prId}, ${l.materialId}, ${l.shortQty}, ${l.uomId}, 'ACTIVE', ${principal.userId}, ${principal.userId})`;
        prIds.push(prId);
      }
      const reasoning = qty === it.qty ? it.why : `${it.why} Approved ${qty} instead: ${String(body.note).trim()}`;
      const row = (await tx`insert into production.cover_suggestion (sku_code, product_sku_id, qty_units, suggested_units, reasoning, inputs, policy_rule_id, policy_version, status, decided_by, note, purchase_request_ids)
        values (${sku}, ${it.productSkuId}, ${qty}, ${it.qty}, ${reasoning}, ${JSON.stringify({ numbers: it.numbers, raw: it.raw })}::jsonb, ${it.policy.ruleId}, ${it.policy.version ?? 0},
                'APPROVED', ${principal.userId}, ${(body.note as string) ?? null}, ${JSON.stringify(prIds)}::jsonb)
        returning cover_suggestion_id::text as id`)[0]!;
      return { coverSuggestionId: row.id, sku, qty, reasoning, purchaseRequestIds: prIds,
        next: 'Joins the floor queue below customer orders once production opens a job for it.' };
    });
  }

  async dismiss(body: Row, principal: AuthPrincipal, at?: Date) {
    const sku = String(body.sku ?? '').trim(), note = String(body.note ?? '').trim();
    if (!sku) throw new BadRequestException('Choose the product.');
    if (!note) throw new BadRequestException('Say why the suggestion is dismissed.');
    const it = (await this.compute({ sku, at })).items[0];
    if (!it || it.status !== 'SUGGEST') throw new ConflictException('There is no open suggestion for that product.');
    const row = (await this.sql`insert into production.cover_suggestion (sku_code, product_sku_id, qty_units, suggested_units, reasoning, inputs, policy_rule_id, policy_version, status, decided_by, note)
      values (${sku}, ${it.productSkuId}, 0, ${it.qty}, ${it.why}, ${JSON.stringify({ numbers: it.numbers, raw: it.raw })}::jsonb, ${it.policy.ruleId}, ${it.policy.version ?? 0}, 'DISMISSED', ${principal.userId}, ${note})
      returning cover_suggestion_id::text as id`)[0]!;
    return { coverSuggestionId: row.id, sku, status: 'DISMISSED' };
  }

  async decided(limit = 50) {
    const rows = await this.sql`select cover_suggestion_id::text as "coverSuggestionId", sku_code as sku, qty_units as qty, suggested_units as "suggestedQty", reasoning, status,
        decided_by as "decidedBy", decided_dt as "decidedDt", note, purchase_request_ids as "purchaseRequestIds", floor_job_id::text as "floorJobId", policy_version as "policyVersion"
      from production.cover_suggestion order by decided_dt desc limit ${Math.min(Math.max(1, limit), 200)}`;
    return rows;
  }

  /** Mark an ALEMBIC order recurring (kept even if it looks one-off) or excluded from demand. */
  async flagOrder(body: Row, principal: AuthPrincipal) {
    const ref = String(body.orderRef ?? '').trim(), flag = String(body.flag ?? '').toUpperCase(), reason = String(body.reason ?? '').trim();
    if (!ref) throw new BadRequestException('Name the order.');
    if (flag !== 'RECURRING' && flag !== 'EXCLUDE') throw new BadRequestException('The flag is RECURRING or EXCLUDE.');
    if (!reason) throw new BadRequestException('Say why.');
    if (!(await this.sql`select 1 from bridge.production_requirement where order_ref = ${ref} limit 1`).length) throw new NotFoundException('No ALEMBIC order with that reference.');
    await this.sql`insert into production.cover_order_flag (order_ref, flag, reason, set_by) values (${ref}, ${flag}, ${reason}, ${principal.userId})
                   on conflict (order_ref) do update set flag = excluded.flag, reason = excluded.reason, set_by = excluded.set_by, set_dt = now()`;
    return { orderRef: ref, flag };
  }
}
