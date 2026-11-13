-- Migration: 2026-11-18-prom-5-material-change (PROM-5, LD-85). The storefront prints "Reorder the same
-- code, grade and pack, and get the same oil" and "If a raw material changes, we tell you before your next
-- order"; the owner: "it has to be true". Before this, nothing defined "the same oil" and nothing recorded a
-- change of material: the only signal was an owner email on a formula version, and RawProd email is off.
--
--   production.batch_continuity     each oil batch's continuity key (formula version, raw-material
--                                   identities with their suppliers, the active reference), or null and why
--   production.product_continuity   a product's continuity over time; the latest row is current
--   production.material_change      one row per kind of change (formula_version | supplier | reference),
--                                   with the old and new keys and the first batch it applies to
--   platform.policy continuity.supplier_change_is_material   v1 = { isMaterial: true } (OQ-PROM-5)
--
-- ADDITIVE + IDEMPOTENT. Batches made before this have no row: their lots read "Not on file".
-- Rollback: scripts/migrations/rollback/2026-11-18-prom-5-material-change.down.sql

-- @target: main

-- One row per oil batch: its continuity key, or NULL with what was missing (Rule 3: no key, no claim).
create table if not exists production.batch_continuity (
  oil_batch_id          uuid primary key,
  product_id            uuid,
  continuity_key        varchar(68) check (continuity_key is null or continuity_key ~ '^ck1:[0-9a-f]{64}$'),
  formula_version_ref   uuid,
  reference_ref         varchar(80),
  supplier_is_material  boolean not null,
  supplier_rule_version integer not null check (supplier_rule_version >= 0),
  missing               jsonb,
  recorded_by           varchar(255) not null,
  recorded_dt           timestamptz not null default clock_timestamp(),
  constraint batch_continuity_key_or_why_chk check ((continuity_key is null) = (missing is not null))
);
create index if not exists batch_continuity_product_idx on production.batch_continuity (product_id, recorded_dt desc);

-- A product's continuity over time; the latest row is current. Append-only.
create table if not exists production.product_continuity (
  product_continuity_id uuid primary key default gen_random_uuid(),
  product_id            uuid not null,
  continuity_key        varchar(68) not null check (continuity_key ~ '^ck1:[0-9a-f]{64}$'),
  formula_version_ref   uuid not null,
  materials             jsonb not null,
  materials_hash        varchar(64) not null,
  reference_ref         varchar(80),
  source                varchar(10) not null check (source in ('batch', 'reference')),
  first_oil_batch_id    uuid,
  effective_from        timestamptz not null,
  recorded_by           varchar(255) not null,
  created_dt            timestamptz not null default clock_timestamp(),
  constraint product_continuity_batch_named_chk check (source <> 'batch' or first_oil_batch_id is not null)
);
create index if not exists product_continuity_current_idx on production.product_continuity (product_id, created_dt desc);

-- One row per kind of change. Plain-language kind only; no material is named. Append-only.
create table if not exists production.material_change (
  material_change_id    uuid primary key default gen_random_uuid(),
  product_id            uuid not null,
  product_code          varchar(80) not null,
  kind                  varchar(20) not null check (kind in ('formula_version', 'supplier', 'reference')),
  from_key              varchar(68) not null check (from_key ~ '^ck1:[0-9a-f]{64}$'),
  to_key                varchar(68) not null check (to_key ~ '^ck1:[0-9a-f]{64}$'),
  first_oil_batch_id    uuid,
  first_batch_no        varchar(64),
  approved_at           timestamptz not null,
  recorded_by           varchar(255) not null,
  created_dt            timestamptz not null default clock_timestamp(),
  constraint material_change_moves_chk check (from_key <> to_key)
);
create index if not exists material_change_product_idx on production.material_change (product_id, created_dt desc);

insert into platform.policy (policy_key, title, description) values
  ('continuity.supplier_change_is_material', 'A supplier change is a material change', 'When a raw material comes from a different supplier than the last batch of the same code and grade, the customer is told before their next order.')
on conflict (policy_key) do nothing;

insert into platform.policy_version (policy_key, version, body, reason, created_by) values
  ('continuity.supplier_change_is_material', 1, '{"rules":[],"hasDefault":true,"defaultValue":{"isMaterial":true}}',
   'Owner LD-85, 13 Nov 2026 (OQ-PROM-5 default): if a raw material changes, we tell you before your next order; a supplier change counts', 'system')
on conflict (policy_key, version) do nothing;

-- The application role records and reads; a record is never rewritten or deleted.
do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'prom-5 grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'prom-5 grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant select, insert on production.batch_continuity to %I', app);
  execute format('grant select, insert on production.product_continuity to %I', app);
  execute format('grant select, insert on production.material_change to %I', app);
end $$;
