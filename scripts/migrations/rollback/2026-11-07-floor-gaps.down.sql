-- Rollback for 2026-11-07-floor-gaps (FLOOR-1..n). DESTRUCTIVE for the split genealogy, the child-lot
-- label log and the FG zone colours. The child lots themselves (inventory.inventory_batch rows, their
-- L- codes and their ledger rows) are ordinary stock and are KEPT: dropping them would lose stock.
-- Export first if wanted:
--   select * from inventory.lot_split; select * from inventory.lot_label; select * from location.fg_zone_style;

-- @target: main

drop table if exists inventory.lot_label;
drop table if exists inventory.lot_split;
drop table if exists location.fg_zone_style;
delete from public.schema_migrations where id like '2026-11-07-floor-gaps%';
