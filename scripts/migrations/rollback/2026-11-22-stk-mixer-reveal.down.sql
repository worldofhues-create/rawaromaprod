-- Rollback of 2026-11-22-stk-mixer-reveal (STK-15). DESTRUCTIVE for the reveal log: export it first.
-- @target: main
drop trigger if exists floor_mix_reveal_append_only on production.floor_mix_reveal;
drop table if exists production.floor_mix_reveal;
alter table production.floor_job drop column if exists mixer_assigned_dt;
alter table production.floor_job drop column if exists mixer_assigned_by;
alter table production.floor_job drop column if exists mixer_assigned_to;
delete from public.schema_migrations where id like '2026-11-22-stk-mixer-reveal%';
