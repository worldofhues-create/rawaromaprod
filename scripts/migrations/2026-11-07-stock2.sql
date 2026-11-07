-- Migration: 2026-11-07-stock2 (lane stock-2). STOCK2-1, STOCK2-2.
--
-- ADDITIVE + IDEMPOTENT ONLY (PB-16 convention). No column changes type; nothing is dropped.
--
--   production.material_issue_item.material_pick_list_item_id
--                  STOCK2-2: the pick line an issue line draws on. The debit found its quantity by
--                  material, so one material on two lines debited twice. Backfilled only where exactly
--                  one line of the pick list carries the material; any other old row stays null and
--                  the debit refuses it rather than guess.
--   production.floor_line.debited_mg
--                  STOCK2-1: what the ledger has taken for this line, so the verified weight can true
--                  it up exactly once.
--   production.floor_line.over_mg, over_source, over_read_by, over_reason, over_by, over_dt
--                  STOCK2-1: a reading over the pick, held until a supervisor records why.
--   production.weighing_record_status_chk
--                  STOCK2-1: gains OVER_PICK (held for a supervisor) and NOT_BOOKABLE (a reading the
--                  lot's unit cannot hold). The only non-additive statement here, and it only widens:
--                  every row the old check allowed, this one allows.
--
-- Rollback: scripts/migrations/rollback/2026-11-07-stock2.down.sql

-- @target: main

alter table production.material_issue_item add column if not exists material_pick_list_item_id uuid;
alter table production.floor_line add column if not exists debited_mg bigint;
alter table production.floor_line add column if not exists over_mg bigint;
alter table production.floor_line add column if not exists over_source varchar(10);
alter table production.floor_line add column if not exists over_read_by varchar(255);
alter table production.floor_line add column if not exists over_reason text;
alter table production.floor_line add column if not exists over_by varchar(255);
alter table production.floor_line add column if not exists over_dt timestamptz;

alter table production.weighing_record drop constraint if exists weighing_record_status_chk;
alter table production.weighing_record add constraint weighing_record_status_chk
  check (status in ('ACCEPTED', 'OUT_OF_TOLERANCE', 'OVER_PICK', 'NOT_BOOKABLE'));

with only_line as (
  select mi.material_issue_id, l.material_id, min(l.material_pick_list_item_id::text)::uuid as id
    from production.material_issue mi
    join production.material_pick_list_items l on l.material_pick_list_id = mi.material_pick_list_id
   group by 1, 2
  having count(*) = 1
)
update production.material_issue_item mii
   set material_pick_list_item_id = o.id
  from only_line o
 where o.material_issue_id = mii.material_issue_id
   and o.material_id = mii.material_id
   and mii.material_pick_list_item_id is null;
