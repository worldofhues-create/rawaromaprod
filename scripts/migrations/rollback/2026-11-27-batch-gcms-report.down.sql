-- Rollback of 2026-11-27-batch-gcms-report (FACTORY-DOCS). Every GC-MS file attached here is lost; the
-- `qc.gcms.attached` facts already sent are not recalled (ALEMBIC kept its own copy of each PDF), and a
-- queued fact whose file is gone can no longer be fetched: discard it from the parked list.
-- @target: main
drop table if exists production.batch_gcms_report;
delete from public.schema_migrations where id like '2026-11-27-batch-gcms-report%';
