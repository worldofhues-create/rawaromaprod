-- Migration: 2026-11-03-vault-idempotency-key (SWEEP2-R1, Vault). The same store as
-- 2026-11-03-idempotency-key, on the Vault's own database: the Vault API has no path to the main
-- database, and its channel re-sends a formula write the same way the Factory's does.
--
-- ADDITIVE + IDEMPOTENT (PB-16 convention). Formula target only.
-- Rollback: scripts/migrations/rollback/2026-11-03-vault-idempotency-key.down.sql

-- @target: formula

create table if not exists formula.idempotency_key (
  user_id          uuid         not null,
  idempotency_key  varchar(100) not null,
  request_hash     char(64)     not null,
  state            varchar(12)  not null default 'in_progress' check (state in ('in_progress', 'completed')),
  response         jsonb,
  created_dt       timestamptz  not null default now(),
  completed_dt     timestamptz,
  primary key (user_id, idempotency_key)
);
create index if not exists idempotency_key_created_dt_idx on formula.idempotency_key (created_dt);

-- The Vault's application role (DB_APP_ROLE on the Vault's migrate run, ra_vault in
-- provision-vault-isolation.sql) claims, completes and releases its rows. Granted explicitly rather
-- than left to that script's default privileges, which only cover tables made by the role that set
-- them. Same pattern as the main migration.
do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'vault idempotency_key grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'vault idempotency_key grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant usage on schema formula to %I', app);
  execute format('grant select, insert, update, delete on formula.idempotency_key to %I', app);
end $$;
