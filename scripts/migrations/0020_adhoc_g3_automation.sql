-- G3 (lane F2): factory-side deterministic automation layer — idempotency ledger, decision
-- log, dead-letter queue, plus the procurement/platform tables the automation rules read and
-- write that were not yet promoted from the Phase-1A dictionary into schema-as-code:
--   procurement.stock_requirement / stock_req_items  (already in the locked dictionary —
--     packages/data-procurement/src/schema/requirement.ts — but never had a migration file)
--   procurement.vendor_rm_mapping                     (packages/data-procurement/src/schema/vendor.ts)
--   procurement.vendor_credit_reason_master / vendor_credit_note
--                                                       (packages/data-procurement/src/schema/credit.ts)
--   platform.notification_log                          (re-asserted here; see 0017 — the
--     alerts rule reuses this EXISTING mechanism rather than inventing a new one)
-- All statements are idempotent (CREATE ... IF NOT EXISTS) per the PB-16 convention.
-- @target: main

create schema if not exists automation;
create schema if not exists platform;

-- automation.applied — the idempotency ledger. (rule_code, dedupe_key) is the exactly-once
-- claim: a fresh key is claimed PENDING by an atomic INSERT ... ON CONFLICT DO NOTHING (the
-- same single-applier pattern inventory.material_issue_applied already uses); the winner
-- flips it to DONE (success) or FAILED (retry-safe — attempts increments, retried up to
-- MAX_ATTEMPTS, then left for automation.dead_letter to take over and never touched again).
create table if not exists automation.applied (
  rule_code varchar(64) not null,
  dedupe_key varchar(255) not null,
  status varchar(16) not null default 'PENDING',
  attempts integer not null default 0,
  last_error text,
  applied_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  primary key (rule_code, dedupe_key)
);

-- automation.decision_log — append-only audit: what fired, why, on what inputs/outputs.
-- Written INSIDE the same transaction as the domain effect (commits iff the effect did).
create table if not exists automation.decision_log (
  decision_log_id uuid primary key default gen_random_uuid(),
  rule_code varchar(64) not null,
  dedupe_key varchar(255) not null,
  event_type text,
  aggregate_id uuid,
  decision varchar(16) not null,
  reason text,
  inputs jsonb,
  outputs jsonb,
  created_dt timestamptz not null default now()
);
create index if not exists automation_decision_log_rule_idx
  on automation.decision_log (rule_code, dedupe_key);

-- automation.dead_letter — poison-message containment once a (rule_code, dedupe_key) has
-- failed MAX_ATTEMPTS times. Surfaced to Admin/Platform Operations (directive §20's "all
-- bridge failures surface..." principle, generalised to every automation rule).
create table if not exists automation.dead_letter (
  dead_letter_id uuid primary key default gen_random_uuid(),
  rule_code varchar(64) not null,
  dedupe_key varchar(255) not null,
  event_type text,
  payload jsonb,
  error text,
  attempts integer not null default 0,
  first_failed_dt timestamptz not null default now(),
  last_failed_dt timestamptz not null default now(),
  unique (rule_code, dedupe_key)
);

-- procurement.stock_requirement / stock_req_items — Phase-1A dictionary tables, never migrated.
create table if not exists procurement.stock_requirement (
  stock_requirement_id uuid primary key default gen_random_uuid(),
  location_id uuid,
  material_id uuid,
  required_qty numeric(18,4),
  uom_id uuid,
  required_by_date date,
  requirement_source varchar(255),
  priority varchar(255),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create index if not exists stock_requirement_material_idx on procurement.stock_requirement (material_id);

create table if not exists procurement.stock_req_items (
  stock_req_item_id uuid primary key default gen_random_uuid(),
  stock_requirement_id uuid references procurement.stock_requirement(stock_requirement_id),
  material_id uuid,
  required_qty numeric(18,4),
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create index if not exists stock_req_items_req_idx on procurement.stock_req_items (stock_requirement_id);

-- procurement.vendor_rm_mapping — used to group draft PRs per preferred vendor.
create table if not exists procurement.vendor_rm_mapping (
  vendor_rm_mapping_id uuid primary key default gen_random_uuid(),
  vendor_id uuid references procurement.vendor_details(vendor_id),
  material_id uuid,
  is_preferred boolean,
  lead_time_days integer,
  min_order_qty numeric(18,3),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create index if not exists vendor_rm_mapping_vendor_idx on procurement.vendor_rm_mapping (vendor_id);
create index if not exists vendor_rm_mapping_material_idx on procurement.vendor_rm_mapping (material_id);

-- procurement.vendor_credit_reason_master / vendor_credit_note — the QC-FAIL "vendor credit
-- note / return draft" target.
create table if not exists procurement.vendor_credit_reason_master (
  vendor_credit_reason_id uuid primary key default gen_random_uuid(),
  reason_code varchar(50),
  reason_description text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists vendor_credit_reason_master_code_uq
  on procurement.vendor_credit_reason_master (reason_code);

create table if not exists procurement.vendor_credit_note (
  vendor_credit_note_id uuid primary key default gen_random_uuid(),
  vendor_id uuid references procurement.vendor_details(vendor_id),
  grn_id uuid,
  vendor_credit_reason_id uuid references procurement.vendor_credit_reason_master(vendor_credit_reason_id),
  credit_note_number varchar(50),
  credit_note_date date,
  amount numeric(18,4),
  currency_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists vendor_credit_note_number_uq
  on procurement.vendor_credit_note (credit_note_number);
create index if not exists vendor_credit_note_vendor_idx on procurement.vendor_credit_note (vendor_id);

-- platform.notification_log — re-asserted (see 0017); the alerts rule (QC HOLD age / overdue
-- PR) reuses this EXISTING alerts mechanism rather than inventing a second one.
create table if not exists platform.notification_log (
  notification_log_id uuid primary key default gen_random_uuid(), event_id uuid unique, event_type text, channel text,
  recipient text, subject text, body text, status text, error text,
  created_dt timestamptz not null default now()
);
alter table platform.notification_log add column if not exists attempts integer not null default 0;
alter table platform.notification_log add column if not exists updated_dt timestamptz not null default now();
