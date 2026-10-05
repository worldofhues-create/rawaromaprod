-- Migration: 2026-10-05-factory-setup (lane catalogue; owner decisions 2026-10-05)
--
-- "We already have inventory — build the factory data and let Ruh/ARIA predict and apply it."
-- Products are mostly blended in-house. Approval model: Ruh drafts, one person approves.
--
-- ADDITIVE + IDEMPOTENT ONLY (PB-16 convention): every statement is IF NOT EXISTS or a guarded DO
-- block, so a second run is a no-op.
--
--   main database:
--     bridge.catalogue_item     ALEMBIC's catalogue as the factory holds it: one row per ALEMBIC
--                               SKU (keyed by ALEMBIC's SKU id), the factory SKU code (== the
--                               ALEMBIC code), single chemical or blend and why, the CAS number
--                               and the dangerous-goods facts ONLY as ALEMBIC holds them, with
--                               their source, the pack sizes measured, kilos on hand, and the ids
--                               of the material / floor code / product / product SKU this box made
--                               or linked for it. Written only by the signed catalogue endpoint.
--                               The Vault lane reads classification + material ids from here.
--     production.setup_proposal Ruh's drafts awaiting one person: a QC spec per product, a rack
--                               layout. Each names its source ('document' | 'catalogue fact' |
--                               'estimate'), the evidence, who decided and when. Nothing reads a
--                               'proposed' row as a spec or a rack.

-- @target: main

create table if not exists bridge.catalogue_item (
  alembic_sku_id uuid primary key,
  sku_code varchar(50) not null,
  name text not null,
  category varchar(100),
  classification varchar(20) not null,
  classification_basis text not null,
  grade varchar(50),
  cas_number text,
  cas_source text,
  density_mg_per_ml integer,
  density_source text,
  hazmat jsonb not null default '{}'::jsonb,
  pack_sizes jsonb not null default '[]'::jsonb,
  on_hand_kg numeric(18,4) not null default 0,
  material_id uuid,
  material_owned boolean not null default false,
  rm_alias_id uuid,
  floor_code varchar(30),
  product_id uuid,
  product_sku_id uuid,
  note text,
  first_synced_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  synced_by varchar(255) not null
);
create unique index if not exists catalogue_item_sku_code_uq on bridge.catalogue_item (sku_code);
create index if not exists catalogue_item_product_idx on bridge.catalogue_item (product_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'catalogue_item_classification_chk') then
    alter table bridge.catalogue_item add constraint catalogue_item_classification_chk
      check (classification in ('single_chemical', 'blend'));
  end if;
  -- A CAS number travels with the source it is held under, or not at all.
  if not exists (select 1 from pg_constraint where conname = 'catalogue_item_cas_sourced_chk') then
    alter table bridge.catalogue_item add constraint catalogue_item_cas_sourced_chk
      check (cas_number is null or (cas_source is not null and btrim(cas_source) <> ''));
  end if;
end $$;

create table if not exists production.setup_proposal (
  setup_proposal_id uuid primary key default uuidv7(),
  kind varchar(20) not null,
  product_id uuid,
  subject_label text not null,
  payload jsonb not null,
  source varchar(20) not null,
  evidence text not null,
  proposer varchar(50) not null default 'Ruh',
  status varchar(20) not null default 'proposed',
  proposed_dt timestamptz not null default now(),
  proposed_by varchar(255),
  decided_by varchar(255),
  decided_dt timestamptz,
  decision_note text,
  applied jsonb
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'setup_proposal_kind_chk') then
    alter table production.setup_proposal add constraint setup_proposal_kind_chk check (kind in ('qc_spec', 'rack_layout'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'setup_proposal_source_chk') then
    alter table production.setup_proposal add constraint setup_proposal_source_chk check (source in ('document', 'catalogue fact', 'estimate'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'setup_proposal_status_chk') then
    alter table production.setup_proposal add constraint setup_proposal_status_chk check (status in ('proposed', 'approved', 'rejected', 'superseded'));
  end if;
  -- A decision has a person and an instant, or it is not a decision.
  if not exists (select 1 from pg_constraint where conname = 'setup_proposal_decided_chk') then
    alter table production.setup_proposal add constraint setup_proposal_decided_chk
      check ((status in ('approved', 'rejected')) = (decided_by is not null and decided_dt is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'setup_proposal_qc_has_product_chk') then
    alter table production.setup_proposal add constraint setup_proposal_qc_has_product_chk
      check (kind <> 'qc_spec' or product_id is not null);
  end if;
end $$;
-- One open draft per product (QC) and one open rack layout: asking again never stacks drafts.
create unique index if not exists setup_proposal_open_qc_uq on production.setup_proposal (product_id)
  where status = 'proposed' and kind = 'qc_spec';
create unique index if not exists setup_proposal_open_rack_uq on production.setup_proposal (kind)
  where status = 'proposed' and kind = 'rack_layout';
create index if not exists setup_proposal_status_idx on production.setup_proposal (kind, status);

do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
  t text;
begin
  if app is null then
    raise notice 'factory-setup grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'factory-setup grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  foreach t in array array['bridge.catalogue_item', 'production.setup_proposal'] loop
    execute format('grant select, insert, update, delete on table %s to %I', t, app);
  end loop;
end $$;
