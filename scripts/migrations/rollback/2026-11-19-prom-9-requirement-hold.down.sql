-- Rollback for 2026-11-19-prom-9-requirement-hold (PROM-9). Drops the customer hold on a requirement.
-- A requirement held at the time becomes plannable again, so roll back the code that refuses a held
-- requirement with it, and only when ALEMBIC no longer sends holds.

-- @target: main

alter table bridge.production_requirement drop constraint if exists production_requirement_customer_hold_chk;
alter table bridge.production_requirement drop column if exists customer_hold_since;
alter table bridge.production_requirement drop column if exists customer_hold_reason;
delete from public.schema_migrations where id like '2026-11-19-prom-9-requirement-hold%';
