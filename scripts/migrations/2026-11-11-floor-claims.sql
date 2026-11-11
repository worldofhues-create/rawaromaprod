-- Migration: 2026-11-11-floor-claims (FLOOR-QC-IN-1, FLOOR-LOT-STOP-1, FLOOR-TEMP-1). Owner rule
-- 2026-11-11: a claim the storefront makes is built so it can be backed.
--
--   inventory.lot_qc_event            FLOOR-QC-IN-1  every incoming lot's quarantine / release / reject
--   production.floor_line_stop        FLOOR-LOT-STOP-1  a wrong scan stops the job until a supervisor resumes
--   quality.storage_zone(+_bin)       FLOOR-TEMP-1   zones, their bins and the logging interval
--   quality.temperature_reading       FLOOR-TEMP-1   readings in 0.01 C, MANUAL or SENSOR, append-only
--   quality.material_temp_limit       FLOOR-TEMP-1   per-material limits, only with a source
--   quality.temperature_excursion     FLOOR-TEMP-1   each lot a reading put outside its limit, and its hold
--
-- No rows are inserted: no zone, limit or reading is seed data. ADDITIVE + IDEMPOTENT.
-- Rollback: scripts/migrations/rollback/2026-11-11-floor-claims.down.sql

-- @target: main

-- FLOOR-QC-IN-1: every incoming-lot QC transition on file (born in quarantine, released, rejected).
-- Append-only: the application role gets SELECT and INSERT, never UPDATE or DELETE.
create table if not exists inventory.lot_qc_event (
  lot_qc_event_id uuid primary key default gen_random_uuid(),
  rm_batch_id     uuid not null,
  event           varchar(20) not null check (event in ('QUARANTINED', 'RELEASED', 'REJECTED')),
  detail          text not null,
  actor           varchar(255) not null,
  at              timestamptz not null default clock_timestamp()
);
create index if not exists lot_qc_event_batch_idx on inventory.lot_qc_event (rm_batch_id, at);

-- FLOOR-LOT-STOP-1: a wrong scan stops the job. One open stop per job; resuming names the supervisor
-- (never the person who scanned) and the reason. The row is the audit record.
create table if not exists production.floor_line_stop (
  floor_line_stop_id uuid primary key default gen_random_uuid(),
  floor_job_id       uuid not null,
  floor_line_id      uuid,
  station            varchar(12) not null check (station in ('PICK')),
  kind               varchar(24) not null check (kind in ('WRONG_MATERIAL', 'UNKNOWN_LOT', 'LOT_NOT_RELEASED', 'LOT_ON_HOLD', 'LOT_EXPIRED')),
  scanned            text not null,
  expected           text,
  detail             text not null,
  stopped_by         varchar(255) not null,
  stopped_dt         timestamptz not null default clock_timestamp(),
  cleared_by         varchar(255),
  cleared_dt         timestamptz,
  clear_reason       text,
  constraint floor_line_stop_clear_chk check (
    (cleared_dt is null and cleared_by is null and clear_reason is null)
    or (cleared_dt is not null and cleared_by is not null and length(trim(clear_reason)) > 0 and cleared_by <> stopped_by))
);
create unique index if not exists floor_line_stop_open_uq on production.floor_line_stop (floor_job_id) where cleared_dt is null;

-- FLOOR-TEMP-1: storage and production zones, the bins in each, and the interval a zone must be logged at.
create table if not exists quality.storage_zone (
  zone_id          uuid primary key default gen_random_uuid(),
  zone_code        varchar(40) not null unique,
  zone_name        varchar(120) not null,
  kind             varchar(12) not null check (kind in ('STORAGE', 'PRODUCTION')),
  log_interval_min integer not null check (log_interval_min between 5 and 1440),
  status           varchar(10) not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  -- The zone's own bounds (e.g. a maceration store kept at 16-20 C), only with the house document that sets them.
  min_centi_c      integer check (min_centi_c between -9999 and 9999),
  max_centi_c      integer check (max_centi_c between -9999 and 9999),
  bounds_source    text,
  created_by       varchar(255) not null,
  created_dt       timestamptz not null default now(),
  constraint storage_zone_bounds_chk check ((min_centi_c is null and max_centi_c is null) or length(trim(coalesce(bounds_source, ''))) > 0),
  constraint storage_zone_order_chk check (min_centi_c is null or max_centi_c is null or min_centi_c < max_centi_c)
);
create table if not exists quality.storage_zone_bin (
  zone_id    uuid not null references quality.storage_zone(zone_id),
  bin_id     uuid not null unique,
  created_by varchar(255) not null,
  created_dt timestamptz not null default now(),
  primary key (zone_id, bin_id)
);
-- A reading in hundredths of a degree C (an integer: 31.25 C is 3125). MANUAL readings name who took
-- them; a SENSOR reading must name its device. Append-only.
create table if not exists quality.temperature_reading (
  temperature_reading_id uuid primary key default gen_random_uuid(),
  zone_id                uuid not null references quality.storage_zone(zone_id),
  centi_c                integer not null check (centi_c between -9999 and 9999),
  source                 varchar(8) not null check (source in ('MANUAL', 'SENSOR')),
  device_id              uuid,
  read_at                timestamptz not null,
  recorded_by            varchar(255) not null,
  recorded_dt            timestamptz not null default clock_timestamp(),
  note                   text,
  constraint temperature_reading_device_chk check (source <> 'SENSOR' or device_id is not null)
);
create index if not exists temperature_reading_zone_idx on quality.temperature_reading (zone_id, read_at desc);
-- A material's storage limits, only where a source says so (SDS section, supplier spec, CoA). One
-- current row per material; a change supersedes the old row, it never rewrites it.
create table if not exists quality.material_temp_limit (
  material_temp_limit_id uuid primary key default gen_random_uuid(),
  material_id            uuid not null,
  min_centi_c            integer check (min_centi_c between -9999 and 9999),
  max_centi_c            integer check (max_centi_c between -9999 and 9999),
  source                 text not null check (length(trim(source)) > 0),
  set_by                 varchar(255) not null,
  set_dt                 timestamptz not null default now(),
  superseded_dt          timestamptz,
  constraint material_temp_limit_bound_chk check (min_centi_c is not null or max_centi_c is not null),
  constraint material_temp_limit_order_chk check (min_centi_c is null or max_centi_c is null or min_centi_c < max_centi_c)
);
create unique index if not exists material_temp_limit_current_uq on quality.material_temp_limit (material_id) where superseded_dt is null;
-- Each lot a reading put outside its material's limit, and the hold that stopped it.
create table if not exists quality.temperature_excursion (
  temperature_excursion_id uuid primary key default gen_random_uuid(),
  temperature_reading_id   uuid not null references quality.temperature_reading(temperature_reading_id),
  zone_id                  uuid not null,
  rm_batch_id              uuid not null,
  inventory_batch_id       uuid not null,
  -- the material limit broken, or null when it was the zone's own bounds (basis says which)
  material_temp_limit_id   uuid references quality.material_temp_limit(material_temp_limit_id),
  basis                    varchar(8) not null check (basis in ('MATERIAL', 'ZONE')),
  centi_c                  integer not null,
  lot_hold_id              uuid,
  raised_dt                timestamptz not null default clock_timestamp()
);
create index if not exists temperature_excursion_zone_idx on quality.temperature_excursion (zone_id, raised_dt desc);

-- FLOOR-TEMP-1: a temperature sensor pairs like every other floor device (6-digit code -> device token)
-- and posts readings for the one zone named in its config.
alter table platform.device_master drop constraint if exists device_master_kind_check;
alter table platform.device_master add constraint device_master_kind_check
  check (kind in ('label_printer', 'display', 'kiosk', 'scale', 'scanner', 'temp_sensor'));

-- The application role (DB_APP_ROLE, passed as rawprod.app_role); same pattern as 2026-11-05-pfb-inbound-qc.
-- Append-only tables get no UPDATE: a reading, an excursion or a QC transition is never rewritten.
do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'floor-claims grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'floor-claims grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant select, insert on inventory.lot_qc_event, quality.temperature_reading, quality.temperature_excursion, quality.storage_zone_bin to %I', app);
  execute format('grant select, insert, update on production.floor_line_stop, quality.storage_zone, quality.material_temp_limit to %I', app);
end $$;
