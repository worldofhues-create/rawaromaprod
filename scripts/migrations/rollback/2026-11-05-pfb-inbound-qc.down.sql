-- Rollback for 2026-11-05-pfb-inbound-qc (PROD-B). Drops the receiving audit, debit notes, payment
-- releases, checkpoint sets, QC rounds, reworks, lot holds and putaway label log, and the added columns.
-- Losing them loses the audit trail of those decisions; GRNs, RM batches and POs are untouched.

-- @target: main

drop table if exists inventory.raw_lot_label;
drop table if exists inventory.lot_hold;
drop table if exists quality.batch_rework;
drop table if exists quality.batch_qc_round;
alter table production.product_qc_spec drop column if exists qc_checkpoint_set_id;
drop table if exists quality.qc_checkpoint;
drop table if exists quality.qc_checkpoint_set;
alter table quality.qc_parameter_master drop column if exists photo_required_default;
alter table quality.qc_parameter_master drop column if exists critical_default;
alter table quality.qc_parameter_master drop column if exists instrument;
alter table quality.qc_parameter_master drop column if exists check_type;
drop table if exists procurement.po_payment_release;
drop table if exists procurement.debit_note;
drop table if exists inventory.receiving_audit_line;
drop table if exists inventory.receiving_audit;
alter table inventory.gate_entry_master drop column if exists hold_reason;
delete from public.schema_migrations where id like '2026-11-05-pfb-inbound-qc%';
