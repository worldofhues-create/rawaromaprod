-- Rollback for 2026-11-18-prom-4-fill-lot (PROM-4). Drops the two sequences, the record of which lots
-- the server minted and the lot rule. Every minted number stays on its batch (they are records now);
-- only the marker that says the server made them goes. The code that mints must be rolled back with this.

-- @target: main

alter table packaging.finished_good_batch_master drop column if exists lot_rule_version;
alter table packaging.finished_good_batch_master drop column if exists lot_assigned_at_fill;
drop sequence if exists packaging.fg_lot_seq;
drop sequence if exists production.oil_batch_no_seq;
delete from platform.policy_decision where policy_key = 'fill.lot_server_assigned';
delete from platform.policy_override where policy_key = 'fill.lot_server_assigned';
delete from platform.policy_version where policy_key = 'fill.lot_server_assigned';
delete from platform.policy where policy_key = 'fill.lot_server_assigned';
delete from public.schema_migrations where id like '2026-11-18-prom-4-fill-lot%';
