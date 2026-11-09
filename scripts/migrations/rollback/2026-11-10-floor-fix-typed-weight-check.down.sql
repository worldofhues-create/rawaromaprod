-- Rollback for 2026-11-10-floor-fix-typed-weight-check (FLOOR-FIX-3). DESTRUCTIVE for the typed-weight
-- sign-off audit rows. Export first if wanted: select * from platform.typed_weight_check;

-- @target: main

drop table if exists platform.typed_weight_check;
delete from public.schema_migrations where id like '2026-11-10-floor-fix-typed-weight-check%';
