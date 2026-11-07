-- Rollback for 2026-11-07-stock2 (STOCK2-1, STOCK2-2). DESTRUCTIVE for the pick-line links on issue
-- lines and for supervisor over-pick records (the reason, who, when). Stock itself is not touched:
-- on-hand and the inventory_event_history rows stay. Export first if wanted:
--   select floor_line_id, debited_mg, over_mg, over_reason, over_by, over_dt from production.floor_line where over_mg is not null;

-- @target: main

-- A held or unbookable reading is not an accepted one, so under the old check it reads as refused.
alter table production.weighing_record drop constraint if exists weighing_record_status_chk;
update production.weighing_record set status = 'OUT_OF_TOLERANCE' where status in ('OVER_PICK', 'NOT_BOOKABLE');
alter table production.weighing_record add constraint weighing_record_status_chk
  check (status in ('ACCEPTED', 'OUT_OF_TOLERANCE'));
alter table production.floor_line drop column if exists over_dt;
alter table production.floor_line drop column if exists over_by;
alter table production.floor_line drop column if exists over_reason;
alter table production.floor_line drop column if exists over_read_by;
alter table production.floor_line drop column if exists over_source;
alter table production.floor_line drop column if exists over_mg;
alter table production.floor_line drop column if exists debited_mg;
alter table production.material_issue_item drop column if exists material_pick_list_item_id;
delete from public.schema_migrations where id like '2026-11-07-stock2%';
