-- Migration: 2026-11-17-prom-3-reference (PROM-3, LD-85). The storefront prints "Every batch is checked
-- against a retained reference before it ships" and "QC 1 ... compared with the retained reference for
-- its code and grade". Before this nothing defined a reference (a REFERENCE checkpoint compared against
-- a sentence), nothing required the comparison, the release read a typed production_qc PASS, and QC 1
-- and QC 2 were told apart only by time. Now:
--
--   quality.reference_standard   one ACTIVE retained reference per product, from a batch that passed
--                                QC on every checkpoint, with its retained sample; two people.
--   quality.batch_qc_round       the stage (QC1 / QC2) and the reference each round compared with, or
--                                NO_REFERENCE_YET for a product that has none to compare with.
--   platform.policy              qc.reference_required, v1 = required (the rounds are the verdict).
--
-- No reference is seeded: a reference is a physical bottle QC proposes. ADDITIVE + IDEMPOTENT.
-- Rollback: scripts/migrations/rollback/2026-11-17-prom-3-reference.down.sql

-- @target: main

-- PROM-3: the retained reference for a product (one product row = one code and grade in RawProd), and
-- the stage each QC round is taken at. One ACTIVE reference per product; proposed by QC, approved by a
-- DIFFERENT person (the constraint, not only the service); retiring one names its successor.
create table if not exists quality.reference_standard (
  reference_standard_id  uuid primary key default gen_random_uuid(),
  reference_code         varchar(80) not null unique,
  product_id             uuid not null,
  oil_batch_id           uuid not null,
  qc_sample_retention_id uuid not null,
  formula_version_ref    uuid,
  status                 varchar(10) not null check (status in ('PENDING', 'ACTIVE', 'RETIRED', 'DECLINED')),
  proposed_by            varchar(255) not null,
  proposed_dt            timestamptz not null default clock_timestamp(),
  proposal_reason        text not null check (btrim(proposal_reason) <> ''),
  approved_by            varchar(255),
  approved_dt            timestamptz,
  expires_at             timestamptz,
  replaces_id            uuid references quality.reference_standard (reference_standard_id),
  retired_by             varchar(255),
  retired_dt             timestamptz,
  retired_reason         text,
  successor_id           uuid references quality.reference_standard (reference_standard_id),
  declined_by            varchar(255),
  declined_dt            timestamptz,
  declined_reason        text,
  constraint reference_standard_two_people_chk check (approved_by is null or approved_by <> proposed_by),
  constraint reference_standard_active_approved_chk check (status not in ('ACTIVE', 'RETIRED') or (approved_by is not null and approved_dt is not null)),
  constraint reference_standard_retired_says_why_chk check (status <> 'RETIRED' or (retired_reason is not null and btrim(retired_reason) <> '' and successor_id is not null)),
  constraint reference_standard_declined_says_why_chk check (status <> 'DECLINED' or (declined_reason is not null and btrim(declined_reason) <> ''))
);
create unique index if not exists reference_standard_one_active_uq on quality.reference_standard (product_id) where status = 'ACTIVE';
create unique index if not exists reference_standard_one_pending_uq on quality.reference_standard (product_id) where status = 'PENDING';
create index if not exists reference_standard_batch_idx on quality.reference_standard (oil_batch_id);

alter table quality.batch_qc_round add column if not exists stage varchar(3) check (stage in ('QC1', 'QC2'));
alter table quality.batch_qc_round add column if not exists reference_standard_id uuid references quality.reference_standard (reference_standard_id);
alter table quality.batch_qc_round add column if not exists reference_basis varchar(20) check (reference_basis in ('REFERENCE', 'NO_REFERENCE_YET'));
alter table quality.batch_qc_round drop constraint if exists batch_qc_round_reference_basis_chk;
alter table quality.batch_qc_round add constraint batch_qc_round_reference_basis_chk
  check ((reference_basis = 'REFERENCE') = (reference_standard_id is not null));

-- QC 1 may now be a round rather than a typed production_qc reading.
alter table production.maceration_run alter column qc1_production_qc_id drop not null;
alter table production.maceration_run add column if not exists qc1_round_id uuid;

insert into platform.policy (policy_key, title, description) values
  ('qc.reference_required', 'QC against the retained reference', 'QC 1 and QC 2 are rounds on the product''s checkpoints, which include a comparison with its retained reference; a typed QC result does not release a batch.')
on conflict (policy_key) do nothing;
insert into platform.policy_version (policy_key, version, body, reason, created_by) values
  ('qc.reference_required', 1, '{"rules":[],"hasDefault":true,"defaultValue":{"required":true}}',
   'Owner LD-85, 13 Nov 2026: every batch is checked against a retained reference before it ships', 'system')
on conflict (policy_key, version) do nothing;

do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'prom-3 grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'prom-3 grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  -- A reference is never deleted: it is retired (naming its successor) or declined.
  execute format('grant select, insert, update on quality.reference_standard to %I', app);
end $$;
