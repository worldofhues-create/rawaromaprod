-- Migration: 2026-11-07-floor-gaps (lane floor-gaps, production-floor plan §1, §6, §12.2, §13;
-- owner-approved 2026-11-05). FLOOR-1..n.
--
-- ADDITIVE + IDEMPOTENT ONLY (PB-16 convention): every statement is IF NOT EXISTS or guarded.
--
--   inventory.lot_split       R8: a lot split across two bins, or a partial lot back from the
--                             verifier. Each row is one child lot (its own inventory_batch row, its
--                             own L- code) cut from a parent, the exact milligrams moved and why. The
--                             child keeps the parent's RM batch, so its QC result, hold and expiry
--                             (FEFO) are the parent's: a split never re-dates or re-releases a lot.
--   inventory.lot_label       R8: the child lot's label. The first print is logged; every later one
--                             is a REPRINT with a reason and the person (a duplicate lot label is a
--                             recall risk).
--   location.fg_zone_style    F7: an FG rack zone's colour (hex + a plain colour NAME) and initials,
--                             set by the admin. The name and the initials are always printed with
--                             the colour, so colour is never the only signal.
--
-- Rollback: scripts/migrations/rollback/2026-11-07-floor-gaps.down.sql
-- New permission codes come from scripts/ra-permissions.ts / ra-roles.ts; production applies
-- docs/releases/floor-gaps-2026-11-07-permission-grants.sql, never db:seed.

-- @target: main

create table if not exists inventory.lot_split (
  lot_split_id              uuid primary key default gen_random_uuid(),
  kind                      varchar(10) not null check (kind in ('SPLIT', 'RETURN')),
  parent_inventory_batch_id uuid not null,
  child_inventory_batch_id  uuid not null unique,
  rm_batch_id               uuid not null,
  qty_mg                    bigint not null check (qty_mg > 0),
  parent_before_mg          bigint not null check (parent_before_mg >= qty_mg),
  from_location_id          uuid,
  to_location_id            uuid not null,
  floor_job_id              uuid,
  reason                    text,
  created_by                varchar(255) not null,
  created_dt                timestamptz not null default now(),
  check (parent_inventory_batch_id <> child_inventory_batch_id),
  -- a return from the verifier always names the job it came back from
  check (kind <> 'RETURN' or floor_job_id is not null)
);
create index if not exists lot_split_parent_idx on inventory.lot_split (parent_inventory_batch_id);

create table if not exists inventory.lot_label (
  lot_label_id       uuid primary key default gen_random_uuid(),
  inventory_batch_id uuid not null,
  barcode            varchar(12) not null,
  reprint            boolean not null default false,
  reason             text,
  printed_by         varchar(255) not null,
  printed_dt         timestamptz not null default now(),
  check (not reprint or (reason is not null and btrim(reason) <> ''))
);
create index if not exists lot_label_batch_idx on inventory.lot_label (inventory_batch_id);

create table if not exists location.fg_zone_style (
  zone_id      uuid primary key,
  colour_name  varchar(30) not null check (colour_name ~ '^[A-Za-z]+$'),
  colour_hex   varchar(7)  not null check (colour_hex ~ '^#[0-9A-F]{6}$'),
  initials     varchar(3)  not null check (initials ~ '^[A-Z]{1,3}$'),
  updated_by   varchar(255) not null,
  updated_dt   timestamptz not null default now()
);
create unique index if not exists fg_zone_style_colour_uq on location.fg_zone_style (upper(colour_name));
create unique index if not exists fg_zone_style_initials_uq on location.fg_zone_style (initials);

-- The application role: the same grant pattern as 2026-11-05-pfa-floor. Split and label rows are
-- append-only by privilege: no UPDATE, no DELETE.
do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'floor-gaps grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'floor-gaps grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant usage on schema inventory, location to %I', app);
  execute format('grant select, insert on inventory.lot_split, inventory.lot_label to %I', app);
  execute format('grant select, insert, update on location.fg_zone_style to %I', app);
end $$;
