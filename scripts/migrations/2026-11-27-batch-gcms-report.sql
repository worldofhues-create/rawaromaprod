-- Migration: 2026-11-27-batch-gcms-report (FACTORY-DOCS). A lab's GC-MS report for one finished oil
-- batch, attached by QC on the batch certificate screen and sent to ALEMBIC as `qc.gcms.attached`
-- (ALEMBIC docs/plan/program/documents-automation.md > "What RawProd must send", fact 3).
--
-- RawProd had no binary store (platform.document_registry and document_master hold a label and a link,
-- never bytes), and ALEMBIC must fetch the PDF itself and check its SHA-256. So the bytes live here, in
-- the main database next to the batch COA, and are served only through a signed, expiring link the
-- bridge relay mints at each delivery attempt (api bridge/gcms-file.controller.ts).
--
-- (oil_batch_id, sha256) is unique: attaching the same file to the same batch again records nothing
-- and sends nothing (ALEMBIC's own idempotency pair is batch_no + sha256). A report is never edited or
-- deleted by the application; a corrected report is a new file, which ALEMBIC versions by attached_at.
-- Rollback: scripts/migrations/rollback/2026-11-27-batch-gcms-report.down.sql

-- @target: main

create table if not exists production.batch_gcms_report (
  batch_gcms_report_id uuid         primary key,
  batch_coa_id         uuid         not null references production.batch_coa (batch_coa_id),
  oil_batch_id         uuid         not null,
  sha256               char(64)     not null check (sha256 ~ '^[0-9a-f]{64}$'),
  pdf                  bytea        not null,
  byte_size            integer      not null check (byte_size > 0 and byte_size <= 5242880),
  file_name            varchar(200),
  lab_name             varchar(200) not null check (length(btrim(lab_name)) > 0),
  report_ref           varchar(120) not null check (length(btrim(report_ref)) > 0),
  analysed_on          date         not null,
  attached_by          varchar(255) not null,
  attached_dt          timestamptz  not null default now()
);
create unique index if not exists batch_gcms_report_batch_sha_uq on production.batch_gcms_report (oil_batch_id, sha256);
create index if not exists batch_gcms_report_coa_idx on production.batch_gcms_report (batch_coa_id, attached_dt desc);

-- The application role attaches and reads reports; a report is append-only by privilege, not convention
-- (no UPDATE, no DELETE: a corrected report is a new file).
do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'batch-gcms-report grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'batch-gcms-report grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant usage on schema production to %I', app);
  execute format('grant select, insert on production.batch_gcms_report to %I', app);
end $$;
