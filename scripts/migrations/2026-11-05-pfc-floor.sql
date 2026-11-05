-- Migration: 2026-11-05-pfc-floor (lane pf-c, production floor plan P3 + P4,
-- docs/plan/production-floor-plan.md sections 2, 6 (stations 5 and 6), 8, 9, 12.4-12.6).
--
-- ADDITIVE + IDEMPOTENT ONLY (PB-16 convention). Main database only.
--
--   platform.device_master    printers, TVs, kiosk tablets and scales, one row per device, each
--                             bound to ONE station. A device is not a user: a person still signs
--                             in to act, so every action names the person.
--   platform.device_pairing   the 6-digit pairing code (stored hashed), valid 10 minutes, single use.
--   platform.device_token     the station-scoped device token (stored hashed, revocable).
--   platform.print_job        one label or document to print, as ONE template definition the print
--                             agent renders to ZPL / TSPL / EPL / ESC/POS / PDF. queued -> sent ->
--                             printed | failed (retried with backoff) -> parked after N attempts.
--                             A reprint is its own row pointing at the original, with the reason
--                             and the person, and the label says REPRINT.
--   platform.scale_reading    STABLE scale readings only, integer milligrams.
--   platform.floor_alert      station alerts: printer offline, maceration complete, a shipment held.
--   production.maceration_setting  per formula: maceration required, min/max days, freeze step.
--   production.maceration_run      one open run per oil batch: QC 1 -> maceration -> freeze -> QC 2.
--   production.maceration_event    the run's log (start, restart after rework, extend, early release).
--   sales.shipment / shipment_carton / shipment_unit
--                             the packing station (units scanned into cartons, weights in mg) and
--                             the logistics station (carton set check, AWB, handover).
--   sales.courier_connector   courier connectors: off / test / live, credentials sealed with the
--                             same AES-256-GCM KEK as the ALEMBIC connector secret.
--
-- Weights are integer milligrams (bigint). No money is stored here.
-- Rollback: scripts/migrations/rollback/2026-11-05-pfc-floor.down.sql

-- @target: main

create table if not exists platform.device_master (
  device_id     uuid primary key default uuidv7(),
  kind          varchar(20)  not null check (kind in ('label_printer', 'display', 'kiosk', 'scale')),
  station       varchar(80)  not null,
  site          varchar(80),
  name          varchar(120) not null,
  status        varchar(12)  not null default 'pending' check (status in ('pending', 'active', 'offline', 'revoked')),
  config        jsonb        not null default '{}'::jsonb,
  last_seen_at  timestamptz,
  paired_at     timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid,
  created_by    uuid,
  created_at    timestamptz  not null default now(),
  updated_at    timestamptz  not null default now()
);
create index if not exists device_master_station_idx on platform.device_master (station, kind);

create table if not exists platform.device_pairing (
  pairing_id  uuid primary key default uuidv7(),
  device_id   uuid        not null references platform.device_master (device_id),
  code_hash   char(64)    not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  attempts    integer     not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create unique index if not exists device_pairing_open_code_uq on platform.device_pairing (code_hash) where used_at is null;

create table if not exists platform.device_token (
  device_token_id uuid primary key default uuidv7(),
  device_id       uuid        not null references platform.device_master (device_id),
  station         varchar(80) not null,
  token_hash      char(64)    not null unique,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
create index if not exists device_token_device_idx on platform.device_token (device_id);

create table if not exists platform.print_job (
  print_job_id    uuid primary key default uuidv7(),
  device_id       uuid,
  station         varchar(80)  not null,
  label_kind      varchar(30)  not null,
  subject_ref     varchar(120),
  template        jsonb        not null,
  status          varchar(10)  not null default 'queued' check (status in ('queued', 'sent', 'printed', 'failed', 'parked', 'browser', 'cancelled')),
  attempts        integer      not null default 0,
  max_attempts    integer      not null default 5,
  next_attempt_at timestamptz  not null default now(),
  last_error      text,
  reprint_of      uuid,
  reprint_reason  text,
  requested_by    uuid,
  printed_at      timestamptz,
  created_at      timestamptz  not null default now(),
  updated_at      timestamptz  not null default now(),
  constraint print_job_reprint_reason_chk check (reprint_of is null or length(trim(coalesce(reprint_reason, ''))) > 0)
);
create index if not exists print_job_pull_idx on platform.print_job (device_id, status, next_attempt_at);
create index if not exists print_job_subject_idx on platform.print_job (label_kind, subject_ref);

create table if not exists platform.scale_reading (
  scale_reading_id uuid primary key default uuidv7(),
  device_id        uuid        not null references platform.device_master (device_id),
  station          varchar(80) not null,
  mg               bigint      not null check (mg >= 0),
  stable           boolean     not null check (stable),
  raw              varchar(200),
  read_at          timestamptz not null default now()
);
create index if not exists scale_reading_device_idx on platform.scale_reading (device_id, read_at desc);

create table if not exists platform.floor_alert (
  floor_alert_id uuid primary key default uuidv7(),
  kind           varchar(40)  not null,
  station        varchar(80),
  subject_type   varchar(40),
  subject_id     uuid,
  title          text         not null,
  body           text,
  dedupe_key     varchar(200) not null,
  raised_at      timestamptz  not null default now(),
  acked_at       timestamptz,
  acked_by       uuid,
  cleared_at     timestamptz
);
create unique index if not exists floor_alert_open_uq on platform.floor_alert (dedupe_key) where cleared_at is null;

create table if not exists production.maceration_setting (
  formula_id      uuid primary key,
  required        boolean     not null default false,
  min_days        integer     not null check (min_days between 1 and 365),
  max_days        integer     not null check (max_days between 1 and 365),
  freeze_required boolean     not null default false,
  freeze_note     varchar(300),
  updated_by      uuid,
  updated_at      timestamptz not null default now(),
  constraint maceration_setting_window_chk check (min_days <= max_days)
);

create table if not exists production.maceration_run (
  maceration_run_id    uuid primary key default uuidv7(),
  oil_batch_id         uuid        not null,
  formula_id           uuid,
  status               varchar(16) not null default 'MACERATING' check (status in ('MACERATING', 'CLOSED', 'CANCELLED')),
  started_at           timestamptz not null,
  min_days             integer     not null,
  max_days             integer     not null,
  extend_days          integer     not null default 0,
  freeze_required      boolean     not null default false,
  qc1_production_qc_id uuid        not null,
  freeze_done_at       timestamptz,
  freeze_done_by       uuid,
  alarm_at             timestamptz,
  early_release_at     timestamptz,
  early_release_by     uuid,
  early_release_reason text,
  restart_count        integer     not null default 0,
  closed_at            timestamptz,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists maceration_run_open_uq on production.maceration_run (oil_batch_id) where status = 'MACERATING';

create table if not exists production.maceration_event (
  maceration_event_id uuid primary key default uuidv7(),
  maceration_run_id   uuid        not null references production.maceration_run (maceration_run_id),
  event               varchar(30) not null,
  note                text,
  performed_by        uuid,
  created_at          timestamptz not null default now()
);
create index if not exists maceration_event_run_idx on production.maceration_event (maceration_run_id, created_at);

create table if not exists sales.shipment (
  shipment_id     uuid primary key default uuidv7(),
  shipment_no     varchar(30)  not null unique,
  sales_order_id  uuid         not null,
  status          varchar(14)  not null default 'PACKING' check (status in ('PACKING', 'PACKED', 'DOCS_READY', 'AWB_ASSIGNED', 'HANDING_OVER', 'HANDED_OVER', 'HOLD', 'CANCELLED')),
  lots            uuid[]       not null,
  carton_count    integer,
  docs            jsonb,
  courier_code    varchar(40),
  awb             varchar(60),
  awb_source      varchar(6) check (awb_source is null or awb_source in ('scan', 'typed')),
  awb_at          timestamptz,
  dispatch_id     uuid,
  handed_over_at  timestamptz,
  handed_over_to  varchar(120),
  handed_over_by  uuid,
  hold_reason     text,
  packed_at       timestamptz,
  packed_by       uuid,
  created_by      uuid,
  created_at      timestamptz  not null default now(),
  updated_at      timestamptz  not null default now()
);
create unique index if not exists shipment_awb_uq on sales.shipment (upper(awb)) where awb is not null;
create index if not exists shipment_status_idx on sales.shipment (status, created_at);

create table if not exists sales.shipment_carton (
  carton_id     uuid primary key default uuidv7(),
  shipment_id   uuid        not null references sales.shipment (shipment_id),
  seq           integer     not null,
  carton_code   varchar(40) not null unique,
  status        varchar(8)  not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  gross_mg      bigint check (gross_mg is null or gross_mg > 0),
  weight_source varchar(6) check (weight_source is null or weight_source in ('scale', 'typed')),
  closed_at     timestamptz,
  closed_by     uuid,
  checked_at    timestamptz,
  checked_by    uuid,
  created_at    timestamptz not null default now(),
  unique (shipment_id, seq)
);

create table if not exists sales.shipment_unit (
  unit_id                uuid primary key default uuidv7(),
  unit_code              varchar(40) not null unique,
  shipment_id            uuid        not null references sales.shipment (shipment_id),
  sales_order_id         uuid        not null,
  sales_order_item_id    uuid,
  finished_good_batch_id uuid        not null,
  batch_number           varchar(50),
  target_mg              bigint      not null check (target_mg > 0),
  tolerance_mg           bigint      not null check (tolerance_mg >= 0),
  net_mg                 bigint      not null check (net_mg > 0),
  weight_source          varchar(6)  not null check (weight_source in ('scale', 'typed')),
  scale_reading_id       uuid,
  sealed                 boolean     not null check (sealed),
  carton_id              uuid references sales.shipment_carton (carton_id),
  carton_scanned_at      timestamptz,
  packed_by              uuid,
  created_at             timestamptz not null default now()
);
create index if not exists shipment_unit_shipment_idx on sales.shipment_unit (shipment_id);

create table if not exists sales.courier_connector (
  provider              varchar(40)  primary key,
  display_name          varchar(120) not null,
  mode                  varchar(5)   not null default 'off' check (mode in ('off', 'test', 'live')),
  credentials_sealed    text,
  awb_pattern           varchar(200),
  tracking_url_template varchar(300),
  health                varchar(12)  not null default 'unknown',
  health_note           text,
  last_sync_at          timestamptz,
  updated_by            uuid,
  updated_at            timestamptz  not null default now()
);

-- The application role (DB_APP_ROLE, passed as rawprod.app_role); same grant pattern as
-- 2026-11-03-idempotency-key.
do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'pfc-floor grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'pfc-floor grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant usage on schema platform, production, sales to %I', app);
  execute format('grant select, insert, update on platform.device_master, platform.device_pairing, platform.device_token, platform.print_job, platform.scale_reading, platform.floor_alert to %I', app);
  execute format('grant select, insert, update on production.maceration_setting, production.maceration_run to %I', app);
  -- The maceration log is append-only.
  execute format('grant select, insert on production.maceration_event to %I', app);
  execute format('grant select, insert, update on sales.shipment, sales.shipment_carton, sales.shipment_unit, sales.courier_connector to %I', app);
end $$;
