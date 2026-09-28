-- Migration: 2026-09-29-produce (lane produce; owner requirement + decisions 2026-09-29)
--
-- ADDITIVE + IDEMPOTENT (PB-16 convention): every statement is IF NOT EXISTS or a guarded DO
-- block, so a second run is a no-op. Main database only — nothing changes in the Vault's DB.
--
--   bridge.production_requirement  + the fields ALEMBIC (lane/fulfil) adds to a requirement:
--                                    priority rank/reason/order value, order refs, qty in kg,
--                                    lot policy; + the produce block reason and the overdue-alert
--                                    stamp. The ranked production queue index.
--   bridge.compliance_certificate  + formula_version_number (DOCS-001 prints "formula v3").
--   production.batch_coa           + QC's FAIL verdict (status REJECTED, who/when/why). The state
--                                    check is replaced so REJECTED is a legal state.
--   production.produce_alert       the consoles' live alert log (badge/toast/sound).
--   packaging.product_dg_info      DG/hazard details a finished-good label prints where set.
--   location.rack_walk_order       rack walking order for put-away/pick sheets and the shelf display.
--   location.shelf_task            put-away / pick / move tasks at the physical shelves.
--   location.fg_bin_stock          which bin each finished-good batch is on.
--   location.pick_light_config     the pick-to-light controller (in-app, no .env).
--   location.pick_light_command    the light-command queue the worker delivers.
--   location.pick_light_sim_state  the built-in pick-to-light simulator.
--
-- App-role grants follow 2026-09-26-automation-app-role-grants.sql: the role is the DB_APP_ROLE
-- parameter (`rawprod.app_role`), never a literal; unset -> notice, no grant.
-- The two new permissions (location:shelf_task:read|write) are seeded by `pnpm db:seed`
-- (scripts/ra-permissions.ts / ra-roles.ts) — re-run it after this migration.

-- @target: main

alter table bridge.production_requirement add column if not exists priority_rank integer;
alter table bridge.production_requirement add column if not exists priority_reason varchar(30);
alter table bridge.production_requirement add column if not exists order_value_inr numeric(18,2);
alter table bridge.production_requirement add column if not exists order_refs jsonb;
alter table bridge.production_requirement add column if not exists qty_kg numeric(18,4);
alter table bridge.production_requirement add column if not exists lot_policy varchar(20);
alter table bridge.production_requirement add column if not exists produce_block_reason varchar(60);
alter table bridge.production_requirement add column if not exists produce_blocked_at timestamptz;
alter table bridge.production_requirement add column if not exists overdue_alerted_at timestamptz;
create index if not exists bridge_production_requirement_queue_idx
  on bridge.production_requirement (priority_rank, needed_by, created_dt);

alter table bridge.compliance_certificate add column if not exists formula_version_number integer;

alter table production.batch_coa add column if not exists rejected_by uuid;
alter table production.batch_coa add column if not exists rejected_dt timestamptz;
alter table production.batch_coa add column if not exists reject_reason text;
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'batch_coa_state_chk'
               and pg_get_constraintdef(oid) not like '%REJECTED%') then
    alter table production.batch_coa drop constraint batch_coa_state_chk;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'batch_coa_state_chk') then
    alter table production.batch_coa add constraint batch_coa_state_chk check (
      overall_result in ('PASS', 'FAIL')
      and status in ('TESTED', 'RELEASED', 'REJECTED')
      and (status <> 'RELEASED' or (overall_result = 'PASS' and released_dt is not null and released_by is not null))
      and (status <> 'REJECTED' or (rejected_dt is not null and rejected_by is not null))
      and best_before > production_date
    );
  end if;
end $$;

create table if not exists production.produce_alert (
  produce_alert_id uuid primary key default uuidv7(),
  seq bigint generated always as identity,
  kind varchar(40) not null,
  severity varchar(10) not null,
  title text not null,
  detail text,
  roles text[] not null,
  ref_type varchar(40),
  ref_id uuid,
  dedupe_key varchar(200) not null,
  created_at timestamptz not null default now()
);
create unique index if not exists produce_alert_dedupe_uq on production.produce_alert (dedupe_key);
create unique index if not exists produce_alert_seq_uq on production.produce_alert (seq);
create index if not exists produce_alert_created_idx on production.produce_alert (created_at);

create table if not exists packaging.product_dg_info (
  product_dg_info_id uuid primary key default uuidv7(),
  product_id uuid not null,
  un_number varchar(10),
  proper_shipping_name text,
  dg_class varchar(10),
  packing_group varchar(5),
  signal_word varchar(20),
  hazard_statements text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists product_dg_info_product_uq on packaging.product_dg_info (product_id);

create table if not exists location.rack_walk_order (
  rack_id uuid primary key references location.rack_master (rack_id),
  walk_seq integer not null,
  updated_dt timestamptz not null default now(),
  updated_by varchar(255)
);

create table if not exists location.shelf_task (
  shelf_task_id uuid primary key default uuidv7(),
  seq bigint generated always as identity,
  kind varchar(10) not null,
  finished_good_batch_id uuid not null,
  product_sku_id uuid,
  qty numeric(18,4) not null,
  uom_id uuid,
  from_bin_id uuid references location.bin_master (bin_id),
  to_bin_id uuid references location.bin_master (bin_id),
  alembic_requirement_id uuid,
  reference varchar(100),
  priority_rank integer,
  completed_by uuid,
  completed_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists shelf_task_seq_uq on location.shelf_task (seq);
create index if not exists shelf_task_status_idx on location.shelf_task (status, kind);
create index if not exists shelf_task_fg_idx on location.shelf_task (finished_good_batch_id);
create index if not exists shelf_task_to_bin_idx on location.shelf_task (to_bin_id);
create index if not exists shelf_task_from_bin_idx on location.shelf_task (from_bin_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shelf_task_shape_chk') then
    alter table location.shelf_task add constraint shelf_task_shape_chk check (
      kind in ('PUTAWAY', 'PICK', 'MOVE')
      and status in ('OPEN', 'DONE', 'CANCELLED')
      and qty > 0
      and (kind <> 'PICK' or from_bin_id is not null)
      and (kind <> 'MOVE' or (from_bin_id is not null and to_bin_id is not null))
      and (status <> 'DONE' or completed_dt is not null)
    );
  end if;
end $$;

create table if not exists location.fg_bin_stock (
  fg_bin_stock_id uuid primary key default uuidv7(),
  finished_good_batch_id uuid not null,
  bin_id uuid not null references location.bin_master (bin_id),
  qty numeric(18,4) not null,
  uom_id uuid,
  put_away_dt timestamptz not null default now(),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists fg_bin_stock_batch_bin_uq on location.fg_bin_stock (finished_good_batch_id, bin_id);
create index if not exists fg_bin_stock_bin_idx on location.fg_bin_stock (bin_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fg_bin_stock_qty_chk') then
    alter table location.fg_bin_stock add constraint fg_bin_stock_qty_chk check (qty >= 0);
  end if;
end $$;

create table if not exists location.pick_light_config (
  id varchar(50) primary key default 'default',
  mode varchar(20) not null default 'off',
  controller_url text,
  hmac_secret_sealed text,
  configured_at timestamptz,
  configured_by varchar(255)
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pick_light_config_mode_chk') then
    alter table location.pick_light_config add constraint pick_light_config_mode_chk
      check (mode in ('off', 'simulator', 'http'));
  end if;
end $$;

create table if not exists location.pick_light_command (
  command_id uuid primary key default uuidv7(),
  seq bigint generated always as identity,
  shelf_task_id uuid,
  action varchar(10) not null,
  body jsonb not null,
  status varchar(20) not null default 'PENDING',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  last_http_status integer,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists pick_light_command_seq_uq on location.pick_light_command (seq);
create index if not exists pick_light_command_due_idx on location.pick_light_command (status, next_attempt_at);

create table if not exists location.pick_light_sim_state (
  location_key varchar(160) primary key,
  rack varchar(50) not null,
  shelf varchar(50),
  bin varchar(50),
  lit boolean not null default false,
  colour varchar(20),
  qty numeric(18,4),
  shelf_task_id uuid,
  signature_ok boolean,
  last_command jsonb,
  updated_at timestamptz not null default now()
);

do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
  t text;
begin
  if app is null then
    raise notice 'produce grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'produce grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  foreach t in array array[
    'production.produce_alert', 'packaging.product_dg_info',
    'location.rack_walk_order', 'location.shelf_task', 'location.fg_bin_stock',
    'location.pick_light_config', 'location.pick_light_command', 'location.pick_light_sim_state'
  ] loop
    execute format('grant select, insert, update, delete on table %s to %I', t, app);
  end loop;
end $$;
