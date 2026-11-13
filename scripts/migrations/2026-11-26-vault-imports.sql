-- Migration: 2026-11-26-vault-imports (IMPORT-RP, Vault). The import job and its rows on the Vault's
-- own database, for the formulas import (the same shape as 2026-11-24-imports on the main database:
-- the Vault API has no path to the main database).
--
-- THE FORMULA RULE, AS A PROPERTY OF THE TABLE. On the main database a refused row keeps its cells so
-- the rows-to-fix sheet can be built from them. Here `cells` is never written at all: a formula is the
-- house's trade secret, and the CHECK below refuses a cell whatever the code does. A formula's rows to
-- fix are built from the file the uploader sends again. Rows are append-only by privilege: the
-- application role holds SELECT and INSERT only.
--
-- ADDITIVE + IDEMPOTENT. Formula target only.
-- Rollback: scripts/migrations/rollback/2026-11-26-vault-imports.down.sql

-- @target: formula

create table if not exists formula.import_job (
  import_job_id   uuid         primary key,
  kind            varchar(60)  not null,
  file_sha256     char(64)     not null,
  file_name       varchar(255),
  file_format     varchar(8)   not null check (file_format in ('csv', 'xlsx')),
  uploaded_by     varchar(255) not null,
  uploaded_dt     timestamptz  not null default now(),
  status          varchar(12)  not null check (status in ('previewed', 'committed', 'refused')),
  mode            varchar(16)  check (mode in ('all_or_nothing', 'valid_only')),
  n_rows integer not null default 0, n_create integer not null default 0, n_update integer not null default 0,
  n_skip integer not null default 0, n_refuse integer not null default 0,
  file_problems   jsonb        not null default '[]'::jsonb,
  ignored_columns jsonb        not null default '[]'::jsonb,
  committed_by    varchar(255),
  committed_dt    timestamptz,
  w_rows integer, w_create integer, w_update integer, w_skip integer, w_refuse integer
);
create unique index if not exists import_job_committed_uq on formula.import_job (kind, file_sha256) where status = 'committed';
create index if not exists import_job_kind_dt_idx on formula.import_job (kind, uploaded_dt desc);
create index if not exists import_job_uploader_idx on formula.import_job (uploaded_by, uploaded_dt desc);

create table if not exists formula.import_job_row (
  import_job_id uuid        not null references formula.import_job(import_job_id),
  phase         varchar(8)  not null check (phase in ('preview', 'commit')),
  row_no        integer     not null,
  outcome       varchar(8)  not null check (outcome in ('create', 'update', 'skip', 'refuse')),
  natural_key   text        not null default '',
  label         text        not null default '',
  problems      jsonb       not null default '[]'::jsonb,
  notes         jsonb       not null default '[]'::jsonb,
  cells         jsonb,
  primary key (import_job_id, phase, row_no),
  -- The formula rule: no cell of an uploaded formula is ever kept on a job row.
  constraint import_job_row_no_cells check (cells is null)
);

do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'vault imports grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'vault imports grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant usage on schema formula to %I', app);
  execute format('grant select, insert on formula.import_job to %I', app);
  execute format('grant update (status, mode, committed_by, committed_dt, w_rows, w_create, w_update, w_skip, w_refuse) on formula.import_job to %I', app);
  execute format('grant select, insert on formula.import_job_row to %I', app);
end $$;
