/**
 * RP-BE-1 — the reads the RAC OS Factory console draws that RawProd had no route for (ALEMBIC
 * docs/plan/program/rp-relay.md Part 4.3; the contract is docs/relay-contract-vault-factory.md).
 *
 * A BFF read model in this repository's own shape (CODEBASE_MAP section 3): raw cross-schema SQL
 * over PG_CLIENT, `{ items, nextCursor, total }` for lists (the envelope lifts nextCursor and total
 * into meta), `select ... as "camelCase"`. Three rules hold on every read here:
 *
 *   - CODED, NEVER NAMED. A raw material is its floor code (YELLOW-0417) and family colour; no read
 *     here selects material_name or material_code. Where a `materialId` is returned the global
 *     MaterialMaskingInterceptor still nulls it for a caller without masterdata:material:reveal.
 *   - NOTHING ASSUMED. A figure the data does not hold is null with the reason beside it (cover in
 *     days needs a planned-use rate RawProd does not keep), never a default and never zero.
 *   - UNITS AS HELD. Quantities are converted to integer milligrams only where the unit is a mass
 *     unit (qtyToMg); a quantity in a unit that is not a mass is returned as null with `unconverted`.
 *
 * Paging: `cursor` is an offset (a decimal string), as formula-access-audit pages; `limit` is clamped.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';
import { codeText, qtyToMg } from '../floor/floor-code.service.js';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TZ = 'Asia/Kolkata';
export const COVER_NOT_HELD = 'Cover in days needs a planned daily use; RawProd does not hold one, so cover is not computed.';

export function page(limitRaw: unknown, cursorRaw: unknown, cap = 100): { limit: number; offset: number } {
  const n = Number(limitRaw ?? 50);
  const limit = Number.isFinite(n) ? Math.min(Math.max(1, Math.trunc(n)), cap) : 50;
  const c = typeof cursorRaw === 'string' && /^\d{1,7}$/.test(cursorRaw) ? Number(cursorRaw) : 0;
  return { limit, offset: c };
}

export function paged<T>(all: T[], limit: number, offset: number) {
  const items = all.slice(offset, offset + limit);
  return { items, nextCursor: offset + limit < all.length ? String(offset + limit) : null, total: all.length };
}

/** "YELLOW-0417" -> { colour: 'YELLOW', number: 417 }. Anything else is refused before SQL. */
export function parseCode(raw: unknown): { colour: string; number: number } {
  const m = /^([A-Za-z]{1,30})-(\d{1,6})$/.exec(String(raw ?? '').trim());
  if (!m) throw new BadRequestException('A floor code is a colour and a number, like YELLOW-0417.');
  return { colour: m[1]!.toUpperCase(), number: Number(m[2]) };
}

/** Sum quantities held in mixed units to milligrams; null (and unconverted) when any unit is not a mass. */
function sumMg(rows: Array<{ qty: string | null; uom: string | null }>): { mg: number | null; unconverted: boolean } {
  let mg = 0;
  for (const r of rows) {
    const v = qtyToMg(r.qty, r.uom);
    if (v === null) return { mg: null, unconverted: true };
    mg += v;
  }
  return { mg, unconverted: false };
}

@Injectable()
export class FactoryDeskService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  /* ── Today (FAC-BE-15) ───────────────────────────────────────────────────────────────────── */

  async today(opts: { seeProduct?: boolean } = {}) {
    const sql = this.sql;
    const [c] = await sql<Row[]>`
      select
        (select count(*)::int from production.floor_job where stage in ('PICK', 'VERIFY', 'MIX')) as "onTheFloor",
        (select count(*)::int from production.maceration_run where status = 'MACERATING') as "macerating",
        (select count(*)::int from inventory.rm_batch_master where status = 'QUARANTINE') as "qcRmLots",
        (select count(*)::int from platform.floor_alert where cleared_at is null and acked_at is null) as "openAlerts",
        (select count(*)::int from procurement.purchase_order where status in ('DRAFT', 'PENDING', 'PENDING_L2_APPROVAL')) as "poAwaitingApproval",
        (select count(*)::int from production.floor_problem where resolved_dt is null) as "openProblems",
        (select count(*)::int from production.floor_job where (picked_dt at time zone ${TZ})::date = (now() at time zone ${TZ})::date) as "pickedToday",
        (select count(*)::int from production.floor_job where (verified_dt at time zone ${TZ})::date = (now() at time zone ${TZ})::date) as "verifiedToday",
        (select count(*)::int from production.floor_job where (mixed_dt at time zone ${TZ})::date = (now() at time zone ${TZ})::date) as "mixedToday"`;
    const qc = await this.qcQueue({});
    const cover = await this.coverRows();
    const board = await this.board(opts);
    return {
      day: (await sql<{ d: string }[]>`select (now() at time zone ${TZ})::date::text as d`)[0]!.d,
      tiles: {
        onTheFloor: c!.onTheFloor,
        macerating: c!.macerating,
        qcWaiting: { batches: qc.items.filter((i) => i.kind === 'BATCH').length, rmLots: c!.qcRmLots },
        shortStock: cover.filter((r) => r.belowReorder === true).length,
      },
      needsAPerson: {
        openAlerts: c!.openAlerts,
        poAwaitingApproval: c!.poAwaitingApproval,
        openProblems: c!.openProblems,
        belowReorder: cover.filter((r) => r.belowReorder === true).length,
      },
      stationsToday: [
        { station: 'PICK', done: c!.pickedToday },
        { station: 'VERIFY', done: c!.verifiedToday },
        { station: 'MIX', done: c!.mixedToday },
      ],
      // Planned-per-station and the seven-day history need a daily count RawProd does not keep.
      planned: null,
      history: null,
      batchesMoving: board.items.slice(0, 8),
    };
  }

  /* ── Production plan: the stage board (FAC-BE-14) ────────────────────────────────────────── */

  /**
   * One row per open floor job. Stage is the job's own stage until it is mixed; after that it is read
   * from what the batch has: an open maceration run is MACERATION, an approved last QC round is
   * APPROVED, anything else is QC. A batch released, rejected or closed leaves the board. Packed and
   * shipped are not derived here: a finished-good batch is not linked to its oil batch in this data.
   */
  async board(opts: { seeProduct?: boolean } = {}) {
    const rows = await this.sql<Row[]>`
      select j.floor_job_id::text as "floorJobId", j.job_no as "jobNo", j.batch_no as "batchNo", j.oil_batch_id::text as "oilBatchId",
             case when j.oil_batch_id is null then j.stage
                  when mr.status = 'MACERATING' then 'MACERATION'
                  when q.decision = 'APPROVE' then 'APPROVED'
                  else 'QC' end as "stage",
             j.expedite, j.order_ref as "orderRef", j.promise_dt::text as "promiseDt",
             (select count(*)::int from production.floor_line l where l.floor_job_id = j.floor_job_id) as "lines",
             case when mr.status = 'MACERATING' then floor(extract(epoch from (now() - mr.started_at)) / 86400)::int + 1 end as "macerationDay",
             case when mr.status = 'MACERATING' then mr.min_days + coalesce(mr.extend_days, 0) end as "macerationNeedDays",
             q.round_no as "qcRound", j.created_dt::text as "createdDt"
        from production.floor_job j
        left join production.oil_batch_master b on b.oil_batch_id = j.oil_batch_id
        left join lateral (select status, started_at, min_days, extend_days from production.maceration_run mrun
                            where mrun.oil_batch_id = j.oil_batch_id order by mrun.started_at desc limit 1) mr on true
        left join lateral (select decision, round_no from quality.batch_qc_round qround
                            where qround.oil_batch_id = j.oil_batch_id order by qround.round_no desc limit 1) q on true
       where coalesce(b.status, '') not in ('RELEASED', 'REJECTED', 'CLOSED', 'CANCELLED', 'ABORTED')
       order by j.expedite desc, j.promise_dt asc nulls last, j.created_dt asc
       limit 500`;
    const counts: Record<string, number> = {};
    for (const r of rows) counts[String(r.stage)] = (counts[String(r.stage)] ?? 0) + 1;
    const outputs = await this.outputs(rows.map((r) => String(r.floorJobId)), opts.seeProduct === true);
    const items = rows.map((r): Row => ({ ...r, output: outputs.get(String(r.floorJobId)) ?? null }));
    return { items, nextCursor: null, total: rows.length, counts };
  }

  /**
   * LD-272b: what each batch MAKES, as production volume: the product and its grade, the planned mass
   * (the production order) and the produced mass (the oil batch), in integer milligrams. This is not
   * recipe content and reaches a relay token; the per-line quantities never do (LD-272).
   *   - The product is the one product row made from the order's formula; none, or more than one, is
   *     said in `productNote` rather than guessed. Grade is that product's catalogue grade.
   *   - The product's name and grade follow RawProd's own rule for a product label (formula:actual:read,
   *     as the dashboard and the trace apply it); without it they are null and the note says so.
   *   - A mass held in a unit that is not a mass is null with `unconverted`; nothing absent is 0.
   */
  private async outputs(jobIds: string[], seeProduct: boolean) {
    const out = new Map<string, Row>();
    if (!jobIds.length) return out;
    const rows = await this.sql<Row[]>`
      select j.floor_job_id::text as "jobId",
             po.order_qty::text as "plannedQty", pu.uom_code as "plannedUom",
             b.produced_qty::text as "producedQty", bu.uom_code as "producedUom",
             p.n as "products", p.product_code as "productCode", p.product_name as "productName",
             g.grade, g.grades
        from production.floor_job j
        left join production.production_order po on po.production_order_id = j.production_order_id
        left join platform.uom_master pu on pu.uom_id = po.uom_id
        left join production.production_plan_items pi on pi.production_plan_item_id = po.production_plan_item_id
        left join production.oil_batch_master b on b.oil_batch_id = j.oil_batch_id
        left join platform.uom_master bu on bu.uom_id = b.uom_id
        left join lateral (select pm.product_id, pm.product_code, pm.product_name, (count(*) over ())::int as n
                             from packaging.product_master pm where pi.formula_id is not null and pm.formula_id = pi.formula_id
                            order by pm.product_code limit 1) p on true
        left join lateral (select min(ci.grade) as grade, (count(distinct ci.grade))::int as grades
                             from bridge.catalogue_item ci where ci.product_id = p.product_id and ci.grade is not null) g on true
       where j.floor_job_id in ${this.sql(jobIds)}`;
    for (const r of rows) {
      const planned = r.plannedQty == null ? null : qtyToMg(String(r.plannedQty), (r.plannedUom as string | null) ?? null);
      const produced = r.producedQty == null ? null : qtyToMg(String(r.producedQty), (r.producedUom as string | null) ?? null);
      const one = r.products === 1;
      const productNote = !r.products
        ? 'Product not recorded for this batch.'
        : !one
          ? 'More than one product is made from this formula; which one this batch is, is not recorded.'
          : !seeProduct ? 'The product is not shown to you in the factory system.' : null;
      const show = one && seeProduct;
      out.set(String(r.jobId), {
        productCode: show ? r.productCode ?? null : null,
        productName: show ? r.productName ?? null : null,
        grade: show && r.grades === 1 ? r.grade ?? null : null,
        plannedMg: planned,
        producedMg: produced,
        unconverted: (r.plannedQty != null && planned === null) || (r.producedQty != null && produced === null),
        productNote,
      });
    }
    return out;
  }

  /* ── One batch, coded, and its route (FAC-BE-14, FAC-BE-31) ─────────────────────────────── */

  private async jobFor(ref: string): Promise<Row> {
    const r = String(ref ?? '').trim();
    if (!r || r.length > 60) throw new BadRequestException('Name a batch or a job.');
    const rows = UUID.test(r)
      ? await this.sql<Row[]>`select * from production.floor_job where floor_job_id = ${r}::uuid or oil_batch_id = ${r}::uuid limit 2`
      : await this.sql<Row[]>`select * from production.floor_job where upper(batch_no) = upper(${r}) or upper(job_no) = upper(${r}) limit 2`;
    if (!rows.length) throw new NotFoundException(`No batch or job ${r} on file.`);
    if (rows.length > 1) throw new BadRequestException(`More than one batch matches ${r}; open it from the board.`);
    return rows[0]!;
  }

  /** One batch. `relay` (LD-272): the caller came through the ALEMBIC relay (`via: "relay"`), so every
   *  quantity is left out (target, tolerance, picked and actual grams per floor code, and the batch's
   *  produced quantity): grams by code are the recipe by another name and never pass through ALEMBIC.
   *  Each line keeps its code, its state, and who moved it there and when. A person signed in on
   *  RawProd itself (`relay` false) gets the floor's batch sheet as the floor does. */
  async batch(ref: string, opts: { relay?: boolean; seeProduct?: boolean } = {}) {
    const j = await this.jobFor(ref);
    const jobId = String(j.floor_job_id);
    const oilBatchId = (j.oil_batch_id as string | null) ?? null;
    const lines = await this.sql<Row[]>`
      select l.seq, f.family_code as "familyCode", f.colour_name as "colourName", f.colour_hex as "colourHex", c.number as "codeNumber",
             l.target_mg::text as "targetMg", l.tolerance_ppm as "tolerancePpm", l.picked_mg::text as "pickedMg", l.actual_mg::text as "actualMg",
             rb.batch_number as "pickedLot", sl.storage_location_code as "bin",
             case when l.verified_dt is not null then 'VERIFIED' when l.picked_dt is not null then 'PICKED' else 'OPEN' end as "state",
             coalesce(l.verified_by, l.picked_by) as "by",
             coalesce(l.verified_dt, l.picked_dt) as "at"
        from production.floor_line l
        left join masterdata.floor_code c on c.material_id = l.material_id
        left join masterdata.floor_family_colour f on f.family_code = c.family_code
        left join inventory.inventory_batch ib on ib.inventory_batch_id = l.picked_batch_id
        left join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
        left join location.storage_location_master sl on sl.storage_location_id = ib.storage_location_id
       where l.floor_job_id = ${jobId}::uuid
       order by l.seq`;
    /* RELAY-W5: the stage the board shows for this batch (board() above, same rule): once mixed, the floor
       job reads DONE, so the batch is at MACERATION, APPROVED or QC by its runs and rounds. Sending the
       job's own DONE left RAC OS with no stage on the batch, and so with no QC call to offer. */
    const [sg] = oilBatchId
      ? await this.sql<Row[]>`
          select case when (select status from production.maceration_run where oil_batch_id = ${oilBatchId}::uuid order by started_at desc limit 1) = 'MACERATING' then 'MACERATION'
                      when (select decision from quality.batch_qc_round where oil_batch_id = ${oilBatchId}::uuid order by round_no desc limit 1) = 'APPROVE' then 'APPROVED'
                      else 'QC' end as stage`
      : [{ stage: j.stage }];
    const stage = sg!.stage;
    const batch = oilBatchId
      ? (await this.sql<Row[]>`select batch_number as "batchNumber", status, produced_qty::text as "producedQty", produced_dt::text as "producedDt"
                                from production.oil_batch_master where oil_batch_id = ${oilBatchId}::uuid`)[0] ?? null
      : null;
    const rounds = oilBatchId ? await this.rounds(oilBatchId) : [];
    const hold = oilBatchId
      ? (await this.sql<Row[]>`select lot_hold_id::text as "lotHoldId", reason, held_by as "heldBy", held_dt::text as "heldDt" from inventory.lot_hold
                                where subject_type = 'OIL_BATCH' and subject_id = ${oilBatchId}::uuid and released_dt is null`)[0] ?? null
      : null;
    const relay = opts.relay === true;
    const output = (await this.outputs([jobId], opts.seeProduct === true)).get(jobId) ?? null;
    return {
      floorJobId: jobId, jobNo: j.job_no, batchNo: j.batch_no, oilBatchId, stage, expedite: j.expedite,
      orderRef: j.order_ref, promiseDt: j.promise_dt ? new Date(String(j.promise_dt)).toISOString() : null,
      // LD-272b: the batch's output (product, grade, planned and produced mass) for everyone; the raw
      // `producedQty` stays off a relay answer only because `output.producedMg` already says it in mg.
      output,
      batch: batch && relay ? (({ producedQty: _q, ...rest }) => rest)(batch) : batch,
      hold, qcRounds: rounds,
      lines: lines.map(({ colourName, codeNumber, targetMg, tolerancePpm, pickedMg, actualMg, at, ...l }): Row => ({
        ...l,
        ...(relay ? {} : { targetMg, tolerancePpm, pickedMg, actualMg }),
        at: at ? new Date(String(at)).toISOString() : null,
        code: colourName && codeNumber != null ? codeText(String(colourName), Number(codeNumber)) : null,
        colourName: colourName ?? null,
      })),
    };
  }

  /** Each QC round, with its checkpoint rows (RELAY-W2 3(a)): the round's own checkpoint set (name, kind,
   *  range, critical) beside what was booked against each (pass, value, note). A product check, not
   *  recipe content; a checkpoint with nothing booked shows null, never a pass. */
  private async rounds(oilBatchId: string) {
    const rows = await this.sql<Row[]>`
      select round_no as "roundNo", decision as "proposal", decided_decision as "decision", overrides_proposal as "overridesProposal",
             decision_reason as "decisionReason", decided_by as "decidedBy", decided_dt::text as "decidedDt",
             inspector_id as "bookedBy", created_dt::text as "bookedDt", qc_checkpoint_set_id::text as "setId", results
        from quality.batch_qc_round where oil_batch_id = ${oilBatchId}::uuid order by round_no`;
    const setIds = [...new Set(rows.map((r) => r.setId).filter((x): x is string => typeof x === 'string'))];
    const cps = setIds.length
      ? await this.sql<Row[]>`select qc_checkpoint_id::text as id, qc_checkpoint_set_id::text as "setId", seq, name, check_type as "checkType",
                                     min_value::text as min, max_value::text as max, critical
                                from quality.qc_checkpoint where qc_checkpoint_set_id in ${this.sql(setIds)} order by seq`
      : [];
    return rows.map(({ setId, results, ...r }): Row & { checkpoints: Row[] } => {
      const raw = typeof results === 'string' ? JSON.parse(results) : results;
      /* RELAY-W5: QcFloorService.recordRound writes { failed: [checkpointId], results: [...] }; a bare array
         is the older shape. A value booked with no pass flag passed unless the round lists it as failed. */
      const list: Row[] = Array.isArray(raw) ? raw : raw && Array.isArray(raw.results) ? raw.results : [];
      const failedIds = raw && !Array.isArray(raw) && Array.isArray(raw.failed) ? new Set((raw.failed as unknown[]).map(String)) : null;
      const booked = new Map<string, Row>(list.map((x: Row) => [String(x.checkpointId), x]));
      const checkpoints = cps.filter((c) => c.setId === setId).map((c) => {
        const b = booked.get(String(c.id));
        return {
          seq: c.seq, name: c.name, checkType: c.checkType, min: c.min ?? null, max: c.max ?? null, critical: c.critical === true,
          pass: typeof b?.pass === 'boolean' ? b.pass : b && failedIds ? !failedIds.has(String(c.id)) : null,
          value: typeof b?.value === 'number' ? b.value : null,
          note: typeof b?.note === 'string' ? b.note : null,
        };
      });
      return { ...r, checkpoints };
    });
  }

  async batchRoute(ref: string) {
    const j = await this.jobFor(ref);
    const oilBatchId = (j.oil_batch_id as string | null) ?? null;
    const at = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
    const steps: Array<{ station: string; state: string; by: string | null; at: string | null; note?: string | null }> = [
      { station: 'PICK', state: j.picked_dt ? 'DONE' : j.stage === 'PICK' ? 'CURRENT' : 'WAITING', by: (j.picked_by as string) ?? null, at: at(j.picked_dt) },
      { station: 'VERIFY', state: j.verified_dt ? 'DONE' : j.stage === 'VERIFY' ? 'CURRENT' : 'WAITING', by: (j.verified_by as string) ?? null, at: at(j.verified_dt) },
      { station: 'MIX', state: j.mixed_dt ? 'DONE' : j.stage === 'MIX' ? 'CURRENT' : 'WAITING', by: (j.mixed_by as string) ?? null, at: at(j.mixed_dt) },
    ];
    if (oilBatchId) {
      const runs = await this.sql<Row[]>`select status, started_at, closed_at, created_by from production.maceration_run where oil_batch_id = ${oilBatchId}::uuid order by started_at`;
      for (const r of runs) {
        steps.push({ station: 'MACERATION', state: r.status === 'MACERATING' ? 'CURRENT' : 'DONE', by: (r.created_by as string) ?? null, at: at(r.started_at), note: r.closed_at ? `closed ${at(r.closed_at)}` : null });
      }
      for (const q of await this.rounds(oilBatchId)) {
        steps.push({ station: `QC ROUND ${q.roundNo}`, state: q.decision ? 'DONE' : 'BOOKED', by: (q.decidedBy as string) ?? (q.bookedBy as string) ?? null, at: (q.decidedDt as string) ?? (q.bookedDt as string) ?? null, note: `proposal ${q.proposal ?? 'none'}${q.decision ? `, decided ${q.decision}` : ''}` });
      }
    }
    return { floorJobId: String(j.floor_job_id), batchNo: j.batch_no, steps };
  }

  /* ── Stock cover, floor codes, one code, its lots, racks (FAC-BE-16) ─────────────────────── */

  private async coverRows() {
    const rows = await this.sql<Row[]>`
      select c.material_id::text as "materialId", c.family_code as "familyCode", c.number, f.colour_name as "colourName", f.colour_hex as "colourHex",
             m.reorder_level::text as "reorderQty", mu.uom_code as "reorderUom",
             coalesce((select json_agg(json_build_object('qty', ib.quantity_on_hand::text, 'uom', u.uom_code))
                         from inventory.inventory_batch ib left join platform.uom_master u on u.uom_id = ib.uom_id
                        where ib.material_id = c.material_id and ib.quantity_on_hand > 0), '[]'::json) as "stock",
             coalesce((select json_agg(distinct sl.storage_location_code)
                         from inventory.inventory_batch ib join location.storage_location_master sl on sl.storage_location_id = ib.storage_location_id
                        where ib.material_id = c.material_id and ib.quantity_on_hand > 0), '[]'::json) as "bins",
             exists (select 1 from procurement.purchase_request_items pi join procurement.purchase_request pr on pr.purchase_request_id = pi.purchase_request_id
                      where pi.material_id = c.material_id and coalesce(pr.status, '') not in ('REJECTED', 'CANCELLED', 'CLOSED', 'COMPLETED')) as "requestOpen"
        from masterdata.floor_code c
        join masterdata.floor_family_colour f on f.family_code = c.family_code
        join masterdata.material m on m.material_id = c.material_id
        left join platform.uom_master mu on mu.uom_id = m.uom_id
       order by f.colour_name, c.number`;
    return rows.map((r) => {
      const on = sumMg(r.stock as Array<{ qty: string | null; uom: string | null }>);
      const reorderAtMg = r.reorderQty == null ? null : qtyToMg(r.reorderQty as string, (r.reorderUom as string) ?? null);
      return {
        code: codeText(String(r.colourName), Number(r.number)),
        materialId: String(r.materialId),
        familyCode: r.familyCode as string, colourName: r.colourName as string, colourHex: r.colourHex as string,
        bins: (r.bins as string[]).filter(Boolean),
        onHandMg: on.mg, unconverted: on.unconverted,
        reorderAtMg,
        belowReorder: on.mg === null || reorderAtMg === null ? null : on.mg < reorderAtMg,
        requestOpen: Boolean(r.requestOpen),
        coverDays: null as number | null,
      };
    });
  }

  async stockCover(q: { q?: unknown; state?: unknown; cursor?: unknown; limit?: unknown }) {
    const { limit, offset } = page(q.limit, q.cursor);
    const needle = typeof q.q === 'string' ? q.q.trim().toUpperCase().slice(0, 40) : '';
    const state = q.state === 'low' || q.state === 'covered' ? q.state : 'all';
    const all = (await this.coverRows()).filter((r) =>
      (!needle || r.code.includes(needle) || r.colourName.toUpperCase().includes(needle) || r.bins.some((b) => b.toUpperCase().includes(needle))) &&
      (state === 'all' || (state === 'low' ? r.belowReorder === true : r.belowReorder === false)));
    return { ...paged(all, limit, offset), coverNote: COVER_NOT_HELD };
  }

  async floorCodes() {
    const rows = await this.sql<Row[]>`
      select c.material_id::text as "materialId", c.family_code as "familyCode", f.family_name as "familyName", f.colour_name as "colourName",
             f.colour_hex as "colourHex", c.number, c.created_by as "createdBy", c.created_dt::text as "createdDt"
        from masterdata.floor_code c join masterdata.floor_family_colour f on f.family_code = c.family_code
       order by f.colour_name, c.number`;
    const items: Row[] = rows.map((r) => ({ code: codeText(String(r.colourName), Number(r.number)), ...r }));
    return { items, nextCursor: null, total: items.length };
  }

  async materialForCode(raw: unknown): Promise<{ materialId: string; code: string; familyCode: string; colourName: string; colourHex: string }> {
    const { colour, number } = parseCode(raw);
    const [r] = await this.sql<Row[]>`
      select c.material_id::text as "materialId", c.family_code as "familyCode", f.colour_name as "colourName", f.colour_hex as "colourHex", c.number
        from masterdata.floor_code c join masterdata.floor_family_colour f on f.family_code = c.family_code
       where upper(regexp_replace(f.colour_name, '[^A-Za-z]', '', 'g')) = ${colour} and c.number = ${number}`;
    if (!r) throw new NotFoundException(`No floor code ${colour}-${String(number).padStart(4, '0')} on file.`);
    return { materialId: String(r.materialId), code: codeText(String(r.colourName), Number(r.number)), familyCode: String(r.familyCode), colourName: String(r.colourName), colourHex: String(r.colourHex) };
  }

  async codeSummary(raw: unknown) {
    const head = await this.materialForCode(raw);
    const cover = (await this.coverRows()).find((r) => r.materialId === head.materialId)!;
    const [lots] = await this.sql<{ n: number }[]>`select count(*)::int as n from inventory.inventory_batch where material_id = ${head.materialId}::uuid and quantity_on_hand > 0`;
    return { ...cover, lots: lots!.n, coverNote: COVER_NOT_HELD };
  }

  async codeLots(raw: unknown) {
    const head = await this.materialForCode(raw);
    const rows = await this.sql<Row[]>`
      select ib.inventory_batch_id::text as "inventoryBatchId", rb.batch_number as "lot", ib.quantity_on_hand::text as "qty", u.uom_code as "uom",
             rb.manufacturing_date::text as "manufacturedOn", rb.expiry_date::text as "expiresOn", rb.status as "lotStatus",
             sl.storage_location_code as "bin",
             exists (select 1 from inventory.lot_hold h where h.subject_type = 'RM_LOT' and h.subject_id = rb.rm_batch_id and h.released_dt is null) as "held"
        from inventory.inventory_batch ib
        left join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
        left join platform.uom_master u on u.uom_id = ib.uom_id
        left join location.storage_location_master sl on sl.storage_location_id = ib.storage_location_id
       where ib.material_id = ${head.materialId}::uuid and ib.quantity_on_hand > 0
       order by rb.expiry_date asc nulls last, ib.created_dt asc`;
    const items: Row[] = rows.map(({ qty, uom, ...r }) => ({ ...r, onHandMg: qtyToMg(qty as string, (uom as string) ?? null) }));
    return { code: head.code, items, nextCursor: null, total: items.length };
  }

  async racks() {
    const rows = await this.sql<Row[]>`
      select r.rack_id::text as "rackId", r.rack_code as "rackCode", r.status, w.walk_seq as "walkSeq",
             coalesce((select json_agg(json_build_object('binCode', b.bin_code, 'status', b.status,
                        'families', coalesce((select json_agg(distinct c.family_code)
                                                from location.storage_location_master sl
                                                join inventory.inventory_batch ib on ib.storage_location_id = sl.storage_location_id and ib.quantity_on_hand > 0
                                                join masterdata.floor_code c on c.material_id = ib.material_id
                                               where upper(sl.storage_location_code) = upper(b.bin_code)), '[]'::json)) order by s.shelf_code, b.bin_code)
                         from location.shelf_master s join location.bin_master b on b.shelf_id = s.shelf_id
                        where s.rack_id = r.rack_id), '[]'::json) as "bins"
        from location.rack_master r
        left join location.rack_walk_order w on w.rack_id = r.rack_id
       order by w.walk_seq asc nulls last, r.rack_code`;
    // VF-FIX: the colour zones painted on the racks (family code, colour name and hex, the initial printed beside
    // the colour), and nothing else: no family name, no count of codes, no material. ALEMBIC's relay may not read
    // /v1/floor/families for the factory door (that read also carries a count of codes and who changed it), so the
    // zones travel here. NOT a cursor page: the global envelope lifts { items, nextCursor } into `data` and drops
    // every other key, which is how `families` never reached RAC OS (its rack layout drew no zone at all).
    const fam = await this.sql<Row[]>`select family_code as "familyCode", colour_name as "colourName", colour_hex as "colourHex", initial
                                        from masterdata.floor_family_colour order by family_code`;
    return { items: rows, total: rows.length, families: fam };
  }

  /* ── QC queue, lot trace, recalls ────────────────────────────────────────────────────────── */

  /** Batches waiting on QC and raw lots in quarantine, one list, oldest first (FAC-BE-27). */
  async qcQueue(q: { kind?: unknown; cursor?: unknown; limit?: unknown }) {
    const { limit, offset } = page(q.limit, q.cursor);
    const batches = await this.sql<Row[]>`
      select 'BATCH' as "kind", b.oil_batch_id::text as "id", b.batch_number as "ref", coalesce(lr.created_dt, j.mixed_dt, b.created_dt)::text as "since",
             lr.round_no as "lastRound", lr.decision as "lastProposal", null::text as "code"
        from production.oil_batch_master b
        join production.floor_job j on j.oil_batch_id = b.oil_batch_id
        left join lateral (select round_no, decision, created_dt from quality.batch_qc_round qr where qr.oil_batch_id = b.oil_batch_id order by qr.round_no desc limit 1) lr on true
       where coalesce(b.status, '') not in ('RELEASED', 'REJECTED', 'CLOSED', 'CANCELLED', 'ABORTED')
         and not exists (select 1 from production.maceration_run mr where mr.oil_batch_id = b.oil_batch_id and mr.status = 'MACERATING')
         and coalesce(lr.decision, '') <> 'APPROVE'`;
    const lots = await this.sql<Row[]>`
      select 'RM_LOT' as "kind", rb.rm_batch_id::text as "id", rb.batch_number as "ref", rb.created_dt::text as "since",
             null::int as "lastRound", null::text as "lastProposal", f.colour_name as "colourName", c.number
        from inventory.rm_batch_master rb
        left join masterdata.floor_code c on c.material_id = rb.material_id
        left join masterdata.floor_family_colour f on f.family_code = c.family_code
       where rb.status = 'QUARANTINE'`;
    const all = [
      ...batches.map((b) => ({ kind: 'BATCH' as const, id: b.id as string, ref: b.ref as string, since: b.since as string, lastRound: b.lastRound as number | null, lastProposal: b.lastProposal as string | null, code: null as string | null })),
      ...lots.map((l) => ({ kind: 'RM_LOT' as const, id: l.id as string, ref: l.ref as string, since: l.since as string, lastRound: null, lastProposal: null, code: l.colourName ? codeText(String(l.colourName), Number(l.number)) : null })),
    ].filter((r) => q.kind === 'batch' ? r.kind === 'BATCH' : q.kind === 'rm' ? r.kind === 'RM_LOT' : true)
      .sort((a, b) => String(a.since).localeCompare(String(b.since)));
    return paged(all, limit, offset);
  }

  /** Lot trace, one list of batches with how many raw lots went into each (FAC-BE-18). */
  async traceBatches(q: { q?: unknown; cursor?: unknown; limit?: unknown }) {
    const { limit, offset } = page(q.limit, q.cursor);
    const needle = typeof q.q === 'string' ? q.q.trim().slice(0, 50) : '';
    const rows = await this.sql<Row[]>`
      select b.oil_batch_id::text as "oilBatchId", b.batch_number as "batchNumber", b.status, b.produced_dt::text as "producedDt",
             j.job_no as "jobNo", j.order_ref as "orderRef",
             (select count(distinct ib.rm_batch_id)::int from production.floor_line l join inventory.inventory_batch ib on ib.inventory_batch_id = l.picked_batch_id
               where l.floor_job_id = j.floor_job_id) as "rawLots",
             -- RELAY-W2 3(a): each fill is the system's own finished-good lot and its fill day; none, none.
             coalesce((select json_agg(json_build_object('lot', fg.batch_number, 'filledOn', fg.manufacturing_date::text) order by fg.manufacturing_date, fg.batch_number)
                         from packaging.package_order po join packaging.finished_good_batch_master fg on fg.package_order_id = po.package_order_id
                        where po.oil_batch_id = b.oil_batch_id), '[]'::json) as "fills"
        from production.oil_batch_master b
        left join production.floor_job j on j.oil_batch_id = b.oil_batch_id
       where ${needle ? this.sql`(b.batch_number ilike ${'%' + needle + '%'} or j.job_no ilike ${'%' + needle + '%'})` : this.sql`true`}
       order by b.created_dt desc
       limit ${limit + 1} offset ${offset}`;
    const [t] = await this.sql<{ n: number }[]>`
      select count(*)::int as n from production.oil_batch_master b left join production.floor_job j on j.oil_batch_id = b.oil_batch_id
       where ${needle ? this.sql`(b.batch_number ilike ${'%' + needle + '%'} or j.job_no ilike ${'%' + needle + '%'})` : this.sql`true`}`;
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? String(offset + limit) : null, total: t!.n };
  }

  async recalls(q: { cursor?: unknown; limit?: unknown }) {
    const { limit, offset } = page(q.limit, q.cursor);
    const rows = await this.sql<Row[]>`
      select recall_review_id::text as "recallReviewId", recall_no as "recallNo", subject_type as "subjectType", subject_id::text as "subjectId",
             lot_ref as "lot", lot_hold_id::text as "lotHoldId", state, reason, started_by as "startedBy", started_dt::text as "startedDt",
             decided_by as "decidedBy", decided_dt::text as "decidedDt", decision, decision_reason as "decisionReason",
             -- RELAY-W2 3(a): the factory system's own sales orders this recall reaches, from dispatch records:
             -- the lot (a raw lot through the batches it was picked into, or the oil batch itself) -> its fills
             -- -> the dispatches that carried them. RAC OS orders are not known here.
             coalesce((select json_agg(distinct jsonb_build_object('soNumber', so.so_number, 'dispatchedOn', dm.dispatch_date::text))
                         from packaging.package_order po
                         join packaging.finished_good_batch_master fg on fg.package_order_id = po.package_order_id
                         join sales.dispatch_items di on di.finished_good_batch_id = fg.finished_good_batch_id
                         join sales.dispatch_master dm on dm.dispatch_id = di.dispatch_id
                         left join sales.sales_order so on so.sales_order_id = dm.sales_order_id
                        where po.oil_batch_id in (
                          select rr.subject_id where rr.subject_type = 'OIL_BATCH'
                          union
                          select j.oil_batch_id from production.floor_line l
                            join production.floor_job j on j.floor_job_id = l.floor_job_id
                            join inventory.inventory_batch ib on ib.inventory_batch_id = l.picked_batch_id
                           where rr.subject_type = 'RM_LOT' and ib.rm_batch_id = rr.subject_id and j.oil_batch_id is not null)), '[]'::json) as "ordersReached"
        from quality.recall_review rr order by started_dt desc limit ${limit + 1} offset ${offset}`;
    const [t] = await this.sql<{ n: number }[]>`select count(*)::int as n from quality.recall_review`;
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? String(offset + limit) : null, total: t!.n };
  }

  /* ── Settings: operating rules, maceration defaults (FAC-BE-03, FAC-BE-06) ───────────────── */

  async operatingRules(siteRaw: unknown) {
    const site = siteOf(siteRaw);
    const rows = await this.sql<Row[]>`
      select distinct on (rule_key) rule_key as "key", value, reason, set_by as "setBy", set_dt::text as "setDt",
             (select count(*)::int from platform.operating_rule o2 where o2.site = o.site and o2.rule_key = o.rule_key) as "versions"
        from platform.operating_rule o where site = ${site}
       order by rule_key, set_dt desc, operating_rule_id desc`;
    return { site, items: rows, nextCursor: null, total: rows.length };
  }

  async macerationDefaults(siteRaw: unknown) {
    const site = siteOf(siteRaw);
    const rows = await this.sql<Row[]>`
      select distinct on (product_class) product_class as "productClass", min_days as "minDays", max_days as "maxDays", reason,
             set_by as "setBy", set_dt::text as "setDt"
        from production.maceration_default where site = ${site}
       order by product_class, set_dt desc, maceration_default_id desc`;
    return { site, items: rows, nextCursor: null, total: rows.length };
  }

  /* ── Factory people (FAC-BE-20) ──────────────────────────────────────────────────────────── */

  async factoryPeople(q: { q?: unknown; cursor?: unknown; limit?: unknown }) {
    const { limit, offset } = page(q.limit, q.cursor);
    const needle = typeof q.q === 'string' ? q.q.trim().slice(0, 60) : '';
    const rows = await this.sql<Row[]>`
      select u.user_id::text as "userId", u.user_name as "name", u.employee_code as "employeeCode",
             coalesce((select json_agg(r.role_code order by r.role_code) from iam.user_role_mapping m join iam.role_master r on r.role_id = m.role_id
                        where m.user_id = u.user_id and coalesce(m.status, 'ACTIVE') = 'ACTIVE'), '[]'::json) as "roles",
             (select json_build_object('roleChangeRequestId', rc.role_change_request_id::text, 'toRole', rc.to_role_code, 'station', rc.station,
                                       'requestedBy', rc.requested_by, 'requestedDt', rc.requested_dt::text)
                from iam.role_change_request rc where rc.user_id = u.user_id and rc.state = 'REQUESTED' order by rc.requested_dt desc limit 1) as "pendingChange"
        from iam.user_master u
       where coalesce(u.is_active, true) and coalesce(u.status, 'ACTIVE') = 'ACTIVE'
         and ${needle ? this.sql`(u.user_name ilike ${'%' + needle + '%'} or u.employee_code ilike ${'%' + needle + '%'})` : this.sql`true`}
       order by u.user_name nulls last, u.user_id
       limit ${limit + 1} offset ${offset}`;
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? String(offset + limit) : null };
  }

  /* ── Device test state (FAC-BE-08) ───────────────────────────────────────────────────────── */

  async deviceTest(deviceId: string) {
    const [d] = await this.sql<Row[]>`select device_id::text as "deviceId", kind, station, name, status, paired_at::text as "pairedAt",
                                             last_seen_at::text as "lastSeenAt", revoked_at::text as "revokedAt"
                                        from platform.device_master where device_id = ${deviceId}::uuid`;
    if (!d) throw new NotFoundException('No such device.');
    const [t] = await this.sql<Row[]>`select device_test_id::text as "deviceTestId", state, result, requested_by as "requestedBy",
                                             requested_at::text as "requestedAt", tested_at::text as "testedAt"
                                        from platform.device_test where device_id = ${deviceId}::uuid order by requested_at desc limit 1`;
    return { ...d, paired: d.pairedAt != null && d.revokedAt == null, test: t ?? null };
  }
}

/** A branch code: letters, digits, hyphen; upper-cased. Required: a rule belongs to a branch. */
export function siteOf(raw: unknown): string {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,40}$/.test(s)) throw new BadRequestException('Name the branch (site), like INDORE.');
  return s;
}
