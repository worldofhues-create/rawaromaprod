-- Rollback for 2026-11-05-pfa-floor (lane pf-a, PROD-A). Drops the rules engine, floor codes, lot
-- barcodes and the floor checklists, and the migration record so `pnpm db:migrate` re-applies it.
-- DESTRUCTIVE for rows written since: policy versions/decisions/overrides, floor codes and lot
-- barcodes already printed on labels (a reprinted label would carry a NEW id), and station history.
-- Take a dump of these tables first if any lot label has been printed.

-- @target: main

drop table if exists production.floor_label;
drop table if exists production.floor_mix_step;
drop table if exists production.floor_line;
drop table if exists production.floor_job;
drop sequence if exists production.floor_job_no_seq;
drop table if exists inventory.lot_barcode;
drop table if exists masterdata.floor_code;
drop table if exists masterdata.floor_family_colour;
drop table if exists platform.policy_decision;
drop table if exists platform.policy_override;
drop table if exists platform.policy_version;
drop table if exists platform.policy;
delete from public.schema_migrations where id like '2026-11-05-pfa-floor%';
