-- Migration: 2026-09-26-automation-app-role-grants (RC7, lane rc7-rp)
--
-- The application role's privileges on the `automation` schema. 0020_adhoc_g3_automation.sql
-- created the schema and its tables as the migrating OWNER role (prod: rawprod_owner) and granted
-- nothing, so the DML-only app role the API runs as (prod: rawprod_app) could not even resolve
-- automation.applied: the four automation drains (material shortage, quarantine intake, incoming
-- QC outcome, packaging release) failed on production from 2026-09-24 until P0 granted the schema
-- by hand on 2026-09-25. This is that hand grant, as a migration: USAGE on the schema, DML on its
-- tables, USAGE/SELECT on its sequences, EXECUTE on its functions, and the same as default
-- privileges for whatever the owner creates in the schema later.
--
-- The role is a PARAMETER, never a name written here. scripts/db-migrate.ts hands DB_APP_ROLE to
-- every block as the transaction-local setting `rawprod.app_role`; production's migrate.env renders
-- it from the user of the app's own DATABASE_URL (infra/aws/env/render-env.sh). The demo database
-- sits on the same RDS instance as production's, so a hardcoded `rawprod_app` here would hand the
-- production role grants inside the demo database.
--   unset      -> NOTICE, nothing granted (dev, CI and test databases have no separate app role;
--                 the demo keeps granting through infra/aws/demo/sql/app-role-grants.sql)
--   no such role -> the migration FAILS instead of being recorded as applied without a grant
--
-- IDEMPOTENT (PB-16): re-running a GRANT or ALTER DEFAULT PRIVILEGES that is already in place is a
-- no-op, so this converges on a database P0 already granted by hand.
-- @target: main

create schema if not exists automation;

do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'automation grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'automation grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant usage on schema automation to %I', app);
  execute format('grant select, insert, update, delete on all tables in schema automation to %I', app);
  execute format('grant usage, select on all sequences in schema automation to %I', app);
  execute format('grant execute on all functions in schema automation to %I', app);
  execute format('alter default privileges in schema automation grant select, insert, update, delete on tables to %I', app);
  execute format('alter default privileges in schema automation grant usage, select on sequences to %I', app);
  execute format('alter default privileges in schema automation grant execute on functions to %I', app);
end $$;
