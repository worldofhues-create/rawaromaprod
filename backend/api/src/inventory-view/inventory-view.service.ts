/**
 * InventoryViewService — Module 6 inventory intelligence the base CRUD lacks. Computes, per batch,
 * the TRUE availability (available = on-hand − reserved − blocked) by netting open reservations
 * against the batch balance, joins the real expiry date + days-to-expiry, and returns everything
 * FEFO-ordered (first-expiry-first-out). Raw SQL over the shared PG_CLIENT; materialId is returned
 * so the global MaterialMaskingInterceptor masks it (+ attaches the alias) for non-reveal roles.
 */
import { netQty, notTotalled, type QtyPart } from '@core/data-kernel';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';

@Injectable()
export class InventoryViewService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  /** QC-GATE: a batch reads available only on ACCEPT or PASS; missing, PENDING and anything else
   *  read blocked. Stock with no RM batch has no inspection to read and stays as it was. */
  /** Per-batch availability + expiry, FEFO-ordered. Optional materialId filter (for pick selection). */
  async availability(opts: { limit?: number; materialId?: string; cursor?: string }) {
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 200);
    // STOCK-FIX-RP (STK-29): the list stopped at 200 rows with no cursor, so with 224 lots 24 were never
    // shown. Keyset pages in the same FEFO order (expiry first, no expiry last; then lot number, none
    // last; then the id, so the order is total), with the cursor naming the last row of a page.
    const after = opts.cursor ? decodeCursor(opts.cursor) : null;
    const conds = [
      ...(opts.materialId ? [this.sql`ib.material_id = ${opts.materialId}`] : []),
      ...(after ? [this.sql`(coalesce(rb.expiry_date, 'infinity'::date), rb.batch_number is null, coalesce(rb.batch_number, ''), ib.inventory_batch_id)
                          > (${after.e}::date, ${after.n}::boolean, ${after.b}::text, ${after.id}::uuid)`] : []),
    ];
    const where = conds.length ? this.sql`where ${conds.reduce((a, c, i) => (i === 0 ? c : this.sql`${a} and ${c}`))}` : this.sql``;
    const rows = await this.sql`
      select ib.inventory_batch_id       as "inventoryBatchId",
             ib.rm_batch_id              as "rmBatchId",
             ib.material_id              as "materialId",
             ib.storage_location_id      as "storageLocationId",
             ib.uom_id                   as "uomId",
             rb.batch_number             as "batchNumber",
             coalesce(ib.quantity_on_hand, 0)::text as "onHandQty",
             lu.uom_code                 as uom,
             coalesce(r.parts, '[]'::json) as "reservedParts",
             qc.overall_result           as "qcStatus",
             (ib.rm_batch_id is not null and upper(coalesce(qc.overall_result,'')) not in ('ACCEPT','PASS','LEGACY_RELEASE')) as "isBlocked",
             rb.expiry_date              as "expiryDate",
             case when rb.expiry_date is not null then (rb.expiry_date - current_date) end as "daysToExpiry",
             coalesce(s.status_code, rb.status) as "status",
             coalesce(rb.expiry_date, 'infinity'::date)::text as "_e", (rb.batch_number is null) as "_n", coalesce(rb.batch_number, '') as "_b"
      from inventory.inventory_batch ib
      left join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
      left join inventory.inventory_status_master s on s.inventory_status_id = ib.inventory_status_id
      left join platform.uom_master lu on lu.uom_id = ib.uom_id
      left join lateral (
        -- STOCK2-3: by unit. A reservation with no unit is in the unit of the lot it holds.
        select json_agg(json_build_object('qty', x.qty, 'uom', x.uom)) as parts
          from (select sum(sr.reserved_qty)::text as qty, coalesce(ru.uom_code, lu.uom_code) as uom
                  from inventory.stock_reservation sr left join platform.uom_master ru on ru.uom_id = sr.uom_id
                 where sr.inventory_batch_id = ib.inventory_batch_id and sr.released_dt is null and coalesce(sr.status, 'ACTIVE') <> 'RELEASED'
                 group by 2) x
      ) r on true
      -- FLOOR-QC-IN-1-LEGACY: QC's latest word, a pre-sample-rule LEGACY_RELEASE included (one rule, in SQL).
      left join lateral (select inventory.rm_lot_qc_result(ib.rm_batch_id) as overall_result) qc on true
      ${where}
      order by coalesce(rb.expiry_date, 'infinity'::date) asc, rb.batch_number is null, coalesce(rb.batch_number, '') asc, ib.inventory_batch_id asc
      limit ${limit + 1}`;
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = more && last ? encodeCursor({ e: String(last._e), n: Boolean(last._n), b: String(last._b), id: String(last.inventoryBatchId) }) : null;
    const items = page.map(({ onHandQty, reservedParts, isBlocked, _e, _n, _b, ...r }) => {
      void _e; void _n; void _b;
      const uom = (r.uom as string | null) ?? null, on = { qty: onHandQty as string, uom }, parts = reservedParts as QtyPart[];
      const reserved = netQty(parts, [], uom), free = netQty([on], parts, uom);
      const onHand = Number(onHandQty);
      return {
        ...r, onHand, reserved: 'refused' in reserved ? null : Number(reserved.qty), blocked: isBlocked ? onHand : 0,
        available: isBlocked ? 0 : 'refused' in free ? null : Number(free.qty),
        unitNote: 'refused' in free ? notTotalled(free) : null,
      };
    });
    return { items, nextCursor };
  }
}

interface Cursor { e: string; n: boolean; b: string; id: string }
function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}
function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.e === 'string' && typeof c.n === 'boolean' && typeof c.b === 'string' && /^[0-9a-f-]{36}$/i.test(c.id)) return c;
  } catch { /* fall through */ }
  throw new BadRequestException('That cursor is not one this list gave out.');
}
