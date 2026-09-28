-- Migration: 2026-09-28-login-history (lane platform-roles)
--
-- iam.login_history — one row per sign-in ATTEMPT on this deployment, successful or refused.
-- Written by cluster-org's AuthService at every sign-in door the main box serves:
--   ALEMBIC_SSO     POST /auth/alembic-assertion with an assertion targeted at the factory or
--                   platform console
--   VAULT_STEP_UP   the same exchange targeted at the Vault console. The Vault box has no sign-in
--                   of its own (backend/api/src/vault-app.module.ts); ALEMBIC's "Open Vault" is
--                   gated behind a fresh step-up there, and the Vault console exchanges that
--                   assertion on this box.
--   PASSWORD        POST /auth/login (retired: refused unconditionally in production, and those
--                   refusals are recorded too)
-- Read by GET /v1/login-history (AuditService.loginHistory), newest first.
--
-- NO SECRETS: no assertion, access/refresh token, token hash, password or jti is ever stored.
-- `session_id` is the random per-session `sid` claim. It correlates a sign-in with later activity
-- but authenticates nothing on its own.
--
-- APPEND-ONLY, two ways:
--   1. privileges: the app role gets SELECT + INSERT only. Production's owner-wide default
--      privileges hand rawprod_app UPDATE/DELETE on every new table, so they are REVOKED
--      explicitly here, not just left ungranted.
--   2. a trigger refuses UPDATE, DELETE and TRUNCATE for every role, the owner included (the same
--      guard formula.audit_events has, 0019_adhoc_vault_audit_guard.sql).
--
-- Tenancy: single-tenant like every other iam table (no tenant_id/org_id column, no RLS; no table
-- in this database uses RLS). user_id is NOT a foreign key: a refused attempt may name no account,
-- and a user row being removed must never be blocked by, or erase, its sign-in history.
--
-- The app role is a PARAMETER (rawprod.app_role, from DB_APP_ROLE), never a name written here. It
-- behaves exactly like 2026-09-26-automation-app-role-grants.sql: unset -> NOTICE, nothing granted;
-- set to a role that does not exist -> the migration fails.
--
-- IDEMPOTENT: create ... if not exists, create or replace function, drop trigger if exists, and
-- GRANT/REVOKE are no-ops when already in place.
-- @target: main

create table if not exists iam.login_history (
  login_history_id uuid primary key default uuidv7(),
  occurred_at timestamptz not null default now(),
  -- iam.user_master.user_id when the attempt reached a known account (null for a forged/expired
  -- assertion, or an email with no account)
  user_id uuid,
  -- the email the attempt named: the verified assertion's email claim, or the typed identifier on
  -- the password door. Null when nothing trustworthy named anyone (e.g. a bad signature).
  email varchar(320),
  method varchar(20) not null,
  -- the console the assertion was minted for (factory | platform | vault); null for a password
  -- attempt or an assertion that failed verification
  console varchar(20),
  outcome varchar(10) not null,
  -- stable machine code (AUTH_FORBIDDEN, AUTH_ASSERTION_REPLAYED, LOCKED_OUT, ...) + the plain
  -- sentence the person was shown. Both null on success.
  reason_code varchar(60),
  reason varchar(500),
  ip varchar(64),
  user_agent varchar(512),
  session_id uuid,
  constraint login_history_method_ck check (method in ('ALEMBIC_SSO', 'VAULT_STEP_UP', 'PASSWORD')),
  constraint login_history_outcome_ck check (outcome in ('SUCCESS', 'REFUSED')),
  constraint login_history_reason_ck check ((outcome = 'SUCCESS') = (reason_code is null))
);

create index if not exists login_history_occurred_idx on iam.login_history (occurred_at desc, login_history_id desc);
create index if not exists login_history_user_idx on iam.login_history (user_id, occurred_at desc);

create or replace function iam.login_history_append_only()
  returns trigger language plpgsql as $$
  begin
    raise exception 'iam.login_history is append-only — % is blocked', tg_op;
  end $$;

drop trigger if exists login_history_append_only on iam.login_history;
create trigger login_history_append_only
  before update or delete on iam.login_history
  for each row execute function iam.login_history_append_only();

drop trigger if exists login_history_no_truncate on iam.login_history;
create trigger login_history_no_truncate
  before truncate on iam.login_history
  for each statement execute function iam.login_history_append_only();

do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'login_history grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'login_history grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant usage on schema iam to %I', app);
  execute format('revoke update, delete, truncate on iam.login_history from %I', app);
  execute format('grant select, insert on iam.login_history to %I', app);
end $$;
