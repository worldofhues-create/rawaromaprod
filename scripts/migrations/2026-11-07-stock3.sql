-- Migration: 2026-11-07-stock3 (lane stock-3). STOCK3-2.
--
-- ADDITIVE + IDEMPOTENT ONLY (PB-16 convention). No column changes type; nothing is dropped.
--
--   production.production_order_ingredients.issued_amount
--                  STOCK3-2: the quantity really issued, in the line's own unit. issued_qty stays the
--                  BOOLEAN the dictionary locks, and now means the line is covered. Wider than the
--                  ledger's numeric(18,4): a verified weight is exact to the mg, which four places of
--                  a kg line cannot hold.
--
-- Backfill, once, when the column is first added. A row with nothing issued is 0. An issued row takes
-- the sum of its pick lines where that can be read exactly: one ingredient row for the material, every
-- line in the row's own unit, no verified weight on them. Any other issued row stays null, meaning
-- not known, and keeps its flag: a figure nobody can work out is not written down.
--
-- Rollback: scripts/migrations/rollback/2026-11-07-stock3.down.sql

-- @target: main

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'production'
              and table_name = 'production_order_ingredients' and column_name = 'issued_amount') then
    return;
  end if;
  alter table production.production_order_ingredients add column issued_amount numeric(28,10);
  update production.production_order_ingredients set issued_amount = 0 where coalesce(issued_qty, false) = false;
  update production.production_order_ingredients i
     set issued_amount = x.qty, issued_qty = x.qty >= coalesce(i.required_qty, 0)
    from (
      select mi.production_order_id, mii.material_id, sum(l.picked_qty) as qty, min(l.uom_id::text) as uom, count(distinct l.uom_id) as units,
             count(fl.actual_mg) as weighed, count(*) filter (where l.material_pick_list_item_id is null) as unlinked
        from production.material_issue mi
        join production.material_issue_item mii on mii.material_issue_id = mi.material_issue_id
        left join production.material_pick_list_items l
          on l.material_pick_list_item_id = mii.material_pick_list_item_id
        left join production.floor_line fl on fl.material_pick_list_item_id = l.material_pick_list_item_id
       where mii.issued_qty = true and coalesce(mii.status, 'ACTIVE') <> 'REVERSED'
         and coalesce(mi.status, 'ACTIVE') not in ('REVERSED', 'VOID')
       group by 1, 2) x
   where x.production_order_id = i.production_order_id and x.material_id = i.material_id
     and i.issued_qty = true and x.units = 1 and x.uom = i.uom_id::text and x.weighed = 0 and x.unlinked = 0
     and (select count(*) from production.production_order_ingredients o
           where o.production_order_id = i.production_order_id and o.material_id = i.material_id) = 1;
end $$;
