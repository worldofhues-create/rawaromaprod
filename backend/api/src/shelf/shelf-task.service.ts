/**
 * ShelfTaskService — the physical shelves (lane produce, owner requirement + decisions 2026-09-29):
 * put-away of RELEASED finished goods to a rack, FIFO picks for the orders waiting on them, moves,
 * the printed put-away/pick sheets (rack walking order), and the counters the Shelf display shows.
 *
 *   ensurePutaway   an OPEN put-away task for a QC-released FG batch's not-yet-shelved quantity,
 *                   with a target bin assigned now (the label prints it): a bin already holding the
 *                   same SKU, else the first empty bin in walking order, else none yet. Lights the
 *                   target (blue).
 *   completePutaway at the shelf: scan/type the bin (the target, or where it actually went). Stock
 *                   lands on the bin (location.fg_bin_stock), the task is DONE, the light goes off,
 *                   and — in the same transaction — `fg.batch.received` goes to ALEMBIC so it can
 *                   allocate the batch to the orders waiting for it.
 *   createPicks     for an ALEMBIC requirement: its SKU's released stock, oldest lot first (FIFO —
 *                   manufacturing date, then put-away time), bin by bin until the requirement's kg
 *                   is covered. One PICK task per bin, lit green.
 *   completePick    the scanned bin must be the pick's bin; stock comes off it.
 *   move            stock from one bin to another, recorded as a DONE move.
 *   sheet/display   OPEN tasks in rack walking order; counters of units awaiting put-away / pick.
 *
 * Only QC-RELEASED FG may be put away or picked (the batch's COA, via package order → oil batch).
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { bridge as bridgeContracts } from '@core/contracts';
import { emitBridgeManualEvent, recordProduceAlert, type AuthPrincipal } from '@core/backend-kernel';
import { SHELF_DB, type ShelfDb, type ShelfTx } from './shelf.tokens.js';
import { ShelfLayoutService, WALK_ORDER_SQL, type BinLocation } from './shelf-layout.service.js';
import { PickLightService, colourFor, type PickLightCommand } from './pick-light.service.js';

export type FgQcState = 'RELEASED' | 'FAILED' | 'PENDING' | 'NOT_TRACEABLE';

export interface FgBatchInfo {
  id: string;
  batchNumber: string | null;
  producedQty: number;
  uomId: string | null;
  uomCode: string | null;
  productSkuId: string | null;
  skuCode: string | null;
  packSize: string | null;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  manufacturingDate: string | null;
  expiryDate: string | null;
  oilBatchId: string | null;
  productionOrderId: string | null;
  coaStatus: string | null;
  coaResult: string | null;
  releasedAt: string | null;
  qc: FgQcState;
  stocked: number;
  status: string | null;
}

export interface ShelfTaskRow {
  shelfTaskId: string;
  taskNo: string;
  kind: 'PUTAWAY' | 'PICK' | 'MOVE';
  status: string;
  finishedGoodBatchId: string;
  batchNo: string | null;
  sku: string | null;
  packSize: string | null;
  qty: number;
  uom: string | null;
  bin: string | null;
  label: string | null;
  rack: string | null;
  zone: string | null;
  walkSeq: number | null;
  alembicRequirementId: string | null;
  reference: string | null;
  priorityRank: number | null;
  createdDt: string;
  qr: string;
}

/** The task QR a sheet prints; the put-away/pick screen accepts it in the scan field. */
export const taskQr = (id: string) => `RAWTASK:${id}`;
const taskNo = (kind: string, seq: number | string) => `${kind === 'PICK' ? 'PK' : kind === 'MOVE' ? 'MV' : 'PA'}-${seq}`;
const ymd = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

/**
 * Pure: the `fg.batch.received` payload for one put-away. Returns the problems instead when it
 * cannot be sent as ALEMBIC expects (no SKU, a quantity not expressible in kg, no QC release).
 */
export function buildFgBatchReceived(input: {
  batchNo: string | null;
  sku: string | null;
  packSize: string | null;
  qty: number;
  uomCode: string | null;
  rack: string | null;
  releasedAt: string | null;
}): { ok: true; payload: bridgeContracts.FgBatchReceivedPayload } | { ok: false; problems: string[] } {
  const qtyKg = bridgeContracts.fgQtyKg(input.qty, input.uomCode, input.packSize);
  const payload: bridgeContracts.FgBatchReceivedPayload = {
    batch_no: input.batchNo ?? '',
    sku: input.sku ?? '',
    pack_size: input.packSize && input.packSize.trim() ? input.packSize.trim() : null,
    qty_kg: qtyKg ?? 0,
    rack: input.rack ?? '',
    released_at: input.releasedAt ?? '',
  };
  const problems = bridgeContracts.validateFgBatchReceived(payload);
  if (qtyKg === null) problems.push('qty_kg: the unit is not a mass and the pack size is not written as one (e.g. "25 kg")');
  if (problems.length) return { ok: false, problems: [...new Set(problems)] };
  bridgeContracts.assertNoFormulaContent(payload);
  return { ok: true, payload };
}

@Injectable()
export class ShelfTaskService {
  constructor(
    @Inject(SHELF_DB) private readonly db: ShelfDb,
    private readonly layout: ShelfLayoutService,
    private readonly lights: PickLightService,
  ) {}

  /* ── FG batch facts ──────────────────────────────────────────────────────────────────── */

  async fgBatch(id: string, tx?: ShelfTx): Promise<FgBatchInfo> {
    const q = tx ?? this.db;
    const r = ((await q.execute(sql`
      select f.finished_good_batch_id::text as id, f.batch_number, f.produced_qty::float as qty, f.uom_id::text, u.uom_code,
             f.product_sku_id::text, s.sku_code, s.pack_size, pm.product_id::text, pm.product_code, pm.product_name,
             f.manufacturing_date, f.expiry_date, f.status,
             po.oil_batch_id::text, ob.production_order_id::text, c.status as coa_status, c.overall_result, c.released_dt,
             coalesce((select sum(st.qty) from location.fg_bin_stock st where st.finished_good_batch_id = f.finished_good_batch_id), 0)::float as stocked
        from packaging.finished_good_batch_master f
        left join packaging.product_sku s on s.product_sku_id = f.product_sku_id
        left join packaging.product_master pm on pm.product_id = s.product_id
        left join platform.uom_master u on u.uom_id = f.uom_id
        left join packaging.package_order po on po.package_order_id = f.package_order_id
        left join production.oil_batch_master ob on ob.oil_batch_id = po.oil_batch_id
        left join production.batch_coa c on c.oil_batch_id = po.oil_batch_id
       where f.finished_good_batch_id = ${id}::uuid
    `)) as unknown as Array<Record<string, unknown>>)[0];
    if (!r) throw new NotFoundException(`Finished-good batch ${id} not found.`);
    const coaStatus = (r.coa_status as string | null) ?? null;
    const coaResult = (r.overall_result as string | null) ?? null;
    const qc: FgQcState = !r.oil_batch_id ? 'NOT_TRACEABLE'
      : coaStatus === 'RELEASED' ? 'RELEASED'
      : coaStatus === 'REJECTED' || coaResult === 'FAIL' ? 'FAILED' : 'PENDING';
    return {
      id: String(r.id), batchNumber: (r.batch_number as string | null) ?? null, producedQty: Number(r.qty ?? 0),
      uomId: (r.uom_id as string | null) ?? null, uomCode: (r.uom_code as string | null) ?? null,
      productSkuId: (r.product_sku_id as string | null) ?? null, skuCode: (r.sku_code as string | null) ?? null,
      packSize: (r.pack_size as string | null) ?? null, productId: (r.product_id as string | null) ?? null,
      productCode: (r.product_code as string | null) ?? null, productName: (r.product_name as string | null) ?? null,
      manufacturingDate: ymd(r.manufacturing_date), expiryDate: ymd(r.expiry_date),
      oilBatchId: (r.oil_batch_id as string | null) ?? null, productionOrderId: (r.production_order_id as string | null) ?? null,
      coaStatus, coaResult, releasedAt: r.released_dt ? new Date(r.released_dt as string).toISOString() : null,
      qc, stocked: Number(r.stocked ?? 0), status: (r.status as string | null) ?? null,
    };
  }

  /** Where the batch is (bins with stock) or is going (an open put-away's target). */
  async whereIs(fgBatchId: string, tx?: ShelfTx): Promise<{ label: string | null; assigned: boolean }> {
    const q = tx ?? this.db;
    const rows = (await q.execute(sql`
      select rk.rack_code, sh.shelf_code, bn.bin_code, 'stock' as src, st.put_away_dt as at
        from location.fg_bin_stock st
        join location.bin_master bn on bn.bin_id = st.bin_id
        left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
        left join location.rack_master rk on rk.rack_id = sh.rack_id
       where st.finished_good_batch_id = ${fgBatchId}::uuid and st.qty > 0
      union all
      select rk.rack_code, sh.shelf_code, bn.bin_code, 'task', t.created_dt
        from location.shelf_task t
        join location.bin_master bn on bn.bin_id = t.to_bin_id
        left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
        left join location.rack_master rk on rk.rack_id = sh.rack_id
       where t.finished_good_batch_id = ${fgBatchId}::uuid and t.kind = 'PUTAWAY' and t.status = 'OPEN'
      order by 4 asc, 5 asc
    `)) as unknown as Array<{ rack_code: string | null; shelf_code: string | null; bin_code: string | null; src: string }>;
    const r = rows[0];
    return r ? { label: bridgeContracts.locationLabel(r.rack_code, r.shelf_code, r.bin_code), assigned: r.src === 'task' } : { label: null, assigned: false };
  }

  /* ── put-away ────────────────────────────────────────────────────────────────────────── */

  /** Ensures an OPEN put-away task (with a target bin when one can be found). Inside `tx` if given. */
  async ensurePutaway(fgBatchId: string, principal: AuthPrincipal, opts: { binCode?: string | null } = {}, tx?: ShelfTx) {
    const run = async (t: ShelfTx) => {
      const fg = await this.fgBatch(fgBatchId, t);
      if (fg.qc !== 'RELEASED') throw new ConflictException(qcRefusal(fg, 'put away'));
      const open = ((await t.execute(sql`
        select shelf_task_id::text as id, to_bin_id::text as to_bin, qty::float as qty from location.shelf_task
         where finished_good_batch_id = ${fgBatchId}::uuid and kind = 'PUTAWAY' and status = 'OPEN'
         order by created_dt limit 1 for update
      `)) as unknown as Array<{ id: string; to_bin: string | null; qty: number }>)[0];
      const target = opts.binCode ? await this.layout.resolve(opts.binCode, t) : null;
      if (open) {
        if (target && target.binId !== open.to_bin) {
          if (open.to_bin) await this.light(t, open.id, open.to_bin, 0, 'off');
          await t.execute(sql`update location.shelf_task set to_bin_id = ${target.binId}::uuid, updated_dt = now(), updated_by = ${principal.userId}
                                where shelf_task_id = ${open.id}::uuid`);
          await this.light(t, open.id, target.binId, open.qty, colourFor('PUTAWAY'));
        }
        return this.task(open.id, t);
      }
      const remaining = round4(fg.producedQty - fg.stocked);
      if (!(remaining > 0)) throw new ConflictException(`Batch ${fg.batchNumber ?? fgBatchId} is already on the shelves.`);
      const binId = target?.binId ?? (await this.suggestBin(t, fg.productSkuId));
      const created = ((await t.execute(sql`
        insert into location.shelf_task (kind, finished_good_batch_id, product_sku_id, qty, uom_id, to_bin_id, status, created_by, updated_by)
        values ('PUTAWAY', ${fgBatchId}::uuid, ${fg.productSkuId}::uuid, ${remaining}, ${fg.uomId}::uuid, ${binId}::uuid, 'OPEN', ${principal.userId}, ${principal.userId})
        returning shelf_task_id::text as id
      `)) as unknown as Array<{ id: string }>)[0]!;
      if (binId) await this.light(t, created.id, binId, remaining, colourFor('PUTAWAY'));
      return this.task(created.id, t);
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  /** Same SKU's bin first (keep a SKU together), else the first empty bin in walking order. */
  private async suggestBin(tx: ShelfTx, productSkuId: string | null): Promise<string | null> {
    if (productSkuId) {
      const same = ((await tx.execute(sql`
        select bn.bin_id::text as id
          from location.fg_bin_stock st
          join packaging.finished_good_batch_master f on f.finished_good_batch_id = st.finished_good_batch_id
          join location.bin_master bn on bn.bin_id = st.bin_id
          left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
          left join location.rack_master rk on rk.rack_id = sh.rack_id
          left join location.rack_walk_order wo on wo.rack_id = rk.rack_id
         where f.product_sku_id = ${productSkuId}::uuid and st.qty > 0 and (bn.status is null or bn.status = 'ACTIVE')
         order by ${WALK_ORDER_SQL} limit 1
      `)) as unknown as Array<{ id: string }>)[0];
      if (same) return same.id;
    }
    const empty = ((await tx.execute(sql`
      select bn.bin_id::text as id
        from location.bin_master bn
        left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
        left join location.rack_master rk on rk.rack_id = sh.rack_id
        left join location.rack_walk_order wo on wo.rack_id = rk.rack_id
       where (bn.status is null or bn.status = 'ACTIVE')
         and not exists (select 1 from location.fg_bin_stock st where st.bin_id = bn.bin_id and st.qty > 0)
         and not exists (select 1 from location.shelf_task t where t.to_bin_id = bn.bin_id and t.status = 'OPEN')
       order by ${WALK_ORDER_SQL} limit 1
    `)) as unknown as Array<{ id: string }>)[0];
    return empty?.id ?? null;
  }

  async completePutaway(taskId: string, binCode: string, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const t = ((await tx.execute(sql`
        select shelf_task_id::text as id, kind, status, finished_good_batch_id::text as fg, qty::float as qty,
               uom_id::text as uom, to_bin_id::text as to_bin
          from location.shelf_task where shelf_task_id = ${taskId}::uuid for update
      `)) as unknown as Array<{ id: string; kind: string; status: string; fg: string; qty: number; uom: string | null; to_bin: string | null }>)[0];
      if (!t) throw new NotFoundException(`Task ${taskId} not found.`);
      if (t.kind !== 'PUTAWAY') throw new BadRequestException('That is not a put-away task.');
      if (t.status !== 'OPEN') throw new ConflictException(`This put-away is already ${t.status.toLowerCase()}.`);
      const bin = await this.layout.resolve(binCode, tx);
      const fg = await this.fgBatch(t.fg, tx);
      if (fg.qc !== 'RELEASED') throw new ConflictException(qcRefusal(fg, 'put away'));

      await tx.execute(sql`
        insert into location.fg_bin_stock (finished_good_batch_id, bin_id, qty, uom_id, put_away_dt, status, created_by, updated_by)
        values (${t.fg}::uuid, ${bin.binId}::uuid, ${t.qty}, ${t.uom}::uuid, now(), 'ACTIVE', ${principal.userId}, ${principal.userId})
        on conflict (finished_good_batch_id, bin_id) do update
          set qty = location.fg_bin_stock.qty + excluded.qty, put_away_dt = now(), updated_dt = now(), updated_by = excluded.updated_by
      `);
      await tx.execute(sql`
        update location.shelf_task set status = 'DONE', to_bin_id = ${bin.binId}::uuid, completed_by = ${principal.userId}::uuid,
               completed_dt = now(), updated_dt = now(), updated_by = ${principal.userId}
         where shelf_task_id = ${taskId}::uuid
      `);
      if (t.to_bin) await this.light(tx, taskId, t.to_bin, 0, 'off');
      if (t.to_bin !== bin.binId) await this.light(tx, taskId, bin.binId, 0, 'off');

      const sent = await this.emitReceived(tx, fg, t.qty, bin);
      return { task: await this.task(taskId, tx), location: bin.label, fgBatchReceived: sent };
    });
  }

  /**
   * `fg.batch.received` for one put-away, in the caller's transaction. The envelope's
   * correlation id / org are the journey of the ALEMBIC requirement the batch's run serves (if
   * any). When the fact cannot be expressed as ALEMBIC expects, nothing is sent and the
   * production/warehouse consoles get an alert saying why.
   */
  private async emitReceived(tx: ShelfTx, fg: FgBatchInfo, qty: number, bin: BinLocation) {
    const built = buildFgBatchReceived({
      batchNo: fg.batchNumber, sku: fg.skuCode, packSize: fg.packSize, qty, uomCode: fg.uomCode,
      rack: bin.label, releasedAt: fg.releasedAt,
    });
    if (!built.ok) {
      await recordProduceAlert(tx, {
        kind: 'fg_received_not_sent', severity: 'med',
        title: `Put away, but ALEMBIC was not told: batch ${fg.batchNumber ?? fg.id}`,
        detail: `fg.batch.received needs ${built.problems.join('; ')}.`,
        roles: ['warehouse', 'production', 'packaging'], refType: 'fg_batch', refId: fg.id,
        dedupeKey: `fg_received_not_sent:${fg.id}:${bin.binId}`,
      });
      return { sent: false as const, problems: built.problems };
    }
    const journey = fg.productionOrderId
      ? ((await tx.execute(sql`
          select correlation_id::text, org_id::text from bridge.production_requirement
           where production_order_id = ${fg.productionOrderId}::uuid
           order by priority_rank nulls last, needed_by, created_dt limit 1
        `)) as unknown as Array<{ correlation_id: string; org_id: string }>)[0]
      : undefined;
    await emitBridgeManualEvent(tx, bridgeContracts.FG_BATCH_RECEIVED, fg.id, {
      ...built.payload,
      ...(journey ? { _correlation_id: journey.correlation_id, _org_id: journey.org_id } : {}),
    });
    return { sent: true as const, payload: built.payload };
  }

  /* ── picks ───────────────────────────────────────────────────────────────────────────── */

  /** FIFO pick tasks covering an ALEMBIC requirement's still-unpicked kilograms. */
  async createPicks(alembicRequirementId: string, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const req = ((await tx.execute(sql`
        select alembic_requirement_id::text as id, mapped_sku, qty::float as qty, uom, qty_kg::float as qty_kg,
               priority_rank, order_ref, lifecycle_status
          from bridge.production_requirement where alembic_requirement_id = ${alembicRequirementId}::uuid for update
      `)) as unknown as Array<{ id: string; mapped_sku: string; qty: number; uom: string; qty_kg: number | null; priority_rank: number | null; order_ref: string; lifecycle_status: string }>)[0];
      if (!req) throw new NotFoundException(`No ALEMBIC requirement ${alembicRequirementId}.`);
      if (req.lifecycle_status !== 'ACCEPTED') throw new ConflictException(`This requirement is ${req.lifecycle_status}; nothing to pick.`);
      const needKg = req.qty_kg ?? (bridgeContracts.kgPerUnit(req.uom) !== null ? req.qty * bridgeContracts.kgPerUnit(req.uom)! : null);
      if (needKg === null) throw new ConflictException('The requirement quantity is not in a unit of mass, so a pick cannot be sized.');
      const already = ((await tx.execute(sql`
        select t.qty::float as qty, u.uom_code, s.pack_size
          from location.shelf_task t
          left join platform.uom_master u on u.uom_id = t.uom_id
          left join packaging.product_sku s on s.product_sku_id = t.product_sku_id
         where t.alembic_requirement_id = ${req.id}::uuid and t.kind = 'PICK' and t.status in ('OPEN', 'DONE')
      `)) as unknown as Array<{ qty: number; uom_code: string | null; pack_size: string | null }>)
        .reduce((s, r) => s + (bridgeContracts.fgQtyKg(r.qty, r.uom_code, r.pack_size) ?? 0), 0);
      let remainingKg = round4(needKg - already);
      if (!(remainingKg > 0)) throw new ConflictException('This requirement is already fully picked (or has open picks covering it).');

      const stock = (await tx.execute(sql`
        select st.fg_bin_stock_id::text as stock_id, st.finished_good_batch_id::text as fg, st.bin_id::text as bin,
               (st.qty - coalesce((select sum(p.qty) from location.shelf_task p
                                    where p.kind = 'PICK' and p.status = 'OPEN'
                                      and p.finished_good_batch_id = st.finished_good_batch_id and p.from_bin_id = st.bin_id), 0))::float as free,
               st.uom_id::text as uom, u.uom_code, s.pack_size, s.product_sku_id::text as sku_id
          from location.fg_bin_stock st
          join packaging.finished_good_batch_master f on f.finished_good_batch_id = st.finished_good_batch_id
          join packaging.product_sku s on s.product_sku_id = f.product_sku_id
          left join platform.uom_master u on u.uom_id = st.uom_id
          join packaging.package_order po on po.package_order_id = f.package_order_id
          join production.batch_coa c on c.oil_batch_id = po.oil_batch_id and c.status = 'RELEASED'
          join location.bin_master bn on bn.bin_id = st.bin_id
          left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
          left join location.rack_master rk on rk.rack_id = sh.rack_id
          left join location.rack_walk_order wo on wo.rack_id = rk.rack_id
         where s.sku_code = ${req.mapped_sku} and st.qty > 0
         order by f.manufacturing_date asc nulls last, st.put_away_dt asc, ${WALK_ORDER_SQL}
         for update of st
      `)) as unknown as Array<{ stock_id: string; fg: string; bin: string; free: number; uom: string | null; uom_code: string | null; pack_size: string | null; sku_id: string }>;

      const created: string[] = [];
      for (const s of stock) {
        if (!(remainingKg > 0)) break;
        if (!(s.free > 0)) continue;
        const perUnitKg = bridgeContracts.fgQtyKg(1, s.uom_code, s.pack_size);
        if (perUnitKg === null) continue;
        const massUnit = bridgeContracts.kgPerUnit(s.uom_code) !== null;
        const unitsNeeded = massUnit ? remainingKg / perUnitKg : Math.ceil(remainingKg / perUnitKg - 1e-9);
        const take = round4(Math.min(s.free, unitsNeeded));
        if (!(take > 0)) continue;
        const row = ((await tx.execute(sql`
          insert into location.shelf_task (kind, finished_good_batch_id, product_sku_id, qty, uom_id, from_bin_id,
                                           alembic_requirement_id, reference, priority_rank, status, created_by, updated_by)
          values ('PICK', ${s.fg}::uuid, ${s.sku_id}::uuid, ${take}, ${s.uom}::uuid, ${s.bin}::uuid,
                  ${req.id}::uuid, ${req.order_ref}, ${req.priority_rank}, 'OPEN', ${principal.userId}, ${principal.userId})
          returning shelf_task_id::text as id
        `)) as unknown as Array<{ id: string }>)[0]!;
        await this.light(tx, row.id, s.bin, take, colourFor('PICK'));
        created.push(row.id);
        remainingKg = round4(remainingKg - take * perUnitKg);
      }
      if (created.length === 0) {
        throw new ConflictException(`No QC-released stock of ${req.mapped_sku} is free on the shelves yet.`);
      }
      const tasks = [];
      for (const id of created) tasks.push(await this.task(id, tx));
      return { tasks, shortKg: remainingKg > 0 ? remainingKg : 0 };
    });
  }

  /**
   * ALEMBIC requirements whose SKU has QC-released stock on the shelves and that are not fully
   * picked yet — the warehouse's "what to pick" list, in the queue's order (rank, need-by, arrival).
   */
  async pickable() {
    const rows = (await this.db.execute(sql`
      select r.alembic_requirement_id::text as id, r.order_ref, r.order_refs, r.mapped_sku, r.pack_size,
             r.qty::float as qty, r.uom, r.qty_kg::float as qty_kg, r.needed_by, r.priority_rank, r.priority_reason,
             r.order_value_inr::float as order_value_inr,
             (select coalesce(sum(st.qty), 0) from location.fg_bin_stock st
                join packaging.finished_good_batch_master f on f.finished_good_batch_id = st.finished_good_batch_id
                join packaging.product_sku s on s.product_sku_id = f.product_sku_id
                join packaging.package_order po on po.package_order_id = f.package_order_id
                join production.batch_coa c on c.oil_batch_id = po.oil_batch_id and c.status = 'RELEASED'
               where s.sku_code = r.mapped_sku)::float as on_shelf_units
        from bridge.production_requirement r
       where r.lifecycle_status = 'ACCEPTED'
       order by r.priority_rank asc nulls last, r.needed_by asc, r.created_dt asc
       limit 300
    `)) as unknown as Array<Record<string, unknown>>;
    const out = [];
    for (const r of rows) {
      if (!(Number(r.on_shelf_units) > 0)) continue;
      const picks = (await this.db.execute(sql`
        select t.status, t.qty::float as qty, u.uom_code, s.pack_size
          from location.shelf_task t
          left join platform.uom_master u on u.uom_id = t.uom_id
          left join packaging.product_sku s on s.product_sku_id = t.product_sku_id
         where t.alembic_requirement_id = ${String(r.id)}::uuid and t.kind = 'PICK' and t.status in ('OPEN', 'DONE')
      `)) as unknown as Array<{ status: string; qty: number; uom_code: string | null; pack_size: string | null }>;
      const kgOf = (st: string) => round4(picks.filter((p) => p.status === st).reduce((a, p) => a + (bridgeContracts.fgQtyKg(p.qty, p.uom_code, p.pack_size) ?? 0), 0));
      const perUom = bridgeContracts.kgPerUnit(String(r.uom));
      const needKg = r.qty_kg !== null ? Number(r.qty_kg) : perUom !== null ? round4(Number(r.qty) * perUom) : null;
      const pickedKg = kgOf('DONE');
      const openKg = kgOf('OPEN');
      if (needKg !== null && pickedKg + openKg >= needKg) continue;
      out.push({
        alembicRequirementId: String(r.id), orderRef: r.order_ref, orderRefs: Array.isArray(r.order_refs) ? r.order_refs : [r.order_ref],
        sku: r.mapped_sku, packSize: r.pack_size, qtyKg: needKg, pickedKg, openPickKg: openKg,
        neededBy: r.needed_by instanceof Date ? r.needed_by.toISOString() : String(r.needed_by),
        priorityRank: r.priority_rank, highValue: bridgeContracts.isHighValue(r.priority_reason as string | null, r.order_value_inr as number | null),
      });
    }
    return out;
  }

  /** A pick of one batch from one bin (manual — e.g. a sample or a non-ALEMBIC dispatch). */
  async createPick(body: { finishedGoodBatchId: string; binCode?: string | null; qty: number; reference?: string | null }, principal: AuthPrincipal) {
    const qty = Number(body.qty);
    if (!(qty > 0)) throw new BadRequestException('Quantity must be more than 0.');
    return this.db.transaction(async (tx) => {
      const fg = await this.fgBatch(body.finishedGoodBatchId, tx);
      if (fg.qc !== 'RELEASED') throw new ConflictException(qcRefusal(fg, 'pick'));
      const bin = body.binCode ? await this.layout.resolve(body.binCode, tx) : null;
      const stock = ((await tx.execute(sql`
        select bin_id::text as bin, qty::float as qty from location.fg_bin_stock
         where finished_good_batch_id = ${fg.id}::uuid and qty > 0 and (${bin?.binId ?? null}::uuid is null or bin_id = ${bin?.binId ?? null}::uuid)
         order by put_away_dt limit 1 for update
      `)) as unknown as Array<{ bin: string; qty: number }>)[0];
      if (!stock) throw new ConflictException(`Batch ${fg.batchNumber ?? fg.id} is not on ${bin ? `bin ${bin.label}` : 'any shelf'}.`);
      if (qty > stock.qty) throw new ConflictException(`Only ${stock.qty} on that bin.`);
      const row = ((await tx.execute(sql`
        insert into location.shelf_task (kind, finished_good_batch_id, product_sku_id, qty, uom_id, from_bin_id, reference, status, created_by, updated_by)
        values ('PICK', ${fg.id}::uuid, ${fg.productSkuId}::uuid, ${qty}, ${fg.uomId}::uuid, ${stock.bin}::uuid, ${body.reference ?? null}, 'OPEN', ${principal.userId}, ${principal.userId})
        returning shelf_task_id::text as id
      `)) as unknown as Array<{ id: string }>)[0]!;
      await this.light(tx, row.id, stock.bin, qty, colourFor('PICK'));
      return this.task(row.id, tx);
    });
  }

  async completePick(taskId: string, binCode: string, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const t = ((await tx.execute(sql`
        select shelf_task_id::text as id, kind, status, finished_good_batch_id::text as fg, qty::float as qty, from_bin_id::text as from_bin
          from location.shelf_task where shelf_task_id = ${taskId}::uuid for update
      `)) as unknown as Array<{ id: string; kind: string; status: string; fg: string; qty: number; from_bin: string }>)[0];
      if (!t) throw new NotFoundException(`Task ${taskId} not found.`);
      if (t.kind !== 'PICK') throw new BadRequestException('That is not a pick task.');
      if (t.status !== 'OPEN') throw new ConflictException(`This pick is already ${t.status.toLowerCase()}.`);
      const bin = await this.layout.resolve(binCode, tx);
      if (bin.binId !== t.from_bin) {
        const want = await this.binLabel(tx, t.from_bin);
        throw new ConflictException(`Wrong bin: this pick is from ${want}.`);
      }
      const dec = (await tx.execute(sql`
        update location.fg_bin_stock set qty = qty - ${t.qty}, updated_dt = now(), updated_by = ${principal.userId}
         where finished_good_batch_id = ${t.fg}::uuid and bin_id = ${t.from_bin}::uuid and qty >= ${t.qty}
        returning qty
      `)) as unknown as unknown[];
      if (dec.length === 0) throw new ConflictException('There is less on the bin than this pick needs — count the bin and adjust first.');
      await tx.execute(sql`
        update location.shelf_task set status = 'DONE', completed_by = ${principal.userId}::uuid, completed_dt = now(),
               updated_dt = now(), updated_by = ${principal.userId}
         where shelf_task_id = ${taskId}::uuid
      `);
      await this.light(tx, taskId, t.from_bin, 0, 'off');
      return { task: await this.task(taskId, tx) };
    });
  }

  /* ── move / cancel ───────────────────────────────────────────────────────────────────── */

  async move(body: { finishedGoodBatchId: string; fromBinCode: string; toBinCode: string; qty?: number | null }, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const from = await this.layout.resolve(body.fromBinCode, tx);
      const to = await this.layout.resolve(body.toBinCode, tx);
      if (from.binId === to.binId) throw new BadRequestException('The two bins are the same.');
      const stock = ((await tx.execute(sql`
        select qty::float as qty, uom_id::text as uom from location.fg_bin_stock
         where finished_good_batch_id = ${body.finishedGoodBatchId}::uuid and bin_id = ${from.binId}::uuid for update
      `)) as unknown as Array<{ qty: number; uom: string | null }>)[0];
      if (!stock || !(stock.qty > 0)) throw new ConflictException(`That batch is not on ${from.label}.`);
      const qty = body.qty === undefined || body.qty === null ? stock.qty : Number(body.qty);
      if (!(qty > 0) || qty > stock.qty) throw new BadRequestException(`Move between 0 and ${stock.qty}.`);
      const fg = await this.fgBatch(body.finishedGoodBatchId, tx);
      await tx.execute(sql`update location.fg_bin_stock set qty = qty - ${qty}, updated_dt = now(), updated_by = ${principal.userId}
                             where finished_good_batch_id = ${fg.id}::uuid and bin_id = ${from.binId}::uuid`);
      await tx.execute(sql`
        insert into location.fg_bin_stock (finished_good_batch_id, bin_id, qty, uom_id, put_away_dt, status, created_by, updated_by)
        values (${fg.id}::uuid, ${to.binId}::uuid, ${qty}, ${stock.uom}::uuid, now(), 'ACTIVE', ${principal.userId}, ${principal.userId})
        on conflict (finished_good_batch_id, bin_id) do update set qty = location.fg_bin_stock.qty + excluded.qty, updated_dt = now()
      `);
      const row = ((await tx.execute(sql`
        insert into location.shelf_task (kind, finished_good_batch_id, product_sku_id, qty, uom_id, from_bin_id, to_bin_id, status,
                                         completed_by, completed_dt, created_by, updated_by)
        values ('MOVE', ${fg.id}::uuid, ${fg.productSkuId}::uuid, ${qty}, ${stock.uom}::uuid, ${from.binId}::uuid, ${to.binId}::uuid, 'DONE',
                ${principal.userId}::uuid, now(), ${principal.userId}, ${principal.userId})
        returning shelf_task_id::text as id
      `)) as unknown as Array<{ id: string }>)[0]!;
      return { task: await this.task(row.id, tx), from: from.label, to: to.label };
    });
  }

  async cancel(taskId: string, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const t = ((await tx.execute(sql`
        select kind, status, to_bin_id::text as to_bin, from_bin_id::text as from_bin from location.shelf_task
         where shelf_task_id = ${taskId}::uuid for update
      `)) as unknown as Array<{ kind: string; status: string; to_bin: string | null; from_bin: string | null }>)[0];
      if (!t) throw new NotFoundException(`Task ${taskId} not found.`);
      if (t.status !== 'OPEN') throw new ConflictException(`This task is already ${t.status.toLowerCase()}.`);
      await tx.execute(sql`update location.shelf_task set status = 'CANCELLED', updated_dt = now(), updated_by = ${principal.userId}
                             where shelf_task_id = ${taskId}::uuid`);
      const lit = t.kind === 'PICK' ? t.from_bin : t.to_bin;
      if (lit) await this.light(tx, taskId, lit, 0, 'off');
      return this.task(taskId, tx);
    });
  }

  /* ── lists, sheets, the shelf display ────────────────────────────────────────────────── */

  /** What is on one bin (scanned or typed code): each FG batch and its quantity. */
  async binStock(code: string) {
    const bin = await this.layout.resolve(code);
    const items = (await this.db.execute(sql`
      select st.finished_good_batch_id::text as "finishedGoodBatchId", f.batch_number as "batchNo", s.sku_code as sku,
             s.pack_size as "packSize", st.qty::float as qty, u.uom_code as uom, f.manufacturing_date as "manufacturingDate"
        from location.fg_bin_stock st
        join packaging.finished_good_batch_master f on f.finished_good_batch_id = st.finished_good_batch_id
        left join packaging.product_sku s on s.product_sku_id = f.product_sku_id
        left join platform.uom_master u on u.uom_id = st.uom_id
       where st.bin_id = ${bin.binId}::uuid and st.qty > 0
       order by f.manufacturing_date asc nulls last, st.put_away_dt asc
    `)) as unknown as Array<Record<string, unknown>>;
    return { bin, items };
  }

  /** QC-released FG batches not (fully) on a shelf yet — the "ready for put-away" list. */
  async readyForPutaway(limit = 200) {
    const rows = (await this.db.execute(sql`
      select f.finished_good_batch_id::text as "finishedGoodBatchId", f.batch_number as "batchNo", s.sku_code as sku,
             s.pack_size as "packSize", f.produced_qty::float as "producedQty", u.uom_code as uom,
             coalesce(st.qty, 0)::float as "stockedQty", f.manufacturing_date as "manufacturingDate",
             c.released_dt as "releasedAt",
             (select t.shelf_task_id::text from location.shelf_task t
               where t.finished_good_batch_id = f.finished_good_batch_id and t.kind = 'PUTAWAY' and t.status = 'OPEN' limit 1) as "openTaskId"
        from packaging.finished_good_batch_master f
        join packaging.package_order po on po.package_order_id = f.package_order_id
        join production.batch_coa c on c.oil_batch_id = po.oil_batch_id and c.status = 'RELEASED'
        left join packaging.product_sku s on s.product_sku_id = f.product_sku_id
        left join platform.uom_master u on u.uom_id = f.uom_id
        left join (select finished_good_batch_id, sum(qty) as qty from location.fg_bin_stock group by 1) st
               on st.finished_good_batch_id = f.finished_good_batch_id
       where coalesce(st.qty, 0) < coalesce(f.produced_qty, 0)
       order by f.manufacturing_date asc nulls last, c.released_dt asc
       limit ${Math.min(Math.max(Math.trunc(limit) || 200, 1), 500)}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows;
  }

  async tasks(opts: { status?: string | null; kind?: string | null; zone?: string | null; rack?: string | null; limit?: number } = {}): Promise<ShelfTaskRow[]> {
    const status = opts.status ? String(opts.status).toUpperCase() : 'OPEN';
    const kind = opts.kind ? String(opts.kind).toUpperCase() : null;
    const lim = Math.min(Math.max(Math.trunc(opts.limit ?? 500) || 500, 1), 2000);
    const rows = (await this.db.execute(sql`
      select t.shelf_task_id::text as id, t.seq, t.kind, t.status, t.finished_good_batch_id::text as fg, f.batch_number,
             s.sku_code, s.pack_size, t.qty::float as qty, u.uom_code, bn.bin_code, sh.shelf_code, rk.rack_code, zn.zone_code,
             wo.walk_seq, t.alembic_requirement_id::text as req, t.reference, t.priority_rank, t.created_dt
        from location.shelf_task t
        left join packaging.finished_good_batch_master f on f.finished_good_batch_id = t.finished_good_batch_id
        left join packaging.product_sku s on s.product_sku_id = t.product_sku_id
        left join platform.uom_master u on u.uom_id = t.uom_id
        left join location.bin_master bn on bn.bin_id = case when t.kind = 'PICK' then t.from_bin_id else t.to_bin_id end
        left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
        left join location.rack_master rk on rk.rack_id = sh.rack_id
        left join location.zone_master zn on zn.zone_id = rk.zone_id
        left join location.rack_walk_order wo on wo.rack_id = rk.rack_id
       where t.status = ${status}
         and (${kind}::text is null or t.kind = ${kind}::text)
         and (${opts.zone ?? null}::text is null or lower(zn.zone_code) = lower(${opts.zone ?? null}::text))
         and (${opts.rack ?? null}::text is null or lower(rk.rack_code) = lower(${opts.rack ?? null}::text))
       order by ${WALK_ORDER_SQL}, t.priority_rank nulls last, t.seq
       limit ${lim}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map(toTaskRow);
  }

  /** The printable put-away / pick sheet: OPEN tasks in walking order, each with its QR text. */
  async sheet(kind: 'PUTAWAY' | 'PICK', zone?: string | null) {
    const items = await this.tasks({ status: 'OPEN', kind, zone });
    return { kind, zone: zone ?? null, generatedAt: new Date().toISOString(), items };
  }

  /** The Shelf display: counters at the shelves, the next items (walking order) and the lit bins. */
  async display(zone?: string | null, rack?: string | null) {
    const open = await this.tasks({ status: 'OPEN', zone, rack, limit: 2000 });
    const putaway = open.filter((t) => t.kind === 'PUTAWAY');
    const pick = open.filter((t) => t.kind === 'PICK');
    const unitsOf = (ts: ShelfTaskRow[]) => round4(ts.reduce((s, t) => s + t.qty, 0));
    const racks = [...new Set(open.map((t) => t.rack).filter((r): r is string => !!r))];
    let rackCodes: string[] | undefined;
    if (zone || rack) {
      rackCodes = ((await this.db.execute(sql`
        select rk.rack_code from location.rack_master rk left join location.zone_master zn on zn.zone_id = rk.zone_id
         where (${zone ?? null}::text is null or lower(zn.zone_code) = lower(${zone ?? null}::text))
           and (${rack ?? null}::text is null or lower(rk.rack_code) = lower(${rack ?? null}::text))
      `)) as unknown as Array<{ rack_code: string }>).map((r) => r.rack_code);
    }
    const unassigned = putaway.filter((t) => !t.bin).length;
    return {
      zone: zone ?? null, rack: rack ?? null, at: new Date().toISOString(),
      counters: {
        putawayTasks: putaway.length, putawayUnits: unitsOf(putaway),
        pickTasks: pick.length, pickUnits: unitsOf(pick),
        unassignedPutaways: unassigned, racksWithWork: racks.length,
      },
      next: open.slice(0, 12),
      lit: await this.lights.simulatorState(rackCodes),
    };
  }

  async task(id: string, tx?: ShelfTx): Promise<ShelfTaskRow> {
    const q = tx ?? this.db;
    const r = ((await q.execute(sql`
      select t.shelf_task_id::text as id, t.seq, t.kind, t.status, t.finished_good_batch_id::text as fg, f.batch_number,
             s.sku_code, s.pack_size, t.qty::float as qty, u.uom_code, bn.bin_code, sh.shelf_code, rk.rack_code, zn.zone_code,
             wo.walk_seq, t.alembic_requirement_id::text as req, t.reference, t.priority_rank, t.created_dt
        from location.shelf_task t
        left join packaging.finished_good_batch_master f on f.finished_good_batch_id = t.finished_good_batch_id
        left join packaging.product_sku s on s.product_sku_id = t.product_sku_id
        left join platform.uom_master u on u.uom_id = t.uom_id
        left join location.bin_master bn on bn.bin_id = case when t.kind = 'PICK' then t.from_bin_id else t.to_bin_id end
        left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
        left join location.rack_master rk on rk.rack_id = sh.rack_id
        left join location.zone_master zn on zn.zone_id = rk.zone_id
        left join location.rack_walk_order wo on wo.rack_id = rk.rack_id
       where t.shelf_task_id = ${id}::uuid
    `)) as unknown as Array<Record<string, unknown>>)[0];
    if (!r) throw new NotFoundException(`Task ${id} not found.`);
    return toTaskRow(r);
  }

  /** Resolves a scanned task QR (`RAWTASK:<id>`) or a task number (`PA-12`) to its task. */
  async findByScan(code: string): Promise<ShelfTaskRow> {
    const c = String(code ?? '').trim();
    const qr = c.match(/^RAWTASK:([0-9a-f-]{36})$/i);
    if (qr) return this.task(qr[1]!);
    const no = c.match(/^(PA|PK|MV)-(\d{1,12})$/i);
    if (!no) throw new BadRequestException('Scan a task QR or type a task number like PA-12.');
    const r = ((await this.db.execute(sql`select shelf_task_id::text as id from location.shelf_task where seq = ${Number(no[2])}`)) as unknown as Array<{ id: string }>)[0];
    if (!r) throw new NotFoundException(`No task ${c}.`);
    return this.task(r.id);
  }

  private async light(tx: ShelfTx, taskId: string, binId: string, qty: number, colour: PickLightCommand['colour']) {
    const b = ((await tx.execute(sql`
      select rk.rack_code, sh.shelf_code, bn.bin_code from location.bin_master bn
        left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
        left join location.rack_master rk on rk.rack_id = sh.rack_id
       where bn.bin_id = ${binId}::uuid
    `)) as unknown as Array<{ rack_code: string | null; shelf_code: string | null; bin_code: string | null }>)[0];
    if (!b) return;
    await this.lights.enqueue(tx, {
      task_id: taskId, rack: b.rack_code ?? b.bin_code ?? '?', shelf: b.shelf_code, bin: b.bin_code, qty: colour === 'off' ? 0 : qty, colour,
    });
  }

  private async binLabel(tx: ShelfTx, binId: string): Promise<string> {
    const b = ((await tx.execute(sql`
      select rk.rack_code, sh.shelf_code, bn.bin_code from location.bin_master bn
        left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
        left join location.rack_master rk on rk.rack_id = sh.rack_id
       where bn.bin_id = ${binId}::uuid
    `)) as unknown as Array<{ rack_code: string | null; shelf_code: string | null; bin_code: string | null }>)[0];
    return b ? bridgeContracts.locationLabel(b.rack_code, b.shelf_code, b.bin_code) ?? '?' : '?';
  }
}

function toTaskRow(r: Record<string, unknown>): ShelfTaskRow {
  const kind = String(r.kind) as ShelfTaskRow['kind'];
  const label = bridgeContracts.locationLabel(r.rack_code as string | null, r.shelf_code as string | null, r.bin_code as string | null);
  return {
    shelfTaskId: String(r.id), taskNo: taskNo(kind, r.seq as number), kind, status: String(r.status),
    finishedGoodBatchId: String(r.fg), batchNo: (r.batch_number as string | null) ?? null,
    sku: (r.sku_code as string | null) ?? null, packSize: (r.pack_size as string | null) ?? null,
    qty: Number(r.qty), uom: (r.uom_code as string | null) ?? null,
    bin: (r.bin_code as string | null) ?? null, label, rack: (r.rack_code as string | null) ?? null,
    zone: (r.zone_code as string | null) ?? null, walkSeq: (r.walk_seq as number | null) ?? null,
    alembicRequirementId: (r.req as string | null) ?? null, reference: (r.reference as string | null) ?? null,
    priorityRank: (r.priority_rank as number | null) ?? null,
    createdDt: r.created_dt instanceof Date ? r.created_dt.toISOString() : String(r.created_dt),
    qr: taskQr(String(r.id)),
  };
}

/** Why a batch cannot be put away / picked / labelled, in the floor's words. */
export function qcRefusal(fg: Pick<FgBatchInfo, 'qc' | 'batchNumber' | 'id'>, verb: string): string {
  const b = fg.batchNumber ?? fg.id;
  if (fg.qc === 'FAILED') return `Batch ${b} failed QC — it cannot be ${verb === 'label' ? 'labelled' : verb === 'pick' ? 'picked' : 'put away'}.`;
  if (fg.qc === 'NOT_TRACEABLE') return `Batch ${b} is not linked to a compounded (oil) batch, so its QC certificate cannot be checked.`;
  return `Batch ${b} has not been released by QC yet — release its certificate of analysis first.`;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
