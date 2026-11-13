-- Migration: 2026-11-24-imports (IMPORT-RP). Owner, 13 Nov 2026: "an excel/spreadsheet template must
-- be there in the system so that users can download it fill it and upload it ... for ingredients, for
-- final products, for adjustment".
--
-- import_job      One row per uploaded file: the kind, the file's SHA-256 and name (the file itself is
--                 never stored), who uploaded it and when, what the preview found, and what the commit
--                 wrote. One COMMITTED job per (kind, hash): the same file twice changes nothing.
-- import_job_row  One row per spreadsheet row per phase (preview, commit): the outcome, the natural
--                 key and the problems in words. APPEND-ONLY: a commit never rewrites the preview's
--                 rows, it adds its own; the application role holds SELECT and INSERT only. The cells
--                 of a REFUSED row are kept (the rows-to-fix sheet is built from them); the cells of a
--                 row that imported are not.
-- The Vault's own database gets the same two tables in 2026-11-26-vault-imports (a file of its own,
-- as 2026-11-03-vault-idempotency-key is: one target a file, so each rollback clears one ledger row).
--
-- masterdata.material_dilution   The sheet lists 38 dilutions ("10% DPG") as ingredients with nothing
--                 saying which base and which solvent. One row per dilution: the dilution's own
--                 material, the base, the solvent, and the two shares by weight, which total 100.
-- inventory.grn_items / rm_batch_master.certificate_ref   The CoA reference of a received lot.
-- masterdata.material.density_source   A density is recorded only when measured, with where the
--                 figure came from (rule 1: no fact without its source). Null stays "not on file".
--
-- ADDITIVE + IDEMPOTENT. Main only. Rollback: scripts/migrations/rollback/2026-11-24-imports.down.sql

-- @target: main

create table if not exists platform.import_job (
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
create unique index if not exists import_job_committed_uq on platform.import_job (kind, file_sha256) where status = 'committed';
create index if not exists import_job_kind_dt_idx on platform.import_job (kind, uploaded_dt desc);
create index if not exists import_job_uploader_idx on platform.import_job (uploaded_by, uploaded_dt desc);

create table if not exists platform.import_job_row (
  import_job_id uuid        not null references platform.import_job(import_job_id),
  phase         varchar(8)  not null check (phase in ('preview', 'commit')),
  row_no        integer     not null,
  outcome       varchar(8)  not null check (outcome in ('create', 'update', 'skip', 'refuse')),
  natural_key   text        not null default '',
  label         text        not null default '',
  problems      jsonb       not null default '[]'::jsonb,
  notes         jsonb       not null default '[]'::jsonb,
  cells         jsonb,
  primary key (import_job_id, phase, row_no),
  constraint import_job_row_cells_refused_only check (cells is null or outcome = 'refuse')
);

alter table masterdata.material add column if not exists density_source text;

-- The certificate of analysis that came with a supplier's lot, beside the supplier's lot reference
-- (2026-11-23-stk-materials). Null when none came: never made up.
alter table inventory.grn_items add column if not exists certificate_ref varchar(100);
alter table inventory.rm_batch_master add column if not exists certificate_ref varchar(100);

create table if not exists masterdata.material_dilution (
  material_dilution_id uuid          primary key,
  dilution_material_id uuid          not null references masterdata.material(material_id),
  base_material_id     uuid          not null references masterdata.material(material_id),
  solvent_material_id  uuid          not null references masterdata.material(material_id),
  base_percent         numeric(9, 6) not null check (base_percent > 0 and base_percent < 100),
  solvent_percent      numeric(9, 6) not null check (solvent_percent > 0 and solvent_percent < 100),
  status               varchar(30)   not null default 'ACTIVE',
  created_by           varchar(255),
  created_dt           timestamptz   not null default now(),
  updated_by           varchar(255),
  updated_dt           timestamptz   not null default now(),
  constraint material_dilution_total_chk check (base_percent + solvent_percent = 100),
  constraint material_dilution_distinct_chk check (
    base_material_id <> solvent_material_id and dilution_material_id <> base_material_id and dilution_material_id <> solvent_material_id)
);
create unique index if not exists material_dilution_material_uq on masterdata.material_dilution (dilution_material_id);
create index if not exists material_dilution_base_idx on masterdata.material_dilution (base_material_id);

-- The application role reads and claims its jobs; rows are append-only by privilege, not convention.
do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'imports grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'imports grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant usage on schema platform to %I', app);
  execute format('grant select, insert on platform.import_job to %I', app);
  execute format('grant update (status, mode, committed_by, committed_dt, w_rows, w_create, w_update, w_skip, w_refuse) on platform.import_job to %I', app);
  execute format('grant select, insert on platform.import_job_row to %I', app);
  execute format('grant select, insert on masterdata.material_dilution to %I', app);
end $$;
