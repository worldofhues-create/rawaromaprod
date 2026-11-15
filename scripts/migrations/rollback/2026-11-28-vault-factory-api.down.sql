-- Rollback of 2026-11-28-vault-factory-api (RP-BE-1). Lost with it: every kiosk problem, operating rule,
-- maceration default, device test, recall review, role change request and floor-code reveal recorded
-- since; who returned a PO and why; every QC person's call on a round. Holds a recall placed stay on
-- inventory.lot_hold (they are released there, with a reason, not by a rollback). Alerts raised for a
-- problem stay in platform.floor_alert.
-- @target: main
alter table quality.batch_qc_round drop column if exists overrides_proposal;
alter table quality.batch_qc_round drop column if exists decision_reason;
alter table quality.batch_qc_round drop column if exists decided_dt;
alter table quality.batch_qc_round drop column if exists decided_by;
alter table quality.batch_qc_round drop column if exists decided_decision;
alter table procurement.purchase_order drop column if exists rejected_dt;
alter table procurement.purchase_order drop column if exists rejected_reason;
alter table procurement.purchase_order drop column if exists rejected_by;
drop table if exists masterdata.floor_code_reveal;
drop table if exists iam.role_change_request;
drop table if exists quality.recall_review;
drop sequence if exists quality.recall_review_no_seq;
drop table if exists platform.device_test;
drop table if exists production.maceration_default;
drop table if exists platform.operating_rule;
drop table if exists production.floor_problem;
delete from public.schema_migrations where id like '2026-11-28-vault-factory-api%';
