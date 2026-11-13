-- Rollback of 2026-11-20-stk-oil-ledger (STK-10, STK-11). Drops the oil ledger and the remnant record:
-- every movement since the forward migration is lost, so take a copy first if any batch was packed.
-- @target: main
drop trigger if exists oil_batch_remnant_append_only on production.oil_batch_remnant;
drop trigger if exists oil_batch_movement_append_only on production.oil_batch_movement;
drop table if exists production.oil_batch_remnant;
drop table if exists production.oil_batch_movement;
-- The append-only function is shared with 2026-11-22-stk-mixer-reveal; it goes only when no trigger uses it.
do $$
begin
  if not exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace n on n.oid = p.pronamespace
                  where p.proname = 'stk_append_only' and n.nspname = 'production') then
    drop function if exists production.stk_append_only();
  end if;
end $$;
alter table packaging.product_sku drop constraint if exists product_sku_net_content_mg_chk;
alter table packaging.product_sku drop column if exists net_content_mg;
delete from public.schema_migrations where id like '2026-11-20-stk-oil-ledger%';
