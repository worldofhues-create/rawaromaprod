-- HAND-WRITTEN from scripts/create-relay-tables.cjs (schema portion; that script has no
-- data-seed step).
-- @target: main

create table if not exists platform.relay_cursor (
  direction text not null,
  source_schema text not null,
  last_seq bigint not null default 0,
  updated_dt timestamptz not null default now(),
  primary key (direction, source_schema)
);
create table if not exists platform.relay_inbox (
  event_id uuid primary key,
  package_id uuid,
  event_type text,
  direction text,
  imported_dt timestamptz not null default now()
);
create table if not exists platform.relay_package (
  package_id uuid not null,
  kind text not null,               -- EXPORT | IMPORT (same id can be both across the two consoles)
  direction text not null,
  package_hash text not null,
  prev_hash text,
  event_count integer not null default 0,
  created_dt timestamptz not null default now(),
  primary key (package_id, kind)
);
create index if not exists relay_package_dir_kind_idx on platform.relay_package(direction, kind, created_dt);
create index if not exists relay_inbox_package_idx on platform.relay_inbox(package_id);
