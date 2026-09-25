-- Migration: 2026-09-25-factory-weighing-labels (OPS-GREEN Act L, lane ops-factory)
--
-- ADDITIVE + IDEMPOTENT ONLY (PB-16 convention). Two floor records the production path
-- (plan -> order -> coded instruction -> reserve -> pick -> issue -> WEIGH -> mix -> QC ->
-- maturation -> final QC -> fill -> LABEL -> package -> packaging QC -> FG release) had no
-- table for:
--
--   production.weighing_record  one gross/tare/net reading per coded-instruction line of a
--                               mixing session, checked against the resolved target quantity.
--                               Carries the floor CODE only, never a material identity.
--                               A session cannot be completed until every instruction line
--                               has an ACCEPTED (in-tolerance) reading.
--   packaging.fg_label_record   the label applied to a finished-good batch, composed server-side
--                               from the batch's own record (SKU code, batch number, mfg/expiry,
--                               net quantity). Packaging QC cannot pass its label check for a
--                               batch with no applied label.
-- @target: main

create table if not exists production.weighing_record (
  weighing_record_id uuid primary key default uuidv7(),
  production_order_id uuid not null,
  secure_mixing_session_id uuid not null references production.secure_mixing_session (secure_mixing_session_id),
  sequence_no integer not null,
  floor_code varchar(100) not null,
  target_qty numeric(18,4) not null,
  uom varchar(30),
  gross_qty numeric(18,4) not null,
  tare_qty numeric(18,4) not null,
  net_qty numeric(18,4) not null,
  tolerance_pct numeric(6,3) not null,
  within_tolerance boolean not null,
  scale_ref varchar(100),
  weighed_by uuid,
  weighed_dt timestamptz not null default now(),
  status varchar(30) not null,
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255),
  constraint weighing_record_status_chk check (status in ('ACCEPTED', 'OUT_OF_TOLERANCE')),
  constraint weighing_record_qty_chk check (gross_qty >= 0 and tare_qty >= 0 and net_qty = gross_qty - tare_qty)
);
create index if not exists weighing_record_session_idx on production.weighing_record (secure_mixing_session_id);
create index if not exists weighing_record_order_idx on production.weighing_record (production_order_id);
-- One accepted reading per instruction line per session; out-of-tolerance attempts stay on file.
create unique index if not exists weighing_record_accepted_uq
  on production.weighing_record (secure_mixing_session_id, sequence_no) where status = 'ACCEPTED';

create table if not exists packaging.fg_label_record (
  fg_label_record_id uuid primary key default uuidv7(),
  finished_good_batch_id uuid not null references packaging.finished_good_batch_master (finished_good_batch_id),
  label_count integer not null,
  label_content jsonb not null,
  applied_by uuid,
  applied_dt timestamptz not null default now(),
  status varchar(30) not null default 'APPLIED',
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255),
  constraint fg_label_record_count_chk check (label_count > 0),
  constraint fg_label_record_status_chk check (status in ('APPLIED', 'VOID'))
);
create index if not exists fg_label_record_batch_idx on packaging.fg_label_record (finished_good_batch_id);
