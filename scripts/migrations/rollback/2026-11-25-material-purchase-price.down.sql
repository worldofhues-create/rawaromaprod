-- Rollback of 2026-11-25-material-purchase-price (IMPORT-RP-COST). Every purchase price on file and
-- its history are lost here; the cost facts already sent to ALEMBIC are not recalled.
-- @target: main
drop table if exists procurement.material_purchase_price;
drop table if exists procurement.purchase_price_setting;
delete from public.schema_migrations where id like '2026-11-25-material-purchase-price%';
