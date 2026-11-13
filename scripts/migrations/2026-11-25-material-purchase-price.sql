-- Migration: 2026-11-25-material-purchase-price (IMPORT-RP-COST, LD-156). Owner, 13 Nov 2026: "we just
-- haven't yet uploaded purchase price purchase discount etc purchasing is just not having data yet so
-- keep an option in interface to export materials and add purchase price and update it finance
-- console receives it which is books".
--
-- Nothing on file held a purchase price: a rate existed only on a quotation line or a PO line
-- (procurement.quotation_items.quoted_rate, purchase_order_items.rate), which is what was agreed for
-- one order, not what a material costs. procurement.material_purchase_price is that list:
--
--   one row per (material, supplier, effective date), APPEND-ONLY. A price on file is never
--   rewritten: a later date supersedes it. The application role holds SELECT and INSERT only, so
--   that is a property of the table and not a convention.
--   money is INTEGER PAISE. The list price and the discount (basis points) are what the person gave;
--   the net price is worked out once, when the row is recorded (list less discount, half up to the
--   paisa), and stored beside them, so no reader ever recomputes it.
--   vendor_id null is "no supplier named" and is its own key (the unique index folds it to a zero id).
--
-- procurement.purchase_price_setting holds the one settable figure: the change, in percent of the net
-- price in force, above which a row is listed under "large changes" in a preview.
--
-- ADDITIVE + IDEMPOTENT. Rollback: scripts/migrations/rollback/2026-11-25-material-purchase-price.down.sql

-- @target: main

create table if not exists procurement.material_purchase_price (
  material_purchase_price_id uuid         primary key,
  material_id                uuid         not null,
  vendor_id                  uuid,
  unit                       varchar(8)   not null check (unit in ('kg', 'g', 'L', 'ml', 'unit')),
  list_price_paise           bigint       not null check (list_price_paise > 0),
  discount_bps               integer      not null default 0 check (discount_bps between 0 and 10000),
  net_price_paise            bigint       not null check (net_price_paise >= 0 and net_price_paise <= list_price_paise),
  gst_rate_pct               numeric(5,2) check (gst_rate_pct is null or (gst_rate_pct >= 0 and gst_rate_pct <= 100)),
  hsn_code                   varchar(8)   check (hsn_code is null or hsn_code ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  effective_from             date         not null,
  note                       text,
  source                     varchar(8)   not null check (source in ('import', 'screen')),
  job_ref                    uuid,
  created_by                 varchar(255) not null,
  created_dt                 timestamptz  not null default now()
);
create unique index if not exists material_purchase_price_key_uq
  on procurement.material_purchase_price (material_id, coalesce(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid), effective_from);
create index if not exists material_purchase_price_material_idx on procurement.material_purchase_price (material_id, effective_from desc);

create table if not exists procurement.purchase_price_setting (
  key        varchar(60)  primary key,
  value_pct  numeric(6,2) not null check (value_pct > 0 and value_pct <= 1000),
  updated_by varchar(255),
  updated_dt timestamptz  not null default now()
);

do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'material_purchase_price grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'material_purchase_price grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant usage on schema procurement to %I', app);
  execute format('grant select, insert on procurement.material_purchase_price to %I', app);
  execute format('grant select, insert, update on procurement.purchase_price_setting to %I', app);
end $$;
