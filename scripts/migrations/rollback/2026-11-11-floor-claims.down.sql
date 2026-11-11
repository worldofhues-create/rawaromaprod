-- Rollback for 2026-11-11-floor-claims (FLOOR-QC-IN-1, FLOOR-LOT-STOP-1, FLOOR-TEMP-1). DESTRUCTIVE for
-- the audit rows these tables hold: lot QC transitions, line stops and their resumes, temperature
-- readings and excursions, and paired temperature sensors (their device rows). Export first if wanted. Lot holds an excursion raised stay in
-- inventory.lot_hold (source TEMP_EXCURSION) and are released there. RM batches, stock and jobs are untouched.

-- @target: main

delete from platform.floor_alert where subject_type = 'device' and subject_id in (select device_id from platform.device_master where kind = 'temp_sensor');
delete from platform.device_master where kind = 'temp_sensor';
alter table platform.device_master drop constraint if exists device_master_kind_check;
alter table platform.device_master add constraint device_master_kind_check
  check (kind in ('label_printer', 'display', 'kiosk', 'scale', 'scanner'));
drop table if exists quality.temperature_excursion;
drop table if exists quality.material_temp_limit;
drop table if exists quality.temperature_reading;
drop table if exists quality.storage_zone_bin;
drop table if exists quality.storage_zone;
drop table if exists production.floor_line_stop;
drop table if exists inventory.lot_qc_event;
delete from public.schema_migrations where id like '2026-11-11-floor-claims%';
