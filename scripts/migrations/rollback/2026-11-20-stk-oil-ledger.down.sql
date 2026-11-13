-- Rollback of 2026-11-20-stk-oil-ledger (STK-10, STK-11). Drops the oil ledger and the remnant record:
-- every movement since the forward migration is lost, so take a copy first if any batch was packed.
-- @target: main
drop trigger if exists oil_batch_remnant_append_only on production.oil_batch_remnant;
drop trigger if exists oil_batch_movement_append_only on production.oil_batch_movement;
drop table if exists production.oil_batch_remnant;
drop table if exists production.oil_batch_movement;
drop function if exists production.stk_append_only();
alter table packaging.product_sku drop constraint if exists product_sku_net_content_mg_chk;
alter table packaging.product_sku drop column if exists net_content_mg;
