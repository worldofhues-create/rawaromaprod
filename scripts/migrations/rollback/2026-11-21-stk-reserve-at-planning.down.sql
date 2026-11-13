-- Rollback of 2026-11-21-stk-reserve-at-planning (STK-7, STK-8, STK-9). The reservations planning wrote
-- stay in inventory.stock_reservation (release them by order first if wanted); only the line columns go.
-- @target: main
-- (inventory.stock_reservation_document_idx is 0006_inventory.sql's index, not this migration's: it stays.)
alter table production.production_order_ingredients drop constraint if exists production_order_ingredients_mg_chk;
alter table production.production_order_ingredients drop column if exists reserved_batch_id;
alter table production.production_order_ingredients drop column if exists reserved_mg;
alter table production.production_order_ingredients drop column if exists required_mg;
delete from public.schema_migrations where id like '2026-11-21-stk-reserve-at-planning%';
