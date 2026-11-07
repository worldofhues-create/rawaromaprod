/**
 * PROD-A-5 — the Picker -> Verifier -> Mixer checklists (production-floor plan §5, §6, §12.5).
 *
 * A floor job wraps one existing production order and its pick list. It is built ON the existing
 * flow, not beside it:
 *   - its lines are the pick list's lines (production.material_pick_list_items, whose picked_qty the
 *     Vault computed), held here as integer milligrams;
 *   - completing the pick raises the ordinary material issue (PickingService.issueMaterials), so the
 *     consumption poller debits exactly the lots that were scanned;
 *   - the verifier's readings are ordinary weighing records on an ordinary mixing session
 *     (MixingService.startSession), one ACCEPTED record per line, so MixingService.endSession's
 *     "every line weighed" check holds;
 *   - the mixer's steps are mixing_step_log rows, and completing the mix ends the session and
 *     produces the oil batch with one consumption row per raw lot used (the genealogy).
 *
 * Rules every station enforces, each a refusal with the reason shown:
 *   - the checklist cannot complete with an open line, and steps run in order;
 *   - the picker is told which lot to take (FEFO, then FIFO by receipt) and a scan of another lot
 *     is refused unless they give a reason; a lot of another material, a lot not released by QC,
 *     an expired lot, a lot too small for the line, or the wrong bin is refused outright;
 *   - the verifier's weight must be inside the line's tolerance on the EXACT stored mg (display
 *     rounding never decides); an out-of-tolerance reading is kept on file and the tick refused;
 *   - STOCK2-1: the stock ledger ends on that weight. Under the pick, the difference stays on the lot;
 *     over the pick, the reading is held until a supervisor records why, because more left the lot
 *     than the pick allowed. A supervisor cannot widen the tolerance: outside it stays refused. A
 *     reading the lot's unit cannot hold exactly is refused too, and is never rounded;
 *   - separation of duties: nobody verifies a pick they made, nobody mixes a job they verified;
 *   - two kiosks cannot work the same job at once (the job row is locked for each write).
 *
 * The picker never receives grams per formula; the verifier receives its line's target grams and
 * nothing else about the formula; nobody here receives a material name, CAS number or percentage.
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { BatchService, MixingService, PickingService } from '@ra/cluster-production';
import { massFactorMg, mgToQty, qtyToMgExact, uuidv7 } from '@core/data-kernel';
import { FloorCodeService, qtyToMg, codeText } from './floor-code.service.js';
import { clearAlert, raiseAlert } from '../floor-ops/floor-alerts.js';
import { gramsText } from './lot-split.service.js';
import { scanCode } from './scan-code.js';

export type LabelKind = 'PICKED' | 'VERIFIED' | 'MIXED';

/** Plant weighing tolerance, the same setting WeighingService reads (default 1 %), in ppm. */
export function defaultTolerancePpm(): number {
  const v = Number(process.env.WEIGHING_TOLERANCE_PCT);
  const pct = Number.isFinite(v) && v >= 0 && v <= 10 ? v : 1;
  return Math.round(pct * 10_000);
}

/** Exact integer check: |actual − target| ≤ target × ppm / 1e6. */
export function withinToleranceMg(actualMg: number, targetMg: number, ppm: number): boolean {
  return BigInt(Math.abs(actualMg - targetMg)) * 1_000_000n <= BigInt(targetMg) * BigInt(ppm);
}

/** Tolerance window in mg, rounded down so the window shown is never wider than the check. */
export function toleranceMg(targetMg: number, ppm: number): number {
  return Number((BigInt(targetMg) * BigInt(ppm)) / 1_000_000n);
}

/** mg → a decimal string in grams with 3 places (exact: 1 mg = 0.001 g). */
export function mgToGramText(mg: number): string {
  const neg = mg < 0 ? '-' : '';
  const a = Math.abs(mg);
  return `${neg}${Math.floor(a / 1000)}.${String(a % 1000).padStart(3, '0')}`;
}

interface JobRow {
  floor_job_id: string;
  job_no: string;
  production_order_id: string;
  material_pick_list_id: string;
  stage: string;
  promise_dt: string | null;
  expedite: boolean;
  order_ref: string | null;
  tote: string | null;
  picked_by: string | null;
  picked_dt: string | null;
  verified_by: string | null;
  verified_dt: string | null;
  mixed_by: string | null;
  mixed_dt: string | null;
  batch_no: string | null;
  mixing_session_id: string | null;
  oil_batch_id: string | null;
  created_dt: string;
}

interface LineRow {
  floor_line_id: string;
  material_pick_list_item_id: string;
  material_id: string;
  seq: number;
  target_mg: string;
  tolerance_ppm: number;
  picked_batch_id: string | null;
  picked_by: string | null;
  pick_off_fefo_reason: string | null;
  actual_mg: string | null;
  weigh_source: string | null;
  verified_by: string | null;
  over_mg: string | null;
  over_source: string | null;
  over_read_by: string | null;
  over_by: string | null;
}

/** A pickable lot of a material, FEFO then FIFO by receipt. Fail closed: a lot with no RM batch has
 *  no QC result and no lot number to recall by, so it is not pickable. */
const PICKABLE_LOTS = (sql: Sql | TransactionSql, materialId: string) => sql<{
  inventory_batch_id: string; qty: string; uom_code: string | null; batch_number: string | null; expiry_date: string | null; bin_code: string | null; bin_id: string | null;
}[]>`
  select ib.inventory_batch_id::text, ib.quantity_on_hand::text as qty, u.uom_code, rb.batch_number, rb.expiry_date::text,
         b.bin_code, ib.storage_location_id::text as bin_id
    from inventory.inventory_batch ib
    join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
    left join platform.uom_master u on u.uom_id = ib.uom_id
    left join location.bin_master b on b.bin_id = ib.storage_location_id
    join lateral (select overall_result from quality.qc_inspections q where q.rm_batch_id = ib.rm_batch_id order by created_dt desc limit 1) qc on true
   where ib.material_id = ${materialId} and ib.quantity_on_hand > 0
     and upper(coalesce(qc.overall_result, '')) in ('ACCEPT', 'PASS')
     and (rb.expiry_date is null or rb.expiry_date >= current_date)
   order by rb.expiry_date asc nulls last, rb.created_dt asc, rb.batch_number asc nulls last`;

@Injectable()
export class FloorStationService {
  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    private readonly codes: FloorCodeService,
    private readonly picking: PickingService,
    private readonly mixing: MixingService,
    private readonly batches: BatchService,
  ) {}

  /* ── jobs ────────────────────────────────────────────────────────────────────────────── */

  /** WALK2-RP-12: the runs a job can be opened for, by order number (the Floor queue asked for a typed
   *  production-order uuid): an active pick list and not on the floor yet. createJob re-checks all of it. */
  async jobCandidates() {
    const rows = await this.sql<{ id: string; order_number: string | null; status: string | null }[]>`
      select po.production_order_id::text as id, po.order_number, po.status
        from production.production_order po
       where exists (select 1 from production.material_pick_list pl where pl.production_order_id = po.production_order_id and coalesce(pl.status, 'ACTIVE') = 'ACTIVE')
         and not exists (select 1 from production.floor_job fj where fj.production_order_id = po.production_order_id)
       order by po.created_dt`;
    return { items: rows.map((r) => ({ productionOrderId: r.id, orderNumber: r.order_number, status: r.status })) };
  }

  /** Open a floor job for a production order that has a pick list. Every line must have a floor
   *  code and a mass unit, or the job is refused (nothing reaches the floor uncoded or unweighable). */
  async createJob(
    productionOrderId: string,
    opts: { promiseDt?: string | null; expedite?: boolean; steps?: string[]; channel?: string | null; customerTier?: string | null; coverSuggestionId?: string | null },
    principal: AuthPrincipal,
  ) {
    const [order] = await this.sql<{ status: string | null; order_number: string | null }[]>`
      select status, order_number from production.production_order where production_order_id = ${productionOrderId}`;
    if (!order) throw new NotFoundException('No such production order.');
    const [have] = await this.sql<{ floor_job_id: string; job_no: string }[]>`select floor_job_id, job_no from production.floor_job where production_order_id = ${productionOrderId}`;
    if (have) throw new ConflictException(`This order is already on the floor as ${have.job_no}.`);
    const [pl] = await this.sql<{ material_pick_list_id: string }[]>`
      select material_pick_list_id from production.material_pick_list
       where production_order_id = ${productionOrderId} and coalesce(status, 'ACTIVE') = 'ACTIVE'
       order by created_dt desc limit 1`;
    if (!pl) throw new ConflictException('This order has no pick list yet. Generate the pick list first.');
    const items = await this.sql<{ id: string; material_id: string | null; qty: string | null; uom_code: string | null }[]>`
      select i.material_pick_list_item_id::text as id, i.material_id::text, i.picked_qty::text as qty, u.uom_code
        from production.material_pick_list_items i left join platform.uom_master u on u.uom_id = i.uom_id
       where i.material_pick_list_id = ${pl.material_pick_list_id} and coalesce(i.status, 'ACTIVE') = 'ACTIVE'
       order by i.created_dt, i.material_pick_list_item_id`;
    if (!items.length) throw new ConflictException('The pick list has no lines.');
    const lines: Array<{ id: string; materialId: string; mg: number; code: string }> = [];
    for (const [i, it] of items.entries()) {
      if (!it.material_id) throw new ConflictException(`Line ${i + 1} names no material.`);
      const fc = await this.codes.codeFor(it.material_id);
      if (!fc) throw new ConflictException(`Line ${i + 1} has no floor code. File its material under a family first (Floor codes).`);
      const mg = qtyToMg(it.qty, it.uom_code);
      if (mg === null) throw new ConflictException(`Line ${i + 1} (${fc.code}) has no mass unit (kg, g or mg), so it cannot be weighed.`);
      if (!(mg > 0)) throw new ConflictException(`Line ${i + 1} (${fc.code}) has no quantity.`);
      // STOCK-UNITS: target_mg is an integer. Truncating 0.1235 g would weigh one figure and debit another.
      if (qtyToMgExact(it.qty, it.uom_code) === null) throw new ConflictException(`Line ${i + 1} (${fc.code}) is a part of a mg, which the floor cannot weigh. Correct the pick list.`);
      lines.push({ id: it.id, materialId: it.material_id, mg, code: fc.code });
    }
    // Promise date and order reference from the ALEMBIC requirement(s) this order serves.
    const [req] = await this.sql<{ needed_by: string | null; order_ref: string | null }[]>`
      select min(needed_by)::text as needed_by, min(order_ref) as order_ref from bridge.production_requirement
       where production_order_id = ${productionOrderId}`;
    const promise = opts.promiseDt ?? req?.needed_by ?? null;
    const ppm = defaultTolerancePpm();
    const steps = [
      ...lines.map((l, i) => `Add line ${i + 1}: ${l.code}, the verified weight, in this order`),
      ...(opts.steps ?? []).map((s) => String(s).trim()).filter(Boolean),
    ];
    return this.sql.begin(async (tx) => {
      // PROD-D-4: a job made for an approved cover suggestion is SUGGESTED and ranks below every
      // customer order; the suggestion is linked so it is not counted as planned stock twice.
      let source = 'ORDER';
      if (opts.coverSuggestionId) {
        const [cs] = await tx<{ status: string; floor_job_id: string | null }[]>`
          select status, floor_job_id::text from production.cover_suggestion where cover_suggestion_id = ${opts.coverSuggestionId} for update`;
        if (!cs) throw new NotFoundException('No such cover suggestion.');
        if (cs.status !== 'APPROVED') throw new ConflictException('Only an approved suggestion goes to the floor.');
        if (cs.floor_job_id) throw new ConflictException('That suggestion is already on the floor.');
        source = 'SUGGESTED';
      }
      const [seqRow] = await tx<{ n: string }[]>`select nextval('production.floor_job_no_seq')::text as n`;
      const n = seqRow!.n;
      const jobNo = `J-${n.padStart(4, '0')}`;
      const jobId = uuidv7();
      await tx`insert into production.floor_job (floor_job_id, job_no, production_order_id, material_pick_list_id, promise_dt, expedite, order_ref, channel, customer_tier, created_by, source, cover_suggestion_id)
        values (${jobId}, ${jobNo}, ${productionOrderId}, ${pl.material_pick_list_id}, ${promise}, ${!!opts.expedite}, ${req?.order_ref ?? order.order_number ?? null},
                ${opts.channel ?? null}, ${opts.customerTier ?? null}, ${principal.userId}, ${source}, ${opts.coverSuggestionId ?? null})`;
      if (opts.coverSuggestionId) await tx`update production.cover_suggestion set floor_job_id = ${jobId} where cover_suggestion_id = ${opts.coverSuggestionId}`;
      for (const [i, l] of lines.entries()) {
        await tx`insert into production.floor_line (floor_line_id, floor_job_id, material_pick_list_item_id, material_id, seq, target_mg, tolerance_ppm)
          values (${uuidv7()}, ${jobId}, ${l.id}, ${l.materialId}, ${i + 1}, ${l.mg}, ${ppm})`;
      }
      for (const [i, s] of steps.entries()) {
        await tx`insert into production.floor_mix_step (floor_job_id, seq, instruction) values (${jobId}, ${i + 1}, ${s})`;
      }
      return { floorJobId: jobId, jobNo, lines: lines.length, steps: steps.length, promiseDt: promise, source };
    });
  }

  private async lockJob(tx: TransactionSql, jobId: string): Promise<JobRow> {
    const [j] = await tx<JobRow[]>`
      select floor_job_id, job_no, production_order_id::text, material_pick_list_id::text, stage, promise_dt::text, expedite, order_ref, tote,
             picked_by, picked_dt::text, verified_by, verified_dt::text, mixed_by, mixed_dt::text, batch_no, mixing_session_id::text, oil_batch_id::text, created_dt::text
        from production.floor_job where floor_job_id = ${jobId} for update`;
    if (!j) throw new NotFoundException('No such floor job.');
    return j;
  }

  private async lines(sql: Sql | TransactionSql, jobId: string): Promise<LineRow[]> {
    return sql<LineRow[]>`
      select floor_line_id, material_pick_list_item_id::text, material_id::text, seq, target_mg::text, tolerance_ppm, picked_batch_id::text,
             picked_by, pick_off_fefo_reason, actual_mg::text, weigh_source, verified_by, over_mg::text, over_source, over_read_by, over_by
        from production.floor_line where floor_job_id = ${jobId} order by seq`;
  }

  private async job(jobId: string): Promise<JobRow> {
    const [j] = await this.sql<JobRow[]>`
      select floor_job_id, job_no, production_order_id::text, material_pick_list_id::text, stage, promise_dt::text, expedite, order_ref, tote,
             picked_by, picked_dt::text, verified_by, verified_dt::text, mixed_by, mixed_dt::text, batch_no, mixing_session_id::text, oil_batch_id::text, created_dt::text
        from production.floor_job where floor_job_id = ${jobId}`;
    if (!j) throw new NotFoundException('No such floor job.');
    return j;
  }

  /** Find a job by its tote (the verifier scans the tote), job number, or (SCAN-13) the batch number
   *  the MIXED label carries, so a MIXED label can be scanned to reprint it. */
  async findJob(ref: string) {
    const r = scanCode(ref); // SCAN-3
    if (!r) throw new BadRequestException('Scan or type a tote or job number.');
    const [j] = await this.sql<{ floor_job_id: string; job_no: string; stage: string }[]>`
      select floor_job_id, job_no, stage from production.floor_job where upper(tote) = upper(${r}) or upper(job_no) = upper(${r}) or upper(batch_no) = upper(${r})
       order by created_dt desc limit 1`;
    if (!j) throw new NotFoundException(`Nothing on the floor answers to ${r}.`);
    return { floorJobId: j.floor_job_id, jobNo: j.job_no, stage: j.stage };
  }

  private assertStage(j: JobRow, stage: string, what: string) {
    if (j.stage !== stage) {
      const where = j.stage === 'DONE' ? 'already finished' : `at ${j.stage.toLowerCase()}`;
      throw new ConflictException(`${j.job_no} is ${where}, not ready to ${what}.`);
    }
  }

  /* ── 1 Picker ────────────────────────────────────────────────────────────────────────── */

  /** The picker's checklist: coded lines, the lot to take (FEFO) and where it is. No grams. */
  async pickView(jobId: string) {
    const j = await this.job(jobId);
    const out = [];
    const ls = await this.lines(this.sql, jobId);
    for (const l of ls) {
      const fc = await this.codes.codeFor(l.material_id);
      const lot = l.picked_batch_id ? null : await this.directedLot(this.sql, l, ls);
      out.push({
        floorLineId: l.floor_line_id, seq: l.seq, floorCode: fc?.code ?? null, colourName: fc?.colourName ?? null, colourHex: fc?.colourHex ?? null, initial: fc?.initial ?? null,
        picked: !!l.picked_batch_id, offFefoReason: l.pick_off_fefo_reason,
        takeLot: lot ? { barcode: lot.barcode, lot: lot.batchNumber, bin: lot.bin, expiry: lot.expiry } : null,
        waiting: !l.picked_batch_id && !lot ? `No released lot of ${fc?.code ?? 'this code'} is large enough, or kept finely enough, for this line` : null,
      });
    }
    return { floorJobId: j.floor_job_id, jobNo: j.job_no, stage: j.stage, orderRef: j.order_ref, tote: j.tote, lines: out };
  }

  /** STOCK2-2: what this job's other lines have already picked from a lot. On-hand does not show it
   *  yet: the issue is raised at the end of the pick, so two lines could each see the whole lot. */
  private takenOnJob(ls: LineRow[], l: LineRow, batchId: string): number {
    return ls.reduce((a, x) => (x.floor_line_id !== l.floor_line_id && x.picked_batch_id === batchId ? a + Number(x.target_mg) : a), 0);
  }

  /** The lot the picker must take: first FEFO lot holding at least the line's target. */
  private async directedLot(sql: Sql | TransactionSql, l: LineRow, ls: LineRow[]) {
    const need = Number(l.target_mg);
    for (const lot of await PICKABLE_LOTS(sql, l.material_id)) {
      const mg = qtyToMg(lot.qty, lot.uom_code);
      // STOCK-UNITS: a lot that cannot hold the line exactly in its own unit would be refused at the debit.
      if (mg !== null && mg - this.takenOnJob(ls, l, lot.inventory_batch_id) >= need && mgToQty(need, lot.uom_code) !== null) {
        return { inventoryBatchId: lot.inventory_batch_id, batchNumber: lot.batch_number, bin: lot.bin_code, binId: lot.bin_id, expiry: lot.expiry_date, barcode: await this.codes.lotBarcode(lot.inventory_batch_id, null) };
      }
    }
    return null;
  }

  async pickLine(jobId: string, lineId: string, body: { bin?: string; barcode?: string; reason?: string }, principal: AuthPrincipal) {
    const barcode = scanCode(body.barcode).toUpperCase(); // SCAN-3
    const bin = scanCode(body.bin);
    if (!barcode) throw new BadRequestException('Scan the lot label.');
    return this.sql.begin(async (tx) => {
      const j = await this.lockJob(tx, jobId);
      this.assertStage(j, 'PICK', 'pick');
      const ls = await this.lines(tx, jobId);
      const l = ls.find((x) => x.floor_line_id === lineId);
      if (!l) throw new NotFoundException('That line is not on this job.');
      if (l.picked_batch_id) throw new ConflictException(`Line ${l.seq} is already picked.`);
      const fc = await this.codes.codeFor(l.material_id);
      const [scan] = await tx<{ inventory_batch_id: string; material_id: string | null }[]>`
        select ib.inventory_batch_id::text, ib.material_id::text from inventory.lot_barcode lb
          join inventory.inventory_batch ib on ib.inventory_batch_id = lb.inventory_batch_id where lb.barcode = ${barcode}`;
      if (!scan) throw new BadRequestException('That lot label is not known here.');
      if (scan.material_id !== l.material_id) {
        const other = scan.material_id ? await this.codes.codeFor(scan.material_id) : null;
        throw new BadRequestException(`Wrong material: that lot is ${other?.code ?? 'another code'}, this line needs ${fc?.code ?? 'its own code'}. Put it back.`);
      }
      const lots = await PICKABLE_LOTS(tx, l.material_id);
      const scanned = lots.find((x) => x.inventory_batch_id === scan.inventory_batch_id);
      if (!scanned) throw new BadRequestException('That lot cannot be picked: it is not released by QC, has expired, or is empty.');
      const mg = qtyToMg(scanned.qty, scanned.uom_code);
      if (mg === null || mg - this.takenOnJob(ls, l, scan.inventory_batch_id) < Number(l.target_mg)) throw new BadRequestException('That lot does not hold enough for this line. Take the lot the screen names.');
      if (mgToQty(Number(l.target_mg), scanned.uom_code) === null) throw new BadRequestException(`A lot kept in ${scanned.uom_code} cannot hold this line's weight exactly, so it cannot be debited. Take a lot kept in g, or ask the supervisor.`);
      if (scanned.bin_code && bin.toUpperCase() !== scanned.bin_code.toUpperCase()) {
        throw new BadRequestException(bin ? `Wrong bin: that lot is in ${scanned.bin_code}, you scanned ${bin}.` : `Scan the bin first: that lot is in ${scanned.bin_code}.`);
      }
      const directed = await this.directedLot(tx, l, ls);
      const reason = String(body.reason ?? '').trim();
      if (directed && directed.inventoryBatchId !== scan.inventory_batch_id && !reason) {
        throw new ConflictException(`Take lot ${directed.batchNumber ?? directed.barcode} first (it expires first${directed.expiry ? `, ${directed.expiry}` : ''}). To take this one instead, give a reason.`);
      }
      await tx`update production.floor_line set picked_batch_id = ${scan.inventory_batch_id}, picked_mg = target_mg,
        pick_off_fefo_reason = ${directed && directed.inventoryBatchId !== scan.inventory_batch_id ? reason : null},
        picked_by = ${principal.userId}, picked_dt = now() where floor_line_id = ${lineId}`;
      return { floorLineId: lineId, seq: l.seq, picked: true, offFefo: !!(directed && directed.inventoryBatchId !== scan.inventory_batch_id) };
    });
  }

  async completePick(jobId: string, body: { tote?: string }, principal: AuthPrincipal) {
    const tote = String(body.tote ?? '').trim().toUpperCase();
    if (!tote) throw new BadRequestException('Scan the tote the materials are in.');
    return this.sql.begin(async (tx) => {
      const j = await this.lockJob(tx, jobId);
      this.assertStage(j, 'PICK', 'finish picking');
      const ls = await this.lines(tx, jobId);
      const open = ls.filter((l) => !l.picked_batch_id);
      if (open.length) throw new ConflictException(`${open.length} line(s) still open: ${open.map((l) => l.seq).join(', ')}.`);
      const [busy] = await tx`select job_no from production.floor_job where upper(tote) = ${tote} and stage in ('VERIFY', 'MIX') and floor_job_id <> ${jobId}`;
      if (busy) throw new ConflictException(`Tote ${tote} is already carrying ${(busy as { job_no: string }).job_no}.`);
      await tx`update production.floor_job set stage = 'VERIFY', tote = ${tote}, picked_by = ${principal.userId}, picked_dt = now() where floor_job_id = ${jobId}`;
      const label = await this.printTx(tx, jobId, 'PICKED', principal, null);
      // The ordinary material issue, from exactly the lots scanned: the consumption poller debits them.
      await this.picking.issueMaterials({
        productionOrderId: j.production_order_id,
        materialPickListId: j.material_pick_list_id,
        items: ls.map((l) => ({ materialPickListItemId: l.material_pick_list_item_id, inventoryBatchId: l.picked_batch_id! })),
      } as never, principal);
      return { stage: 'VERIFY', label };
    });
  }

  /* ── 2 Verifier ──────────────────────────────────────────────────────────────────────── */

  async verifyView(jobId: string) {
    const j = await this.job(jobId);
    const out = [];
    for (const l of await this.lines(this.sql, jobId)) {
      const fc = await this.codes.codeFor(l.material_id);
      const target = Number(l.target_mg);
      out.push({
        floorLineId: l.floor_line_id, seq: l.seq, floorCode: fc?.code ?? null, colourName: fc?.colourName ?? null, colourHex: fc?.colourHex ?? null, initial: fc?.initial ?? null,
        targetMg: target, toleranceMg: toleranceMg(target, l.tolerance_ppm),
        actualMg: l.actual_mg === null ? null : Number(l.actual_mg), source: l.weigh_source, verified: l.actual_mg !== null,
        heldOverMg: l.actual_mg === null && l.over_mg !== null ? Number(l.over_mg) : null,
      });
    }
    return { floorJobId: j.floor_job_id, jobNo: j.job_no, stage: j.stage, orderRef: j.order_ref, tote: j.tote, lines: out };
  }

  private assertNotPicker(j: JobRow, ls: LineRow[], principal: AuthPrincipal) {
    if (j.picked_by === principal.userId || ls.some((l) => l.picked_by === principal.userId)) {
      throw new ForbiddenException('You picked this job, so someone else must verify it.');
    }
  }

  async verifyLine(jobId: string, lineId: string, body: { actualMg?: unknown; source?: string; scaleRef?: string }, principal: AuthPrincipal) {
    const actual = Number(body.actualMg);
    if (!Number.isSafeInteger(actual) || actual <= 0) throw new BadRequestException('Enter the weight on the scale.');
    const source = body.source === 'scale' ? 'scale' : 'typed';
    return this.sql.begin(async (tx) => {
      const j = await this.lockJob(tx, jobId);
      this.assertStage(j, 'VERIFY', 'verify');
      const ls = await this.lines(tx, jobId);
      this.assertNotPicker(j, ls, principal);
      const l = ls.find((x) => x.floor_line_id === lineId);
      if (!l) throw new NotFoundException('That line is not on this job.');
      if (l.actual_mg !== null) throw new ConflictException(`Line ${l.seq} is already verified.`);
      const target = Number(l.target_mg);
      const ok = withinToleranceMg(actual, target, l.tolerance_ppm);
      let sessionId = j.mixing_session_id;
      if (!sessionId) {
        const s = await this.mixing.startSession({ productionOrderId: j.production_order_id } as never, principal);
        sessionId = (s as { secureMixingSessionId: string }).secureMixingSessionId;
        await tx`update production.floor_job set mixing_session_id = ${sessionId} where floor_job_id = ${jobId}`;
      }
      const fc = await this.codes.codeFor(l.material_id);
      // STOCK2-1: the debit will book this reading, so a reading the lot cannot hold stops here.
      const [lot] = await tx<{ uom_code: string | null }[]>`
        select u.uom_code from inventory.inventory_batch ib left join platform.uom_master u on u.uom_id = ib.uom_id where ib.inventory_batch_id = ${l.picked_batch_id}`;
      const bookable = mgToQty(actual, lot?.uom_code) !== null;
      const over = ok && bookable && actual > target;
      const status = !ok ? 'OUT_OF_TOLERANCE' : !bookable ? 'NOT_BOOKABLE' : over ? 'OVER_PICK' : 'ACCEPTED';
      // An ordinary weighing record, in grams (exact to the mg): kept on file whatever the answer.
      await this.weighingRecord(tx, j, sessionId, l, fc?.code ?? codeText('UNCODED', 0), actual, ok, body.scaleRef ?? (source === 'typed' ? 'typed' : null), status, principal.userId);
      if (!ok) {
        return { floorLineId: lineId, seq: l.seq, verified: false, withinTolerance: false, targetMg: target, toleranceMg: toleranceMg(target, l.tolerance_ppm), actualMg: actual,
          message: 'Outside tolerance. Re-weigh, or call a supervisor.' };
      }
      if (!bookable) {
        const step = gramsText(massFactorMg(lot?.uom_code)! / 10000);
        return { floorLineId: lineId, seq: l.seq, verified: false, withinTolerance: true, notBookable: true, targetMg: target, actualMg: actual,
          message: `This lot is kept in ${lot?.uom_code}, which holds ${step} steps, so ${gramsText(actual)} cannot go on its ledger. Bring the weight to a multiple of ${step} and weigh again.` };
      }
      if (over) {
        await tx`update production.floor_line set over_mg = ${actual}, over_source = ${source}, over_read_by = ${principal.userId} where floor_line_id = ${lineId}`;
        await clearAlert(tx as unknown as Sql, `stock_over_pick:${lineId}`, new Date()); // a later reading replaces the figure a supervisor will read
        await raiseAlert(tx as unknown as Sql, {
          kind: 'STOCK_OVER_PICK', station: 'Floor', subjectType: 'FLOOR_LINE', subjectId: lineId,
          title: `${j.job_no} line ${l.seq} weighed over the pick`,
          body: `${gramsText(actual)} against ${gramsText(target)} picked. Next: re-weigh at or under the pick, or a supervisor records why from the Floor queue.`,
          dedupeKey: `stock_over_pick:${lineId}`,
        }, new Date());
        return { floorLineId: lineId, seq: l.seq, verified: false, withinTolerance: true, overPick: true, targetMg: target, actualMg: actual,
          message: `${gramsText(actual - target)} over the pick. The reading is held. Re-weigh, or call a supervisor to record why.` };
      }
      await this.acceptReading(tx, l, actual, source, principal.userId, null);
      return { floorLineId: lineId, seq: l.seq, verified: true, withinTolerance: true, targetMg: target, actualMg: actual };
    });
  }

  private weighingRecord(tx: TransactionSql, j: JobRow, sessionId: string, l: LineRow, code: string, actual: number, ok: boolean, scaleRef: string | null, status: string, by: string) {
    return tx`insert into production.weighing_record (weighing_record_id, production_order_id, secure_mixing_session_id, sequence_no, floor_code,
          target_qty, uom, gross_qty, tare_qty, net_qty, tolerance_pct, within_tolerance, scale_ref, weighed_by, weighed_dt, status, created_by, updated_by)
        values (${uuidv7()}, ${j.production_order_id}, ${sessionId}, ${l.seq}, ${code},
          ${mgToGramText(Number(l.target_mg))}, 'g', ${mgToGramText(actual)}, '0', ${mgToGramText(actual)}, ${(l.tolerance_ppm / 10_000).toFixed(3)}, ${ok},
          ${scaleRef}, ${by}, now(), ${status}, ${by}, ${by})`;
  }

  /** The reading stands: on the line, then on the ledger. `over` is the supervisor's record, if any. */
  private async acceptReading(tx: TransactionSql, l: LineRow, actual: number, source: string, verifiedBy: string, over: { reason: string; by: string } | null) {
    // Written before debited_mg is read: see the note on the ordering in consumption.service.ts.
    await tx`update production.floor_line set actual_mg = ${actual}, weigh_source = ${source}, verified_by = ${verifiedBy}, verified_dt = now(),
        over_mg = ${over ? actual : null}, over_source = ${over ? source : null}, over_read_by = ${over ? verifiedBy : null},
        over_reason = ${over?.reason ?? null}, over_by = ${over?.by ?? null}, over_dt = ${over ? new Date().toISOString() : null}::timestamptz
      where floor_line_id = ${l.floor_line_id}`;
    await clearAlert(tx as unknown as Sql, `stock_over_pick:${l.floor_line_id}`, new Date());
    const [d] = await tx<{ debited_mg: string | null; issue_id: string | null; uom_code: string | null }[]>`
      select fl.debited_mg::text, mii.material_issue_id::text as issue_id, u.uom_code
        from production.floor_line fl
        left join production.material_issue_item mii on mii.material_pick_list_item_id = fl.material_pick_list_item_id and coalesce(mii.status, 'ACTIVE') <> 'REVERSED'
        left join inventory.inventory_batch ib on ib.inventory_batch_id = fl.picked_batch_id
        left join platform.uom_master u on u.uom_id = ib.uom_id
       where fl.floor_line_id = ${l.floor_line_id}`;
    if (d?.debited_mg == null || !d.issue_id) return; // not debited yet: the debit itself takes actual_mg
    const delta = actual - Number(d.debited_mg); // above zero: more left the lot than was debited
    if (delta === 0) return;
    const qty = mgToQty(Math.abs(delta), d.uom_code);
    if (qty === null) throw new ConflictException(`A lot kept in ${d.uom_code} cannot hold this difference exactly.`);
    const signed = delta > 0 ? qty : `-${qty}`;
    const [after] = await tx<{ q: string }[]>`
      update inventory.inventory_batch set quantity_on_hand = coalesce(quantity_on_hand, 0) - ${signed}::numeric, updated_dt = now()
       where inventory_batch_id = ${l.picked_batch_id} returning quantity_on_hand::text as q`;
    if (Number(after?.q) < 0) throw new ConflictException(`The lot does not hold the extra ${gramsText(delta)}. Count the lot before this reading goes on the ledger.`);
    await tx`update production.floor_line set debited_mg = ${actual} where floor_line_id = ${l.floor_line_id}`;
    await tx`insert into inventory.inventory_event_history
        (inventory_batch_id, event_type, event_dt, reference_document_id, reference_document_type, event_qty, performed_by, remarks, status)
      values (${l.picked_batch_id}, 'PRODUCTION_ISSUE_ADJUST', now(), ${d.issue_id}, 'MATERIAL_ISSUE', ${signed}, ${verifiedBy},
        ${delta < 0 ? `verified ${gramsText(actual)}: ${gramsText(-delta)} under the pick stays on the lot` : `verified ${gramsText(actual)}: ${gramsText(delta)} over the pick, supervisor recorded why`}, 'ACTIVE')`;
  }

  /** STOCK2-1: a supervisor records why a held reading stands. Not the picker, and not whoever took it. */
  async approveOverPick(lineId: string, body: { reason?: unknown }, principal: AuthPrincipal) {
    const reason = String(body.reason ?? '').trim().slice(0, 300);
    if (!reason) throw new BadRequestException('Say why more than the pick was used.');
    const [own] = await this.sql<{ floor_job_id: string }[]>`select floor_job_id::text from production.floor_line where floor_line_id = ${lineId}`;
    if (!own) throw new NotFoundException('No such line.');
    return this.sql.begin(async (tx) => {
      const j = await this.lockJob(tx, own.floor_job_id);
      this.assertStage(j, 'VERIFY', 'verify');
      const ls = await this.lines(tx, j.floor_job_id);
      const l = ls.find((x) => x.floor_line_id === lineId)!;
      if (l.actual_mg !== null || l.over_mg === null) throw new ConflictException(`Line ${l.seq} has no reading held over the pick.`);
      if (j.picked_by === principal.userId || ls.some((x) => x.picked_by === principal.userId)) throw new ForbiddenException('You picked this job, so someone else must record why.');
      if (l.over_read_by === principal.userId) throw new ForbiddenException('You took this reading, so someone else must record why.');
      const actual = Number(l.over_mg), by = l.over_read_by!;
      const fc = await this.codes.codeFor(l.material_id);
      await this.weighingRecord(tx, j, j.mixing_session_id!, l, fc?.code ?? codeText('UNCODED', 0), actual, true, 'supervisor', 'ACCEPTED', by);
      await this.acceptReading(tx, l, actual, l.over_source ?? 'typed', by, { reason, by: principal.userId });
      return { floorLineId: lineId, seq: l.seq, verified: true, withinTolerance: true, actualMg: actual, jobNo: j.job_no };
    });
  }

  async completeVerify(jobId: string, principal: AuthPrincipal) {
    return this.sql.begin(async (tx) => {
      const j = await this.lockJob(tx, jobId);
      this.assertStage(j, 'VERIFY', 'finish verifying');
      const ls = await this.lines(tx, jobId);
      this.assertNotPicker(j, ls, principal);
      const open = ls.filter((l) => l.actual_mg === null);
      if (open.length) throw new ConflictException(`${open.length} line(s) not weighed yet: ${open.map((l) => l.seq).join(', ')}.`);
      await tx`update production.floor_job set stage = 'MIX', verified_by = ${principal.userId}, verified_dt = now() where floor_job_id = ${jobId}`;
      const label = await this.printTx(tx, jobId, 'VERIFIED', principal, null);
      return { stage: 'MIX', label };
    });
  }

  /* ── 3 Mixer ─────────────────────────────────────────────────────────────────────────── */

  async mixView(jobId: string) {
    const j = await this.job(jobId);
    const steps = await this.sql<{ seq: number; instruction: string; done_by: string | null; done_dt: string | null }[]>`
      select seq, instruction, done_by, done_dt::text from production.floor_mix_step where floor_job_id = ${jobId} order by seq`;
    const next = steps.find((s) => !s.done_dt);
    return {
      floorJobId: j.floor_job_id, jobNo: j.job_no, stage: j.stage, orderRef: j.order_ref, tote: j.tote, batchNo: j.batch_no,
      steps: steps.map((s) => ({ seq: s.seq, instruction: s.instruction, done: !!s.done_dt, doneDt: s.done_dt, next: next?.seq === s.seq })),
    };
  }

  private assertNotVerifier(j: JobRow, principal: AuthPrincipal) {
    if (j.verified_by === principal.userId) throw new ForbiddenException('You verified this job, so someone else must mix it.');
  }

  async doStep(jobId: string, seq: number, principal: AuthPrincipal) {
    return this.sql.begin(async (tx) => {
      const j = await this.lockJob(tx, jobId);
      this.assertStage(j, 'MIX', 'mix');
      this.assertNotVerifier(j, principal);
      const steps = await tx<{ seq: number; instruction: string; done_dt: string | null }[]>`
        select seq, instruction, done_dt::text from production.floor_mix_step where floor_job_id = ${jobId} order by seq`;
      const step = steps.find((s) => s.seq === seq);
      if (!step) throw new NotFoundException(`No step ${seq} on this job.`);
      if (step.done_dt) throw new ConflictException(`Step ${seq} is already done.`);
      const next = steps.find((s) => !s.done_dt)!;
      if (next.seq !== seq) throw new ConflictException(`Do step ${next.seq} first: steps run in order.`);
      await tx`update production.floor_mix_step set done_by = ${principal.userId}, done_dt = now() where floor_job_id = ${jobId} and seq = ${seq}`;
      if (j.mixing_session_id) {
        await this.mixing.logStep(j.mixing_session_id, { stepSequence: seq, stepDescription: step.instruction } as never, principal);
      }
      return { seq, done: true };
    });
  }

  async completeMix(jobId: string, principal: AuthPrincipal) {
    return this.sql.begin(async (tx) => {
      const j = await this.lockJob(tx, jobId);
      this.assertStage(j, 'MIX', 'finish mixing');
      this.assertNotVerifier(j, principal);
      const open = await tx<{ seq: number }[]>`select seq from production.floor_mix_step where floor_job_id = ${jobId} and done_dt is null order by seq`;
      if (open.length) throw new ConflictException(`${open.length} step(s) still open: ${open.map((s) => s.seq).join(', ')}.`);
      const ls = await this.lines(tx, jobId);
      const yymm = new Date().toISOString().slice(2, 7).replace('-', '');
      const batchNo = `B-${yymm}-${j.job_no.replace(/^J-/, '')}`;
      if (!j.mixing_session_id) throw new ConflictException('No mixing session on this job: it was never weighed.');
      await this.mixing.endSession(j.mixing_session_id, {} as never, principal);
      // The batch, in grams, with one consumption row per raw lot used: the genealogy a recall reads.
      const producedMg = ls.reduce((a, l) => a + Number(l.actual_mg ?? 0), 0);
      const [g] = await tx<{ uom_id: string }[]>`select uom_id::text from platform.uom_master where lower(uom_code) in ('g', 'gm', 'gram', 'grams') order by uom_code limit 1`;
      const made = await this.batches.produceOilBatch({
        productionOrderId: j.production_order_id,
        secureMixingSessionId: j.mixing_session_id,
        batchNumber: batchNo,
        producedQty: producedMg / 1000,
        uomId: g?.uom_id,
        consumption: ls.map((l) => ({ consumedForDocumentId: l.picked_batch_id!, consumedQty: Number(l.actual_mg) / 1000, uomId: g?.uom_id })),
      } as never, principal);
      const oilBatchId = (made as { batch: { oilBatchId: string } }).batch.oilBatchId;
      await tx`update production.floor_job set stage = 'DONE', mixed_by = ${principal.userId}, mixed_dt = now(), batch_no = ${batchNo}, oil_batch_id = ${oilBatchId}
        where floor_job_id = ${jobId}`;
      const label = await this.printTx(tx, jobId, 'MIXED', principal, null);
      return { stage: 'DONE', batchNo, oilBatchId, label };
    });
  }

  /* ── hand-off labels ─────────────────────────────────────────────────────────────────── */

  private async printTx(tx: TransactionSql, jobId: string, kind: LabelKind, principal: AuthPrincipal, reason: string | null) {
    const [prior] = await tx`select 1 from production.floor_label where floor_job_id = ${jobId} and kind = ${kind} limit 1`;
    const reprint = !!prior;
    if (reprint && !String(reason ?? '').trim()) throw new BadRequestException('A reprint needs a reason: a duplicate label is a recall risk.');
    const [row] = await tx<{ floor_label_id: string; printed_dt: string }[]>`
      insert into production.floor_label (floor_label_id, floor_job_id, kind, reprint, reason, printed_by)
      values (${uuidv7()}, ${jobId}, ${kind}, ${reprint}, ${reprint ? String(reason).trim() : null}, ${principal.userId})
      returning floor_label_id, printed_dt::text`;
    return this.labelPayload(tx, jobId, kind, row!.floor_label_id, row!.printed_dt, reprint, principal.userId);
  }

  private async labelPayload(sql: Sql | TransactionSql, jobId: string, kind: LabelKind, labelId: string, printedDt: string, reprint: boolean, userId: string) {
    const [j] = await sql<{ job_no: string; order_ref: string | null; tote: string | null; batch_no: string | null }[]>`
      select job_no, order_ref, tote, batch_no from production.floor_job where floor_job_id = ${jobId}`;
    const [u] = await sql<{ user_name: string | null; email: string | null }[]>`select user_name, email from iam.user_master where user_id::text = ${userId}`;
    const lots = await sql<{ batch_number: string | null; barcode: string | null }[]>`
      select rb.batch_number, lb.barcode from production.floor_line l
        left join inventory.inventory_batch ib on ib.inventory_batch_id = l.picked_batch_id
        left join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
        left join inventory.lot_barcode lb on lb.inventory_batch_id = l.picked_batch_id
       where l.floor_job_id = ${jobId} order by l.seq`;
    return {
      floorLabelId: labelId, kind, reprint, jobNo: j!.job_no, orderRef: j!.order_ref, tote: j!.tote, batchNo: j!.batch_no,
      person: u?.user_name ?? u?.email ?? userId, printedDt,
      lots: lots.map((x) => x.batch_number ?? x.barcode).filter(Boolean),
    };
  }

  /** Reprint (or a first print missed by a dead printer): REPRINT with a reason, logged. */
  async print(jobId: string, kind: LabelKind, reason: string | null, principal: AuthPrincipal) {
    if (!['PICKED', 'VERIFIED', 'MIXED'].includes(kind)) throw new BadRequestException('Labels are PICKED, VERIFIED or MIXED.');
    return this.sql.begin(async (tx) => {
      const j = await this.lockJob(tx, jobId);
      const reached = { PICKED: j.picked_dt, VERIFIED: j.verified_dt, MIXED: j.mixed_dt }[kind];
      if (!reached) throw new ConflictException(`${j.job_no} has not reached ${kind} yet.`);
      return this.printTx(tx, jobId, kind, principal, reason);
    });
  }
}
