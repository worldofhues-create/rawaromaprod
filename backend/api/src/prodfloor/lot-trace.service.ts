/**
 * PROD-B-7 — lot hold, the recall review, and the raw-lot label at putaway (plan 4, 7).
 *
 *   hold      inventory.lot_hold: one active hold per subject. A held raw lot cannot be issued
 *             (PickingService refuses it) and gets no putaway label.
 *   recall    from a raw lot: every oil batch that used it (material issue -> production order, and
 *             the genealogy rows, reworks included), every finished-good batch made from those, and
 *             every SHIPPED order (dispatch) that carried one. Batch and order numbers only: no
 *             material identity leaves here.
 *   label     the putaway label: opaque lot id (the RM batch number), floor code, quantity, expiry,
 *             bin. The hazard line prints only from sourced data; raw materials hold none here, so
 *             it says "Classification pending: handle as hazardous". The first print is logged, every
 *             later one is marked REPRINT.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { scanCode } from '../floor/scan-code.js';
import { FloorCodeService, LOT_BARCODE_RE } from '../floor/floor-code.service.js';
import { PrintService } from '../floor-ops/print.service.js';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HAZARD_PENDING = 'Classification pending: handle as hazardous';

export async function holdSubject(tx: TransactionSql | Sql, type: 'RM_LOT' | 'OIL_BATCH', id: string, reason: string, source: string, by: string) {
  await tx`insert into inventory.lot_hold (subject_type, subject_id, reason, source, held_by) values (${type}, ${id}, ${reason}, ${source}, ${by})
           on conflict (subject_type, subject_id) where released_dt is null do nothing`;
}

/** True when this inventory lot's raw lot is on hold (used by PickingService). */
export async function isLotHeld(run: (q: string, p: unknown[]) => Promise<Row[]>, inventoryBatchId: string): Promise<boolean> {
  return (await run(`select 1 from inventory.inventory_batch ib join inventory.lot_hold h on h.subject_type = 'RM_LOT' and h.subject_id = ib.rm_batch_id and h.released_dt is null
                      where ib.inventory_batch_id = $1`, [inventoryBatchId])).length > 0;
}

/** A raw lot by its id or by its lot number (any case): WALK2-RP-11. Batch QC uses it too (RP-13). */
export async function resolveRmLot(sql: Sql, ref: unknown): Promise<string> {
  const v = scanCode(ref); // SCAN-3
  if (!v) throw new BadRequestException('Scan or type the raw lot number.');
  // SCAN-5: the raw-lot label's code is the opaque L- id; it names the RM lot through its stock row.
  const rows = LOT_BARCODE_RE.test(v.toUpperCase())
    ? await sql`select ib.rm_batch_id::text as id from inventory.lot_barcode lb join inventory.inventory_batch ib on ib.inventory_batch_id = lb.inventory_batch_id
                 where lb.barcode = ${v.toUpperCase()} and ib.rm_batch_id is not null`
    : UUID.test(v)
    ? await sql`select rm_batch_id::text as id from inventory.rm_batch_master where rm_batch_id = ${v}::uuid`
    : await sql`select rm_batch_id::text as id from inventory.rm_batch_master where upper(batch_number) = upper(${v}) limit 2`;
  if (!rows.length) throw new NotFoundException(`No raw lot ${v} on file.`);
  if (rows.length > 1) throw new ConflictException(`More than one raw lot is numbered ${v}; open it from Stock instead.`);
  return String(rows[0]!.id);
}

@Injectable()
export class LotTraceService {
  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    @Optional() private readonly codes?: FloorCodeService,
    @Optional() private readonly print?: PrintService,
  ) {}

  /** WALK2-RP-11: Lot hold & recall asked for a typed rm_batch_id uuid, and anything else (the lot number
   *  on the label in someone's hand) reached Postgres as a uuid and failed as a server error. A raw lot is
   *  found by its id or by its lot number; the bin by its id or its code. */
  private rmLotId(ref: string): Promise<string> { return resolveRmLot(this.sql, ref); }
  private async binRef(ref: unknown): Promise<{ id: string; code: string | null } | null> {
    const v = typeof ref === 'string' ? scanCode(ref) : ''; // SCAN-3
    if (!v) return null;
    const [r] = UUID.test(v)
      ? await this.sql`select storage_location_id::text as id, storage_location_code as code from location.storage_location_master where storage_location_id = ${v}::uuid`
      : await this.sql`select storage_location_id::text as id, storage_location_code as code from location.storage_location_master where upper(storage_location_code) = upper(${v}) limit 1`;
    if (!r) throw new NotFoundException(`No bin ${v} on file.`);
    return { id: String(r.id), code: (r.code as string) ?? null };
  }

  async holds() {
    const rows = await this.sql`select h.lot_hold_id::text as "lotHoldId", h.subject_type as "subjectType", h.subject_id::text as "subjectId", h.reason, h.source,
        h.held_by as "heldBy", h.held_dt as "heldDt", coalesce(rb.batch_number, ob.batch_number) as "number"
        from inventory.lot_hold h
        left join inventory.rm_batch_master rb on h.subject_type = 'RM_LOT' and rb.rm_batch_id = h.subject_id
        left join production.oil_batch_master ob on h.subject_type = 'OIL_BATCH' and ob.oil_batch_id = h.subject_id
       where h.released_dt is null order by h.held_dt desc limit 500`;
    return { items: rows, nextCursor: null };
  }

  async hold(body: Row, principal: AuthPrincipal) {
    const type = body.subjectType === 'OIL_BATCH' ? 'OIL_BATCH' : body.subjectType === 'RM_LOT' ? 'RM_LOT' : null;
    const reason = String(body.reason ?? '').trim();
    if (!type || !body.subjectId) throw new BadRequestException('Name the raw lot or batch to hold.');
    if (!reason) throw new BadRequestException('Say why it is held.');
    const id = type === 'RM_LOT' ? await this.rmLotId(String(body.subjectId)) : String(body.subjectId);
    const exists = type === 'RM_LOT'
      ? await this.sql`select 1 from inventory.rm_batch_master where rm_batch_id = ${id}`
      : await this.sql`select 1 from production.oil_batch_master where oil_batch_id = ${id}`;
    if (!exists.length) throw new NotFoundException('Not found.');
    await holdSubject(this.sql, type, id, reason, 'MANUAL', principal.userId);
    return (await this.sql`select lot_hold_id::text as "lotHoldId", reason from inventory.lot_hold where subject_type = ${type} and subject_id = ${id} and released_dt is null`)[0];
  }

  async release(lotHoldId: string, body: Row, principal: AuthPrincipal) {
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Say why the hold is lifted, with the evidence.');
    const r = await this.sql`update inventory.lot_hold set released_by = ${principal.userId}, released_dt = now(), release_reason = ${reason}
                              where lot_hold_id = ${lotHoldId} and released_dt is null returning lot_hold_id::text as "lotHoldId"`;
    if (!r[0]) throw new ConflictException('That hold is not active.');
    return r[0];
  }

  async recall(ref: string) {
    const rmBatchId = await this.rmLotId(ref);
    const lot = (await this.sql`select rm_batch_id::text as "rmBatchId", batch_number as "lotNumber", status, expiry_date::text as "expiryDate" from inventory.rm_batch_master where rm_batch_id = ${rmBatchId}`)[0];
    if (!lot) throw new NotFoundException('Raw lot not found.');
    const hold = (await this.sql`select lot_hold_id::text as "lotHoldId", reason, held_dt as "heldDt" from inventory.lot_hold where subject_type = 'RM_LOT' and subject_id = ${rmBatchId} and released_dt is null`)[0] ?? null;
    const batches = await this.sql`
      with used as (
        select distinct ob.oil_batch_id, 'ISSUED' as via from inventory.inventory_batch ib
          join production.material_issue_item mii on mii.inventory_batch_id = ib.inventory_batch_id
          join production.material_issue mi on mi.material_issue_id = mii.material_issue_id
          join production.oil_batch_master ob on ob.production_order_id = mi.production_order_id
         where ib.rm_batch_id = ${rmBatchId}
        union
        select distinct g.oil_batch_id, coalesce(g.relationship_type, 'GENEALOGY') from inventory.batch_genealogy_history g
         where g.rm_batch_id = ${rmBatchId} and g.oil_batch_id is not null)
      select ob.oil_batch_id::text as "oilBatchId", ob.batch_number as "batchNumber", ob.status, string_agg(distinct u.via, ', ') as via,
             exists (select 1 from inventory.lot_hold h where h.subject_type = 'OIL_BATCH' and h.subject_id = ob.oil_batch_id and h.released_dt is null) as held
        from used u join production.oil_batch_master ob on ob.oil_batch_id = u.oil_batch_id
       group by ob.oil_batch_id, ob.batch_number, ob.status order by ob.batch_number`;
    const oilIds = batches.map((b) => String(b.oilBatchId));
    const fg = oilIds.length ? await this.sql`
      select distinct fg.finished_good_batch_id::text as "finishedGoodBatchId", fg.batch_number as "batchNumber", fg.status, po.oil_batch_id::text as "oilBatchId"
        from packaging.finished_good_batch_master fg join packaging.package_order po on po.package_order_id = fg.package_order_id
       where po.oil_batch_id = any(${oilIds}::uuid[])
      union
      select distinct fg.finished_good_batch_id::text, fg.batch_number, fg.status, g.oil_batch_id::text
        from inventory.batch_genealogy_history g join packaging.finished_good_batch_master fg on fg.finished_good_batch_id = g.finished_good_batch_id
       where g.oil_batch_id = any(${oilIds}::uuid[]) or g.rm_batch_id = ${rmBatchId}` : [];
    const fgIds = fg.map((f) => String(f.finishedGoodBatchId));
    const shipped = fgIds.length ? await this.sql`
      select dm.dispatch_id::text as "dispatchId", dm.dispatch_date::text as "dispatchDate", dm.status, so.so_number as "salesOrderNumber", so.sales_order_id::text as "salesOrderId",
             so.customer_id::text as "customerId", di.finished_good_batch_id::text as "finishedGoodBatchId", di.dispatched_qty::text as "dispatchedQty"
        from sales.dispatch_items di join sales.dispatch_master dm on dm.dispatch_id = di.dispatch_id
        left join sales.sales_order so on so.sales_order_id = dm.sales_order_id
       where di.finished_good_batch_id = any(${fgIds}::uuid[]) order by dm.dispatch_date desc nulls last` : [];
    return { lot, hold, batches, finishedGoods: fg, shippedOrders: shipped };
  }

  async putawayLabel(ref: string, body: Row, principal: AuthPrincipal) {
    const rmBatchId = await this.rmLotId(ref);
    const bin = await this.binRef(body.storageLocationId);
    const label = await this.sql.begin(async (tx) => {
      const b = (await tx`select rb.rm_batch_id::text as id, rb.batch_number, rb.status, rb.expiry_date::text as expiry, rb.received_qty::text as qty, u.uom_code,
                                 rb.storage_location_id::text as loc, ra.alias_name as floor_code, rb.created_dt::date::text as received
                            from inventory.rm_batch_master rb
                            left join platform.uom_master u on u.uom_id = rb.uom_id
                            left join lateral (select alias_name from masterdata.rm_alias a where a.material_id = rb.material_id and a.status = 'ACTIVE' order by a.created_dt limit 1) ra on true
                           where rb.rm_batch_id = ${rmBatchId} for update of rb`)[0];
      if (!b) throw new NotFoundException('Raw lot not found.');
      const st = String(b.status ?? '').toUpperCase();
      if (st === 'QUARANTINE' || st === 'REJECTED') throw new ConflictException(st === 'QUARANTINE' ? 'This lot is still in quarantine: it is put away after incoming QC passes.' : 'This lot was rejected; it is not put away.');
      if ((await tx`select 1 from inventory.lot_hold where subject_type = 'RM_LOT' and subject_id = ${rmBatchId} and released_dt is null`).length) throw new ConflictException('This lot is on hold.');
      if (b.expiry && String(b.expiry) < new Date().toISOString().slice(0, 10)) throw new ConflictException('This lot is past its expiry: QC must retest and re-date it first.');
      const lastLoc = (await tx`select storage_location_id::text as loc from inventory.raw_lot_label where rm_batch_id = ${rmBatchId} order by printed_dt desc limit 1`)[0]?.loc as string | undefined;
      const loc = bin?.id ?? (b.loc as string) ?? lastLoc ?? null;
      if (!loc) throw new BadRequestException('Scan the bin first: the label carries where the lot sits.');
      const binCode = bin?.code ?? ((await tx`select storage_location_code as code from location.storage_location_master where storage_location_id = ${loc}::uuid`)[0]?.code as string | undefined) ?? null;
      const prev = Number((await tx`select count(*)::int as n from inventory.raw_lot_label where rm_batch_id = ${rmBatchId}`)[0]!.n);
      // SCAN-10: a second label is a REPRINT; it needs a reason, kept with the label row.
      const reprintReason = typeof body.reprintReason === 'string' ? body.reprintReason.trim().slice(0, 300) : '';
      if (prev > 0 && !reprintReason) throw new BadRequestException('This lot already has a label: a reprint needs a reason (it is logged with your name).');
      // SCAN-5: the label's scan code is the lot's opaque L- id (what pick and scan-resolve read), minted
      // once per stock row. A lot with no stock row yet keeps its RM batch number as the code.
      const [ib] = await tx`select inventory_batch_id::text as id from inventory.inventory_batch where rm_batch_id = ${rmBatchId} order by created_dt nulls last limit 1`;
      const barcode = ib && this.codes ? await this.codes.lotBarcode(String(ib.id), principal) : null;
      const payload = {
        lotId: String(b.batch_number), barcode, floorCode: (b.floor_code as string) ?? null, qty: b.qty, uom: b.uom_code ?? null, expiry: b.expiry ?? null,
        received: b.received, storageLocationId: loc, binCode, hazard: HAZARD_PENDING, reprint: prev > 0, ...(prev > 0 ? { reprintReason } : {}),
      };
      await tx`insert into inventory.raw_lot_label (rm_batch_id, storage_location_id, payload, reprint, printed_by) values (${rmBatchId}, ${loc}, ${JSON.stringify(payload)}::jsonb, ${prev > 0}, ${principal.userId})`;
      return payload;
    });
    // FLOOR-FIX-2: the label is QUEUED to the print agent (plan §4, "Scan the bin -> raw-lot label
    // printed"). It used to be logged and never reach a printer. One `code` drives both the QR and the
    // Code 128 (label-render.js), so the two can never disagree; it is the opaque L- id the picker scans.
    // Queued after the label row commits: a print failure parks the job and raises an alert, it never
    // undoes the putaway record.
    if (!this.print) return label;
    const station = typeof body.station === 'string' && body.station.trim() ? body.station.trim().slice(0, 60) : 'Warehouse';
    const code = label.barcode ?? label.lotId;
    const job = await this.print.enqueue({
      station, labelKind: 'raw_lot', subjectRef: code,
      content: {
        brand: 'RAW AROMA CHEM',
        title: label.floorCode ?? 'Raw lot',
        lines: [
          ['Lot', label.lotId], ['Qty', label.qty == null ? null : `${label.qty}${label.uom ? ' ' + label.uom : ''}`],
          ['Expiry', label.expiry], ['Bin', label.binCode], ['Received', label.received as string | null], ['Hazard', label.hazard],
        ],
        code,
        reprint: label.reprint,
      },
    }, principal);
    return { ...label, printJobId: job.printJobId, printStatus: job.status };
  }
}
