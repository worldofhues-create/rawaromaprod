-- Rollback for 2026-11-07-scan-scanner-kind (SCAN-4). DESTRUCTIVE for scanner records: they are
-- deleted (the old check cannot hold them). Nothing else references a scanner row: a scanner never
-- pairs, so it has no device_token, device_pairing or print_job. Export them first if wanted:
--   select * from platform.device_master where kind = 'scanner';

-- @target: main

delete from platform.floor_alert where subject_type = 'device' and subject_id in (select device_id from platform.device_master where kind = 'scanner');
delete from platform.device_master where kind = 'scanner';
alter table platform.device_master drop constraint if exists device_master_kind_check;
alter table platform.device_master add constraint device_master_kind_check
  check (kind in ('label_printer', 'display', 'kiosk', 'scale'));
delete from public.schema_migrations where id like '2026-11-07-scan-scanner-kind%';
