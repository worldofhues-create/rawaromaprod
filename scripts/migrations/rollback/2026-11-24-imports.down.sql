-- Rollback of 2026-11-24-imports (IMPORT-RP). The import history, every dilution's composition and
-- every density source are lost; materials, suppliers, lots and formulas the imports wrote stay (they
-- were written by the single-record functions and are ordinary records).
-- @target: main
drop table if exists platform.import_job_row;
drop table if exists platform.import_job;
drop table if exists masterdata.material_dilution;
alter table masterdata.material drop column if exists density_source;
alter table inventory.rm_batch_master drop column if exists certificate_ref;
alter table inventory.grn_items drop column if exists certificate_ref;
delete from public.schema_migrations where id like '2026-11-24-imports%';
-- @target: formula
drop table if exists formula.import_job_row;
drop table if exists formula.import_job;
delete from public.schema_migrations where id like '2026-11-24-imports%';
