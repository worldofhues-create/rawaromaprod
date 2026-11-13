/**
 * STOCK2-3: what a material holds, in the units its lots and reservations are actually in.
 *
 * sum(quantity_on_hand) across lots added kilograms to grams as if they were one number, so 1 kg and
 * 250 g read as 251, and every plan, shortage and check on top inherited it. SQL sums only inside one
 * unit here; netQty does the rest, exactly, or says it cannot. A reservation with no unit is in the
 * unit of the lot it holds: it is a claim on that lot.
 */
import { netQty, type Netted, type QtyPart } from '@core/data-kernel';
import type { Sql, TransactionSql } from 'postgres';

export interface StockPosition { onHand: QtyPart[]; reserved: QtyPart[] }

/** One material's stock, by unit. `ids` null reads every material. */
export async function stockPosition(q: Sql | TransactionSql, ids: string[] | null, opts: { exceptDocumentId?: string } = {}): Promise<Map<string, StockPosition>> {
  const only = ids ? q`and ib.material_id = any(${ids}::uuid[])` : q``;
  // STOCK-FIX-RP (STK-9): a production order's own planned holds are its stock, not a claim against it.
  const except = opts.exceptDocumentId ? q`and r.reserved_for_document_id is distinct from ${opts.exceptDocumentId}::uuid` : q``;
  const held = await q<{ material_id: string; uom: string | null; qty: string }[]>`
    select ib.material_id::text, u.uom_code as uom, sum(ib.quantity_on_hand)::text as qty
      from inventory.inventory_batch ib left join platform.uom_master u on u.uom_id = ib.uom_id
     where ib.material_id is not null ${only}
     group by 1, 2`;
  const claimed = await q<{ material_id: string; uom: string | null; qty: string }[]>`
    select ib.material_id::text, coalesce(ru.uom_code, lu.uom_code) as uom, sum(r.reserved_qty)::text as qty
      from inventory.stock_reservation r
      join inventory.inventory_batch ib on ib.inventory_batch_id = r.inventory_batch_id
      left join platform.uom_master ru on ru.uom_id = r.uom_id
      left join platform.uom_master lu on lu.uom_id = ib.uom_id
     where r.released_dt is null and ib.material_id is not null ${only} ${except}
     group by 1, 2`;
  const out = new Map<string, StockPosition>();
  const at = (id: string) => { let p = out.get(id); if (!p) out.set(id, p = { onHand: [], reserved: [] }); return p; };
  for (const r of held) at(r.material_id).onHand.push({ qty: r.qty, uom: r.uom });
  for (const r of claimed) at(r.material_id).reserved.push({ qty: r.qty, uom: r.uom });
  return out;
}

/** The unit to read a position in when the caller has none: the first with stock in it. */
export function unitOf(p: StockPosition | undefined): string | null {
  return p?.onHand.find((x) => x.uom)?.uom ?? p?.reserved.find((x) => x.uom)?.uom ?? null;
}

export function availableIn(p: StockPosition | undefined, uom: string | null | undefined): Netted {
  return netQty(p?.onHand ?? [], p?.reserved ?? [], uom);
}
