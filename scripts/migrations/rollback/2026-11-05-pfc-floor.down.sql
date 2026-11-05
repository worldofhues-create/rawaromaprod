-- Rollback for 2026-11-05-pfc-floor (lane pf-c). Drops the floor tables in dependency order and
-- the migration record, so `pnpm db:migrate` re-applies it. DESTRUCTIVE for rows written since:
-- paired devices (they must pair again), print history, maceration runs (a batch mid-maceration
-- loses its timer and the shipping block), shipments and their AWBs. Export them first.

-- @target: main

drop table if exists sales.shipment_unit;
drop table if exists sales.shipment_carton;
drop table if exists sales.shipment;
drop table if exists sales.courier_connector;
drop table if exists production.maceration_event;
drop table if exists production.maceration_run;
drop table if exists production.maceration_setting;
drop table if exists platform.floor_alert;
drop table if exists platform.scale_reading;
drop table if exists platform.print_job;
drop table if exists platform.device_token;
drop table if exists platform.device_pairing;
drop table if exists platform.device_master;
delete from public.schema_migrations where id like '2026-11-05-pfc-floor%';
