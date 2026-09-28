-- Migration: 2026-09-28-compliance-documents (lane compliance-rp; owner rulings 2026-09-28)
--
-- ADDITIVE + IDEMPOTENT ONLY (PB-16 convention): every statement is IF NOT EXISTS or a guarded DO
-- block, so a second run is a no-op. Two blocks, two databases:
--
--   @target: main     COA data from factory QC, per finished (oil) batch
--     production.product_qc_spec       per product: specific gravity 20/4 °C min/max, flash point
--                                      (Pensky-Martens closed cup) min/max °C, shelf life (months)
--     production.batch_coa             per oil batch: results against the spec snapshot, colour &
--                                      appearance, odour, production date, best-before, pass/fail
--                                      per test and overall, and the release (who/when)
--     production.batch_coa_photo       the batch's photos: a platform.document_master reference
--                                      and/or an http(s) URL, with a caption
--     bridge.compliance_certificate    the main box's copy of each certificate the Vault calculated
--                                      (numbers only; pulled over the signed internal channel)
--     bridge.compliance_certificate_emission  one row per (certificate, product) emitted to ALEMBIC
--     bridge.vault_sync_cursor         the last Vault certificate seq this box has pulled
--
--   @target: formula  the Vault's raw-material compliance data + calculated certificates
--     (see packages/data-formula/src/schema/compliance.ts for each table's role). NOTHING is
--     seeded: the regulated allergen list, raw-material allergen composition and the IFRA
--     standards data are entered/imported by the regulatory team (IFRA standards content is
--     licensed data the owner supplies). docs/compliance/allergen-reference-DRAFT.csv is a
--     transcription of the owner's sample certificate for the team to confirm and import.
--
-- App-role grants for the main tables follow 2026-09-26-automation-app-role-grants.sql: the role
-- is the DB_APP_ROLE parameter (`rawprod.app_role`), never a literal; unset -> notice, no grant.
-- The formula schema already default-grants ra_vault (scripts/provision-vault-isolation.sql).

-- @target: main

create table if not exists production.product_qc_spec (
  product_qc_spec_id uuid primary key default uuidv7(),
  product_id uuid not null,
  sg_min numeric(8,4) not null,
  sg_max numeric(8,4) not null,
  flash_point_min_c numeric(6,1) not null,
  flash_point_max_c numeric(6,1) not null,
  shelf_life_months integer not null,
  colour_appearance_standard text,
  odour_standard text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists product_qc_spec_product_uq on production.product_qc_spec (product_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'product_qc_spec_ranges_chk') then
    alter table production.product_qc_spec add constraint product_qc_spec_ranges_chk
      check (sg_min > 0 and sg_min <= sg_max and flash_point_min_c <= flash_point_max_c and shelf_life_months between 1 and 240);
  end if;
end $$;

create table if not exists production.batch_coa (
  batch_coa_id uuid primary key default uuidv7(),
  oil_batch_id uuid not null,
  product_id uuid not null,
  sg_result numeric(8,4) not null,
  sg_spec_min numeric(8,4) not null,
  sg_spec_max numeric(8,4) not null,
  sg_pass boolean not null,
  flash_point_result_c numeric(6,1) not null,
  flash_point_spec_min_c numeric(6,1) not null,
  flash_point_spec_max_c numeric(6,1) not null,
  flash_point_pass boolean not null,
  colour_appearance text not null,
  colour_appearance_pass boolean not null,
  odour_description text not null,
  odour_pass boolean not null,
  production_date date not null,
  best_before date not null,
  overall_result varchar(10) not null,
  tested_by uuid,
  tested_dt timestamptz not null default now(),
  released_by uuid,
  released_dt timestamptz,
  status varchar(30) not null,
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists batch_coa_oil_batch_uq on production.batch_coa (oil_batch_id);
create index if not exists batch_coa_product_idx on production.batch_coa (product_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'batch_coa_state_chk') then
    alter table production.batch_coa add constraint batch_coa_state_chk check (
      overall_result in ('PASS', 'FAIL')
      and status in ('TESTED', 'RELEASED')
      and (status <> 'RELEASED' or (overall_result = 'PASS' and released_dt is not null and released_by is not null))
      and best_before > production_date
    );
  end if;
end $$;

create table if not exists production.batch_coa_photo (
  batch_coa_photo_id uuid primary key default uuidv7(),
  batch_coa_id uuid not null references production.batch_coa (batch_coa_id),
  document_id uuid,
  url text,
  caption varchar(200),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create index if not exists batch_coa_photo_coa_idx on production.batch_coa_photo (batch_coa_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'batch_coa_photo_ref_chk') then
    alter table production.batch_coa_photo add constraint batch_coa_photo_ref_chk
      check (document_id is not null or url is not null);
  end if;
end $$;

create table if not exists bridge.compliance_certificate (
  certificate_id uuid primary key,
  vault_seq bigint not null,
  formula_id uuid not null,
  formula_version_ref varchar(80) not null,
  kind varchar(10) not null,
  amendment varchar(60),
  cert_values jsonb not null,
  calculated_at timestamptz not null,
  received_at timestamptz not null default now()
);
create unique index if not exists bridge_compliance_certificate_seq_uq on bridge.compliance_certificate (vault_seq);
create index if not exists bridge_compliance_certificate_formula_kind_idx on bridge.compliance_certificate (formula_id, kind, vault_seq);

create table if not exists bridge.compliance_certificate_emission (
  emission_id uuid primary key default uuidv7(),
  certificate_id uuid not null,
  product_id uuid not null,
  emitted_at timestamptz not null default now()
);
create unique index if not exists bridge_compliance_certificate_emission_uq
  on bridge.compliance_certificate_emission (certificate_id, product_id);

create table if not exists bridge.vault_sync_cursor (
  id varchar(50) primary key,
  last_seq bigint not null default 0,
  updated_at timestamptz not null default now()
);

do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
  t text;
begin
  if app is null then
    raise notice 'compliance grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'compliance grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  foreach t in array array[
    'production.product_qc_spec', 'production.batch_coa', 'production.batch_coa_photo',
    'bridge.compliance_certificate', 'bridge.compliance_certificate_emission', 'bridge.vault_sync_cursor'
  ] loop
    execute format('grant select, insert, update, delete on table %s to %I', t, app);
  end loop;
end $$;

-- @target: formula

create table if not exists formula.rm_compliance_profile (
  rm_compliance_profile_id uuid primary key default uuidv7(),
  material_id uuid not null,
  allergen_complete boolean not null default false,
  ifra_complete boolean not null default false,
  ifra_amendment varchar(20),
  source_ref text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists rm_compliance_profile_material_uq on formula.rm_compliance_profile (material_id);

create table if not exists formula.rm_allergen_composition (
  rm_allergen_composition_id uuid primary key default uuidv7(),
  material_id uuid not null,
  cas varchar(20) not null,
  natural_pct numeric(9,6) not null default 0,
  synthetic_pct numeric(9,6) not null default 0,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists rm_allergen_composition_material_cas_uq on formula.rm_allergen_composition (material_id, cas);
create index if not exists rm_allergen_composition_cas_idx on formula.rm_allergen_composition (cas);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'rm_allergen_composition_pct_chk') then
    alter table formula.rm_allergen_composition add constraint rm_allergen_composition_pct_chk check (
      natural_pct >= 0 and synthetic_pct >= 0 and natural_pct + synthetic_pct <= 100
    );
  end if;
end $$;

create table if not exists formula.rm_ifra_restriction (
  rm_ifra_restriction_id uuid primary key default uuidv7(),
  material_id uuid not null,
  amendment varchar(20) not null,
  category varchar(4) not null,
  restriction_type varchar(20) not null,
  max_pct numeric(9,6),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists rm_ifra_restriction_material_category_uq on formula.rm_ifra_restriction (material_id, category);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'rm_ifra_restriction_type_chk') then
    alter table formula.rm_ifra_restriction add constraint rm_ifra_restriction_type_chk check (
      restriction_type in ('RESTRICTED', 'PROHIBITED', 'SPECIFICATION')
      and category in ('1','2','3','4','5A','5B','5C','5D','6','7A','7B','8','9','10A','10B','11A','11B','12')
      and (restriction_type <> 'RESTRICTED' or (max_pct is not null and max_pct >= 0 and max_pct <= 100))
    );
  end if;
end $$;

create table if not exists formula.compliance_allergen_ref (
  compliance_allergen_ref_id uuid primary key default uuidv7(),
  cas varchar(20) not null,
  name varchar(200) not null,
  sort_order integer not null default 0,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists compliance_allergen_ref_cas_uq on formula.compliance_allergen_ref (cas);

create table if not exists formula.compliance_setting (
  setting_key varchar(60) primary key,
  setting_value text,
  updated_dt timestamptz not null default now(),
  updated_by varchar(255)
);

create table if not exists formula.compliance_certificate (
  certificate_id uuid primary key default uuidv7(),
  seq bigint generated always as identity,
  formula_id uuid not null,
  formula_version_id uuid not null,
  formula_version_ref varchar(80) not null,
  kind varchar(10) not null,
  amendment varchar(60),
  cert_values jsonb not null,
  values_digest varchar(64) not null,
  calculated_at timestamptz not null default now(),
  calc_trigger varchar(40),
  created_by varchar(255)
);
create unique index if not exists compliance_certificate_seq_uq on formula.compliance_certificate (seq);
create index if not exists compliance_certificate_formula_kind_idx on formula.compliance_certificate (formula_id, kind);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'compliance_certificate_kind_chk') then
    alter table formula.compliance_certificate add constraint compliance_certificate_kind_chk check (kind in ('ifra', 'allergen'));
  end if;
end $$;

create table if not exists formula.compliance_calc_status (
  formula_id uuid not null,
  kind varchar(10) not null,
  formula_version_id uuid,
  outcome varchar(20) not null,
  missing_count integer not null default 0,
  last_certificate_id uuid,
  calculated_at timestamptz not null default now(),
  primary key (formula_id, kind)
);
