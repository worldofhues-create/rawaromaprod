-- RP-FAC test-support schema — the minimal slice of the Phase-1A schema the factory-sm state-
-- machine tests need (production → packaging QC → FG batch/reservation → sales dispatch). Column
-- names/types are hand-matched to packages/data-{production,packaging,sales}/src/schema/*.ts so
-- the real Drizzle table objects (and the real cluster services, unmodified) work against this
-- database. Not a substitute for `pnpm db:push` (which needs postgis + the full 12-schema set) —
-- this is a throwaway, single-purpose test database, created and torn down by the test harness.
create extension if not exists pgcrypto;
create schema if not exists production;
create schema if not exists packaging;
create schema if not exists sales;

-- production --------------------------------------------------------------
create table if not exists production.oil_batch_master (
  oil_batch_id uuid primary key,
  production_order_id uuid,
  secure_mixing_session_id uuid,
  batch_number varchar(50),
  produced_qty numeric(18,4),
  uom_id uuid,
  produced_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists production.oil_batch_consumption (
  oil_batch_consumption_id uuid primary key,
  oil_batch_id uuid references production.oil_batch_master(oil_batch_id),
  consumed_for_document_id uuid,
  consumed_qty numeric(18,4),
  uom_id uuid,
  consumed_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists production.oil_batch_event_history (
  oil_batch_event_history_id uuid primary key,
  oil_batch_id uuid references production.oil_batch_master(oil_batch_id),
  event_type varchar(30),
  event_dt timestamptz,
  performed_by uuid,
  remarks text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists production.outbox (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  aggregate_id uuid,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  seq bigint generated always as identity
);

-- packaging -----------------------------------------------------------------
create table if not exists packaging.finished_good_batch_master (
  finished_good_batch_id uuid primary key,
  package_order_id uuid,
  product_sku_id uuid,
  batch_number varchar(50),
  produced_qty numeric(18,4),
  uom_id uuid,
  manufacturing_date date,
  expiry_date date,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists packaging.finished_goods_batch_consumption (
  finished_goods_batch_consumption_id uuid primary key,
  finished_good_batch_id uuid references packaging.finished_good_batch_master(finished_good_batch_id),
  consumed_for_document_id uuid,
  consumed_qty numeric(18,4),
  uom_id uuid,
  consumed_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists packaging.finished_good_reservation (
  finished_good_reservation_id uuid primary key,
  finished_good_batch_id uuid references packaging.finished_good_batch_master(finished_good_batch_id),
  product_sku_id uuid,
  reserved_qty numeric(18,4),
  channel varchar(30),
  reserved_for_document_id uuid,
  reserved_dt timestamptz,
  released_dt timestamptz,
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists packaging.packaging_qc (
  packaging_qc_id uuid primary key,
  finished_good_batch_id uuid,
  package_order_id uuid,
  leakage_check text,
  label_check text,
  carton_check text,
  overall_result text,
  inspected_by uuid,
  inspection_dt timestamptz,
  status text,
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by uuid,
  updated_by uuid
);

create table if not exists packaging.outbox (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  aggregate_id uuid,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  seq bigint generated always as identity
);

-- sales -----------------------------------------------------------------
create table if not exists sales.dispatch_master (
  dispatch_id uuid primary key,
  sales_order_id uuid,
  customer_id uuid,
  dispatch_date date,
  vehicle_number varchar(20),
  transporter_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists sales.dispatch_items (
  dispatch_item_id uuid primary key,
  dispatch_id uuid references sales.dispatch_master(dispatch_id),
  sales_order_item_id uuid,
  finished_good_batch_id uuid,
  dispatched_qty numeric(18,4),
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists sales.outbox (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  aggregate_id uuid,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  seq bigint generated always as identity
);
