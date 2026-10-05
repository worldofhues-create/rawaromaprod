/**
 * RuhGuardsService — the factory actions Ruh takes a second look at (owner rulings 2026-10-06:
 * interventions WARN, NEVER BLOCK). Each guard is a pure read of the facts behind one existing
 * route; RuhGuardInterceptor runs it after authentication and permissions, BEFORE the handler:
 *
 *   no risks                → the action runs exactly as before;
 *   risks, no typed reason  → 409 RUH_CONFIRM_REQUIRED with the risks (the console's RuhConfirm
 *                             modal shows them and asks why);
 *   risks + a reason ≥ 8    → the action runs exactly as before, and after it succeeds the override
 *                             is audited, an urgent insight goes to the admins and a C3 signal with
 *                             `override` is queued for ALEMBIC (which emails them).
 *
 * The existing hard controls are untouched and still refuse inside each service: QC pass/fail and
 * release rules, a failed batch never shelved, author ≠ approver, permissions, re-auth. A Ruh check
 * that cannot be worked out (a read fails) lets the action through — Ruh never becomes a blocker.
 *
 *   action                        route                                   warns when (setting)
 *   production.plan_out_of_order  POST /v1/produce/requirements/:id/plan  a higher-ranked order is still waiting to be planned
 *   shelf.pick_out_of_fifo        POST /v1/shelf/picks                    an older QC-released batch of the same SKU is free on a shelf
 *   shelf.putaway_mixed_or_full   POST /v1/shelf/tasks/:id/putaway,       the bin holds another SKU, or would exceed its batches /
 *                                 POST /v1/shelf/putaway, POST /v1/shelf/move  quantity limit (shelf.binMaxBatches, shelf.binMaxQty)
 *   qc.release_at_spec_edge       POST /v1/batch-coas/:id/release         a passing result sits within guard.coaEdgeMarginPct of a spec limit
 *   location.edit_stocked         PATCH /v1/masters/{racks|shelves|bins}/:id  the rack / shelf / bin holds stock or open tasks
 *   shelf.pick_light_off          PUT /v1/shelf/pick-light/config         turning the lights off or to the simulator in production
 *                                                                          (guard.pickLightProductionOnly)
 *   formula.link_change           POST /v1/products/:id/formula-link      the product already has a different formula
 *   vault.bulk_approve            (Vault box) POST /v1/formula-versions/approve-batch — cluster-formula's RuhVaultService
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';
import { bridge as bridgeContracts } from '@core/contracts';
import { ConfigService, PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { isoOf } from '../pg-timestamp.js';
import { plural, round1, type Risk, type RuhConsole, type RuhSubject } from './ruh.contract.js';
import { RuhSettingsService, type RuhSettings } from './ruh-settings.service.js';

export interface GuardContext {
  params: Record<string, string | undefined>;
  body: Record<string, unknown>;
  principal: AuthPrincipal;
}

export interface GuardEvaluation {
  risks: Risk[];
  actionLabel: string;
  subject: RuhSubject;
  console: RuhConsole;
  deepLink: string | null;
}

export interface GuardDef {
  action: string;
  method: string;
  /** Fastify's route pattern, exactly as registered (`/v1/shelf/tasks/:id/putaway`). */
  route: string;
  check(ctx: GuardContext, s: RuhSettings): Promise<GuardEvaluation>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const n = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const none = (actionLabel: string, subject: RuhSubject, deepLink: string | null = null, console: RuhConsole = 'factory'): GuardEvaluation =>
  ({ risks: [], actionLabel, subject, console, deepLink });

/** Pure: how close `value` is to the nearer spec limit, as a share of the range (null when outside or no range). */
export function edgeShare(value: number, min: number, max: number): { share: number; limit: 'lower' | 'upper' } | null {
  const width = max - min;
  if (!(width > 0) || value < min || value > max) return null;
  const toMin = value - min;
  const toMax = max - value;
  return toMin <= toMax ? { share: toMin / width, limit: 'lower' } : { share: toMax / width, limit: 'upper' };
}

@Injectable()
export class RuhGuardsService {
  readonly guards: readonly GuardDef[];

  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    private readonly settings: RuhSettingsService,
    @Inject(ConfigService) private readonly config: Pick<ConfigService, 'get'>,
  ) {
    this.guards = [
      { action: 'production.plan_out_of_order', method: 'POST', route: '/v1/produce/requirements/:id/plan', check: (c) => this.planOutOfOrder(c) },
      { action: 'shelf.pick_out_of_fifo', method: 'POST', route: '/v1/shelf/picks', check: (c) => this.pickOutOfFifo(c) },
      { action: 'shelf.putaway_mixed_or_full', method: 'POST', route: '/v1/shelf/tasks/:id/putaway', check: (c, s) => this.putaway(c, s, 'task') },
      { action: 'shelf.putaway_mixed_or_full', method: 'POST', route: '/v1/shelf/putaway', check: (c, s) => this.putaway(c, s, 'batch') },
      { action: 'shelf.putaway_mixed_or_full', method: 'POST', route: '/v1/shelf/move', check: (c, s) => this.putaway(c, s, 'move') },
      { action: 'qc.release_at_spec_edge', method: 'POST', route: '/v1/batch-coas/:id/release', check: (c, s) => this.coaEdge(c, s) },
      { action: 'location.edit_stocked', method: 'PATCH', route: '/v1/masters/:resource/:id', check: (c) => this.editStocked(c) },
      { action: 'shelf.pick_light_off', method: 'PUT', route: '/v1/shelf/pick-light/config', check: (c, s) => this.pickLightOff(c, s) },
      { action: 'formula.link_change', method: 'POST', route: '/v1/products/:id/formula-link', check: (c) => this.formulaLink(c) },
    ];
  }

  match(method: string, route: string): GuardDef | null {
    const m = method.toUpperCase();
    return this.guards.find((g) => g.method === m && g.route === route) ?? null;
  }

  async evaluate(guard: GuardDef, ctx: GuardContext): Promise<GuardEvaluation> {
    return guard.check(ctx, await this.settings.get());
  }

  /* ── production: planning out of the queue's order ──────────────────────────────────── */

  private async planOutOfOrder(c: GuardContext): Promise<GuardEvaluation> {
    const id = c.params.id ?? '';
    const subject: RuhSubject = { type: 'production_requirement', id };
    if (!UUID.test(id)) return none('plan a production run', subject);
    const rows = (await this.sql`
      with q as (
        select alembic_requirement_id::text as id, order_ref, mapped_sku, priority_reason, order_value_inr::text as value,
               lifecycle_status, production_order_id, produce_block_reason, needed_by,
               row_number() over (order by priority_rank asc nulls last, needed_by asc, created_dt asc, alembic_requirement_id asc) as pos
          from bridge.production_requirement
         where lifecycle_status in ('ACCEPTED', 'REJECTED_MAPPING', 'CREATED'))
      select q.*, (select pos from q t where t.id = ${id}) as target_pos, (select order_ref from q t where t.id = ${id}) as target_ref
        from q
       where q.pos < (select pos from q t where t.id = ${id})
         and q.lifecycle_status = 'ACCEPTED' and q.production_order_id is null and q.produce_block_reason is null
       order by q.pos
       limit 50`) as unknown as Array<{ id: string; order_ref: string; mapped_sku: string; priority_reason: string | null; value: string | null; pos: string | number; target_pos: string | number; target_ref: string }>;
    const label = rows[0] ? `plan ${rows[0].target_ref} ahead of higher-ranked orders` : 'plan a production run';
    if (rows.length === 0) return none(label, subject, `#/go/produce/${id}`);
    const high = rows.filter((r) => bridgeContracts.isHighValue(r.priority_reason, r.value));
    const list = rows.slice(0, 3).map((r) => `${r.order_ref} (${r.mapped_sku}, number ${n(r.pos)})`).join(', ');
    return {
      actionLabel: label, subject: { ...subject, code: rows[0]!.target_ref }, console: 'factory', deepLink: `#/go/produce/${id}`,
      risks: [{
        code: 'HIGHER_PRIORITY_WAITING',
        title: `${plural(rows.length, 'higher-ranked order is', 'higher-ranked orders are')} still waiting to be planned`,
        detail: `This order is number ${n(rows[0]!.target_pos)} in the queue. Waiting ahead of it: ${list}${rows.length > 3 ? ` and ${rows.length - 3} more` : ''}.${high.length ? ` ${plural(high.length, 'of them is', 'of them are')} high value.` : ''} Planning this one first can make them late.`,
        severity: high.length ? 'urgent' : 'warn',
      }],
    };
  }

  /* ── shelves ─────────────────────────────────────────────────────────────────────────── */

  private async pickOutOfFifo(c: GuardContext): Promise<GuardEvaluation> {
    const fg = str(c.body.finishedGoodBatchId);
    const subject: RuhSubject = { type: 'fg_batch', id: fg };
    if (!UUID.test(fg)) return none('pick a batch out of order', subject);
    const [target] = (await this.sql`
      select f.batch_number, f.product_sku_id::text as sku_id, s.sku_code, f.manufacturing_date::text as made, c.released_dt
        from packaging.finished_good_batch_master f
        left join packaging.product_sku s on s.product_sku_id = f.product_sku_id
        left join packaging.package_order po on po.package_order_id = f.package_order_id
        left join production.batch_coa c on c.oil_batch_id = po.oil_batch_id
       where f.finished_good_batch_id = ${fg}::uuid`) as unknown as Array<{ batch_number: string | null; sku_id: string | null; sku_code: string | null; made: string | null; released_dt: Date | string | null }>;
    if (!target?.sku_id) return none('pick a batch out of order', subject);
    const label = `pick batch ${target.batch_number ?? ''} ahead of older stock`.replace(/\s+/g, ' ');
    const rel = target.released_dt ? isoOf(target.released_dt) : null;
    const older = (await this.sql`
      select f.batch_number, f.manufacturing_date::text as made, rk.rack_code, sh.shelf_code, bn.bin_code,
             (st.qty - coalesce((select sum(p.qty) from location.shelf_task p where p.kind = 'PICK' and p.status = 'OPEN'
                                   and p.finished_good_batch_id = st.finished_good_batch_id and p.from_bin_id = st.bin_id), 0))::float as free
        from location.fg_bin_stock st
        join packaging.finished_good_batch_master f on f.finished_good_batch_id = st.finished_good_batch_id
        join packaging.package_order po on po.package_order_id = f.package_order_id
        join production.batch_coa c on c.oil_batch_id = po.oil_batch_id and c.status = 'RELEASED'
        join location.bin_master bn on bn.bin_id = st.bin_id
        left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
        left join location.rack_master rk on rk.rack_id = sh.rack_id
       where f.product_sku_id = ${target.sku_id}::uuid and st.qty > 0 and f.finished_good_batch_id <> ${fg}::uuid
         and ((${target.made}::date is not null and f.manufacturing_date < ${target.made}::date)
              or (f.manufacturing_date is not distinct from ${target.made}::date and ${rel}::timestamptz is not null
                  and c.released_dt < ${rel}::timestamptz))
       order by f.manufacturing_date asc nulls last, c.released_dt asc
       limit 10`) as unknown as Array<{ batch_number: string | null; made: string | null; rack_code: string | null; shelf_code: string | null; bin_code: string | null; free: number }>;
    const free = older.filter((o) => o.free > 0);
    if (free.length === 0) return none(label, subject, '#/go/shelftasks');
    const o = free[0]!;
    return {
      actionLabel: label, subject: { ...subject, code: target.batch_number }, console: 'factory', deepLink: '#/go/shelftasks',
      risks: [{
        code: 'PICK_NOT_FIFO',
        title: `Older stock of ${target.sku_code ?? 'this SKU'} is on the shelves`,
        detail: `Batch ${o.batch_number ?? '(unnumbered)'} (made ${o.made ?? 'earlier'}) is free on ${bridgeContracts.locationLabel(o.rack_code, o.shelf_code, o.bin_code) ?? o.bin_code}${free.length > 1 ? `, and ${free.length - 1} more older ${free.length - 1 === 1 ? 'batch' : 'batches'}` : ''}. First in, first out picks the oldest released batch first so stock does not age on the shelf.`,
        severity: 'warn',
      }],
    };
  }

  private async resolveBin(code: string): Promise<{ id: string; label: string } | null> {
    if (!code) return null;
    const [r] = (await this.sql`
      select bn.bin_id::text as id, rk.rack_code, sh.shelf_code, bn.bin_code
        from location.bin_master bn
        left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
        left join location.rack_master rk on rk.rack_id = sh.rack_id
       where lower(bn.bin_code) = lower(${code}) or lower(concat_ws('-', rk.rack_code, sh.shelf_code, bn.bin_code)) = lower(${code})
       limit 1`) as unknown as Array<{ id: string; rack_code: string | null; shelf_code: string | null; bin_code: string }>;
    return r ? { id: r.id, label: bridgeContracts.locationLabel(r.rack_code, r.shelf_code, r.bin_code) ?? r.bin_code } : null;
  }

  private async putaway(c: GuardContext, s: RuhSettings, mode: 'task' | 'batch' | 'move'): Promise<GuardEvaluation> {
    let fg = '';
    let qty: number | null = null;
    let binCode = '';
    if (mode === 'task') {
      const id = c.params.id ?? '';
      if (!UUID.test(id)) return none('put stock away', { type: 'shelf_task', id });
      const [t] = (await this.sql`select finished_good_batch_id::text as fg, qty::float as qty from location.shelf_task where shelf_task_id = ${id}::uuid`) as unknown as Array<{ fg: string; qty: number }>;
      if (!t) return none('put stock away', { type: 'shelf_task', id });
      fg = t.fg; qty = Number(t.qty); binCode = str(c.body.binCode);
    } else if (mode === 'batch') {
      fg = str(c.body.finishedGoodBatchId); binCode = str(c.body.binCode);
    } else {
      fg = str(c.body.finishedGoodBatchId); binCode = str(c.body.toBinCode);
      qty = c.body.qty === undefined || c.body.qty === null || c.body.qty === '' ? null : Number(c.body.qty);
    }
    const subject: RuhSubject = { type: 'fg_batch', id: fg };
    if (!UUID.test(fg) || !binCode) return none('put stock on a bin', subject);
    const bin = await this.resolveBin(binCode);
    if (!bin) return none('put stock on a bin', subject);
    const [batch] = (await this.sql`
      select f.batch_number, f.product_sku_id::text as sku_id, s.sku_code, f.produced_qty::float as produced,
             coalesce((select sum(st.qty) from location.fg_bin_stock st where st.finished_good_batch_id = f.finished_good_batch_id), 0)::float as stocked
        from packaging.finished_good_batch_master f
        left join packaging.product_sku s on s.product_sku_id = f.product_sku_id
       where f.finished_good_batch_id = ${fg}::uuid`) as unknown as Array<{ batch_number: string | null; sku_id: string | null; sku_code: string | null; produced: number; stocked: number }>;
    if (!batch) return none('put stock on a bin', subject);
    if (qty === null || !Number.isFinite(qty)) {
      if (mode === 'move') {
        const [st] = (await this.sql`select coalesce(sum(qty), 0)::float as q from location.fg_bin_stock where finished_good_batch_id = ${fg}::uuid
                                       and bin_id <> ${bin.id}::uuid`) as unknown as Array<{ q: number }>;
        qty = Number(st?.q ?? 0);
      } else qty = Math.max(0, Number(batch.produced) - Number(batch.stocked));
    }
    const label = `${mode === 'move' ? 'move' : 'put away'} batch ${batch.batch_number ?? ''} on bin ${bin.label}`.replace(/\s+/g, ' ');
    const contents = (await this.sql`
      select st.finished_good_batch_id::text as fg, f.product_sku_id::text as sku_id, s.sku_code, st.qty::float as qty
        from location.fg_bin_stock st
        join packaging.finished_good_batch_master f on f.finished_good_batch_id = st.finished_good_batch_id
        left join packaging.product_sku s on s.product_sku_id = f.product_sku_id
       where st.bin_id = ${bin.id}::uuid and st.qty > 0`) as unknown as Array<{ fg: string; sku_id: string | null; sku_code: string | null; qty: number }>;
    const risks: Risk[] = [];
    const others = [...new Set(contents.filter((x) => x.sku_id && batch.sku_id && x.sku_id !== batch.sku_id).map((x) => x.sku_code ?? 'another SKU'))];
    if (others.length) {
      risks.push({
        code: 'BIN_HOLDS_OTHER_SKU', severity: 'warn',
        title: `Bin ${bin.label} holds a different SKU`,
        detail: `It already holds ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''}; this is ${batch.sku_code ?? 'another SKU'}. Mixed bins cause wrong picks.`,
      });
    }
    const batchesAfter = new Set([...contents.map((x) => x.fg), fg]).size;
    const qtyAfter = contents.reduce((a, x) => a + Number(x.qty), 0) + Number(qty ?? 0);
    const maxB = s['shelf.binMaxBatches'];
    const maxQ = s['shelf.binMaxQty'];
    if (batchesAfter > maxB || (maxQ !== null && qtyAfter > maxQ)) {
      risks.push({
        code: 'BIN_OVER_CAPACITY', severity: 'warn',
        title: `Bin ${bin.label} would be over its limit`,
        detail: `After this it would hold ${plural(batchesAfter, 'batch', 'batches')} (limit ${maxB})${maxQ !== null ? ` and ${round1(qtyAfter)} units (limit ${maxQ})` : ''}.`,
      });
    }
    return { risks, actionLabel: label, subject: { ...subject, code: batch.batch_number }, console: 'factory', deepLink: '#/go/shelftasks' };
  }

  /* ── QC: releasing a COA whose numbers sit at the edge of the spec ───────────────────── */

  private async coaEdge(c: GuardContext, s: RuhSettings): Promise<GuardEvaluation> {
    const id = c.params.id ?? '';
    const subject: RuhSubject = { type: 'batch_coa', id };
    if (!UUID.test(id)) return none('release a batch', subject);
    const [coa] = (await this.sql`
      select c.status, c.overall_result, b.batch_number,
             c.sg_result::float as sg, c.sg_spec_min::float as sg_min, c.sg_spec_max::float as sg_max,
             c.flash_point_result_c::float as fp, c.flash_point_spec_min_c::float as fp_min, c.flash_point_spec_max_c::float as fp_max
        from production.batch_coa c left join production.oil_batch_master b on b.oil_batch_id = c.oil_batch_id
       where c.batch_coa_id = ${id}::uuid`) as unknown as Array<{ status: string; overall_result: string; batch_number: string | null; sg: number; sg_min: number; sg_max: number; fp: number; fp_min: number; fp_max: number }>;
    const label = `release batch ${coa?.batch_number ?? ''} with results at the edge of the spec`.replace(/\s+/g, ' ');
    // Only a release the service would accept is worth a warning: a failed or already-released COA
    // is the service's own refusal, unchanged.
    if (!coa || coa.status !== 'TESTED' || coa.overall_result !== 'PASS') return none(label, subject, `#/go/coa/${id}`);
    const margin = s['guard.coaEdgeMarginPct'] / 100;
    const risks: Risk[] = [];
    const check = (name: string, unit: string, v: number, min: number, max: number, code: string) => {
      const e = edgeShare(Number(v), Number(min), Number(max));
      if (!e || e.share > margin) return;
      risks.push({
        code, severity: 'warn',
        title: `${name} is at the ${e.limit} edge of the spec`,
        detail: `${name} ${v}${unit} is within ${round1(e.share * 100)}% of the ${e.limit} limit ${e.limit === 'lower' ? min : max}${unit} (spec ${min}–${max}${unit}; Ruh flags within ${s['guard.coaEdgeMarginPct']}%). It passes, but a re-test or a second sample is cheap insurance.`,
      });
    };
    check('Specific gravity', '', coa.sg, coa.sg_min, coa.sg_max, 'COA_SG_AT_EDGE');
    check('Flash point', ' °C', coa.fp, coa.fp_min, coa.fp_max, 'COA_FLASH_POINT_AT_EDGE');
    return { risks, actionLabel: label, subject: { ...subject, code: coa.batch_number }, console: 'factory', deepLink: `#/go/coa/${id}` };
  }

  /* ── locations: editing racks / shelves / bins that hold stock ───────────────────────── */

  private async editStocked(c: GuardContext): Promise<GuardEvaluation> {
    const resource = c.params.resource ?? '';
    const id = c.params.id ?? '';
    const kind = resource === 'racks' ? 'rack' : resource === 'shelves' ? 'shelf' : resource === 'bins' ? 'bin' : null;
    const subject: RuhSubject = { type: kind ?? resource, id };
    if (!kind || !UUID.test(id)) return none(`edit ${resource}`, subject);
    // This route checks its permission inside the service (per resource): Ruh says nothing about a
    // location's stock to someone who may not edit it — the service refuses them as before.
    const perm = `location:${kind}_master:write`;
    if (!(c.principal.permissions ?? []).includes(perm) && !(c.principal.roles ?? []).includes('owner')) return none(`edit ${resource}`, subject);
    const bins = kind === 'bin' ? this.sql`select ${id}::uuid as bin_id`
      : kind === 'shelf' ? this.sql`select bin_id from location.bin_master where shelf_id = ${id}::uuid`
        : this.sql`select b.bin_id from location.bin_master b join location.shelf_master sh on sh.shelf_id = b.shelf_id where sh.rack_id = ${id}::uuid`;
    const [r] = (await this.sql`
      select coalesce((select sum(qty) from location.fg_bin_stock where qty > 0 and bin_id in (${bins})), 0)::float as qty,
             (select count(distinct finished_good_batch_id) from location.fg_bin_stock where qty > 0 and bin_id in (${bins}))::int as batches,
             (select count(*) from location.shelf_task where status = 'OPEN' and (to_bin_id in (${bins}) or from_bin_id in (${bins})))::int as tasks`) as unknown as Array<{ qty: number; batches: number; tasks: number }>;
    const status = typeof c.body.status === 'string' ? c.body.status.trim().toUpperCase() : null;
    const removing = status !== null && status !== 'ACTIVE';
    const label = `${removing ? 'take a' : 'change a'} ${kind} that holds stock${removing ? ' out of use' : ''}`;
    if (n(r?.batches) === 0 && n(r?.tasks) === 0) return none(label, subject, `#/go/${resource}`);
    return {
      actionLabel: label, subject, console: 'factory', deepLink: `#/go/${resource}`,
      risks: [{
        code: removing ? 'LOCATION_REMOVE_WITH_STOCK' : 'LOCATION_EDIT_WITH_STOCK',
        severity: removing ? 'urgent' : 'warn',
        title: removing ? `This ${kind} still holds stock` : `This ${kind} holds stock`,
        detail: `${plural(n(r?.batches), 'batch', 'batches')} (${round1(n(r?.qty))} units) ${n(r?.batches) === 1 ? 'is' : 'are'} on it${n(r?.tasks) ? ` and ${plural(n(r?.tasks), 'open task')} point${n(r?.tasks) === 1 ? 's' : ''} at it` : ''}. ${removing ? 'Taking it out of use hides that stock from put-away and picks: move it first.' : 'Renaming changes the labels people scan; reprint them.'}`,
      }],
    };
  }

  /* ── pick-to-light: lights off / simulator in production ─────────────────────────────── */

  private async pickLightOff(c: GuardContext, s: RuhSettings): Promise<GuardEvaluation> {
    const mode = str(c.body.mode).toLowerCase();
    const subject: RuhSubject = { type: 'pick_light' };
    const label = mode === 'off' ? 'turn pick-to-light off' : 'switch pick-to-light to the simulator';
    if (mode !== 'off' && mode !== 'simulator') return none(label, subject, '#/picklight', 'platform');
    const production = this.config.get('APP_ENV') === 'prod' && this.config.get('RAWPROD_ENVIRONMENT') !== 'demo';
    if (s['guard.pickLightProductionOnly'] && !production) return none(label, subject, '#/picklight', 'platform');
    const [cur] = (await this.sql`select mode from location.pick_light_config where id = 'default'`) as unknown as Array<{ mode: string }>;
    if ((cur?.mode ?? 'off') === mode) return none(label, subject, '#/picklight', 'platform');
    const [t] = (await this.sql`select count(*)::int as n from location.shelf_task where status = 'OPEN' and kind in ('PUTAWAY', 'PICK')`) as unknown as Array<{ n: number }>;
    return {
      actionLabel: label, subject, console: 'platform', deepLink: '#/picklight',
      risks: [{
        code: mode === 'off' ? 'PICK_LIGHT_OFF_IN_PRODUCTION' : 'PICK_LIGHT_SIMULATOR_IN_PRODUCTION', severity: 'warn',
        title: mode === 'off' ? 'The shelf lights go dark in the working factory' : 'The real shelf lights stop; only the on-screen simulator lights up',
        detail: `${n(t?.n) ? `${plural(n(t?.n), 'open put-away or pick')} currently ${n(t?.n) === 1 ? 'relies' : 'rely'} on a lit bin. ` : ''}Pickers will have to read bin codes from the sheet or the Shelf display instead.`,
      }],
    };
  }

  /* ── formulas: changing which formula a product is made from ─────────────────────────── */

  private async formulaLink(c: GuardContext): Promise<GuardEvaluation> {
    const id = c.params.id ?? '';
    const next = str(c.body.formulaId);
    const subject: RuhSubject = { type: 'product', id };
    if (!UUID.test(id) || !UUID.test(next)) return none('change a product\'s formula', subject, '#/go/formulasetup');
    const [p] = (await this.sql`
      select product_code, formula_id::text as formula_id,
             (select count(*) from bridge.production_requirement r join packaging.product_sku s on s.sku_code = r.mapped_sku
               where s.product_id = p.product_id and r.lifecycle_status = 'ACCEPTED')::int as open_reqs,
             (select count(*) from bridge.production_requirement r join packaging.product_sku s on s.sku_code = r.mapped_sku
               join production.production_order o on o.production_order_id = r.production_order_id
               where s.product_id = p.product_id and upper(coalesce(o.status, '')) in ('PLANNING', 'INPROGRESS'))::int as runs
        from packaging.product_master p where p.product_id = ${id}::uuid`) as unknown as Array<{ product_code: string | null; formula_id: string | null; open_reqs: number; runs: number }>;
    const label = `change the formula of product ${p?.product_code ?? ''}`.replace(/\s+/g, ' ');
    if (!p?.formula_id || p.formula_id === next) return none(label, { ...subject, code: p?.product_code ?? null }, '#/go/formulasetup');
    const risks: Risk[] = [{
      code: 'FORMULA_LINK_REPLACED', severity: 'warn',
      title: `${p.product_code ?? 'This product'} already has a formula`,
      detail: 'Every run planned from now on will be made from the newly linked formula, and its QC spec and certificates may no longer match.',
    }];
    if (n(p.open_reqs) || n(p.runs)) {
      risks.push({
        code: 'FORMULA_LINK_WITH_OPEN_WORK', severity: 'urgent',
        title: 'Open orders depend on this product',
        detail: `${plural(n(p.open_reqs), 'open order')}${n(p.runs) ? ` and ${plural(n(p.runs), 'run')} planned or in production` : ''} for it. Runs already planned keep their formula; new runs use the new one.`,
      });
    }
    return { risks, actionLabel: label, subject: { ...subject, code: p.product_code }, console: 'factory', deepLink: '#/go/formulasetup' };
  }
}
