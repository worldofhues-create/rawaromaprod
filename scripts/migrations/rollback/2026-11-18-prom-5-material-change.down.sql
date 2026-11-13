-- Rollback for 2026-11-18-prom-5-material-change (PROM-5). Drops the continuity records and the material
-- changes: export them first if wanted (ALEMBIC keeps its own copy of every change it was sent). The
-- supplier-change rule and its versions go too; the code that records continuity must be rolled back with this.

-- @target: main

drop table if exists production.material_change;
drop table if exists production.product_continuity;
drop table if exists production.batch_continuity;
delete from platform.policy_decision where policy_key = 'continuity.supplier_change_is_material';
delete from platform.policy_override where policy_key = 'continuity.supplier_change_is_material';
delete from platform.policy_version where policy_key = 'continuity.supplier_change_is_material';
delete from platform.policy where policy_key = 'continuity.supplier_change_is_material';
delete from public.schema_migrations where id like '2026-11-18-prom-5-material-change%';
