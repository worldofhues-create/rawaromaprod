-- Rollback for 2026-11-17-prom-3-reference (PROM-3). DESTRUCTIVE for the retained references (who
-- proposed and approved each, which sample it is) and for each QC round's stage and reference: export
-- quality.reference_standard first if wanted. The retained samples themselves stay in
-- quality.qc_sample_retention. maceration_run.qc1_production_qc_id stays NULLABLE: a run opened on a
-- QC 1 round has no production_qc id, and the old code only ever writes that column. The code that
-- reads these must be rolled back with this.

-- @target: main

alter table production.maceration_run drop column if exists qc1_round_id;
alter table quality.batch_qc_round drop constraint if exists batch_qc_round_reference_basis_chk;
alter table quality.batch_qc_round drop column if exists reference_basis;
alter table quality.batch_qc_round drop column if exists reference_standard_id;
alter table quality.batch_qc_round drop column if exists stage;
drop table if exists quality.reference_standard;
delete from platform.policy_decision where policy_key = 'qc.reference_required';
delete from platform.policy_override where policy_key = 'qc.reference_required';
delete from platform.policy_version where policy_key = 'qc.reference_required';
delete from platform.policy where policy_key = 'qc.reference_required';
delete from public.schema_migrations where id like '2026-11-17-prom-3-reference%';
