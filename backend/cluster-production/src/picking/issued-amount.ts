/**
 * STOCK3-2: one material's issued figures on one production order, worked out again from what was
 * issued every time something changes it: an issue, a verified weight, an abort. Recomputed, never
 * incremented, so a retried or reversed step cannot leave the figure off by itself.
 *
 * production_order_ingredients.issued_qty stays the BOOLEAN the dictionary locks and every reader
 * asks ("is this line still open?"), now true only when the pick covers the line. issued_amount is
 * the quantity: the verified weight where a floor line has one, the pick otherwise, in the line's unit.
 *
 * Takes a tagged template so the floor (postgres.js) and production (drizzle) run it inside their own
 * transactions: a verified weight has to land with the reading, not after it.
 */
import { spreadIssued, type QtyPart } from '@core/data-kernel';
import { sql } from 'drizzle-orm';

export type IssuedSql = (strings: TemplateStringsArray, ...values: never[]) => PromiseLike<unknown>;

/** A drizzle transaction as the tag settleIssued takes. */
export function drizzleTag(tx: { execute(q: ReturnType<typeof sql>): PromiseLike<unknown> }): IssuedSql {
  return (strings, ...values) => tx.execute(sql(strings, ...values));
}

export async function settleIssued(q: IssuedSql, productionOrderId: string, materialId: string, by: string): Promise<void> {
  const tag = q as unknown as (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>;
  const lines = (await tag`
    select i.production_order_ingredient_id::text as id, coalesce(i.required_qty, 0)::text as qty, u.uom_code as uom
      from production.production_order_ingredients i left join platform.uom_master u on u.uom_id = i.uom_id
     where i.production_order_id = ${productionOrderId}::uuid and i.material_id = ${materialId}::uuid
     order by i.created_dt, i.production_order_ingredient_id
       for update of i`) as Array<{ id: string; qty: string; uom: string | null }>;
  const issued = (await tag`
    select l.picked_qty::text as qty, u.uom_code as uom, fl.actual_mg::text as actual_mg
      from production.material_issue mi
      join production.material_issue_item mii on mii.material_issue_id = mi.material_issue_id
      left join production.material_pick_list_items l
        on l.material_pick_list_item_id = mii.material_pick_list_item_id
        or (mii.material_pick_list_item_id is null and l.material_pick_list_id = mi.material_pick_list_id and l.material_id = mii.material_id)
      left join platform.uom_master u on u.uom_id = l.uom_id
      left join production.floor_line fl on fl.material_pick_list_item_id = l.material_pick_list_item_id
     where mi.production_order_id = ${productionOrderId}::uuid and mii.material_id = ${materialId}::uuid and mii.issued_qty = true
       and coalesce(mii.status, 'ACTIVE') <> 'REVERSED' and coalesce(mi.status, 'ACTIVE') not in ('REVERSED', 'VOID')`) as Array<{ qty: string | null; uom: string | null; actual_mg: string | null }>;
  const picked: QtyPart[] = issued.map((r) => ({ qty: r.qty, uom: r.uom }));
  const real: QtyPart[] = issued.map((r) => (r.actual_mg === null ? { qty: r.qty, uom: r.uom } : { qty: r.actual_mg, uom: 'mg' }));
  for (const { line, full, amount } of spreadIssued(lines, picked, real)) {
    await tag`
      update production.production_order_ingredients
         set issued_qty = ${full}, issued_amount = ${amount}::numeric, updated_by = ${by}
       where production_order_ingredient_id = ${line.id}::uuid`;
  }
}
