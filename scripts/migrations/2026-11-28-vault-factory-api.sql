-- Migration: 2026-11-28-vault-factory-api (RP-BE-1). The rows the RAC OS Vault and Factory consoles
-- need that RawProd did not hold (ALEMBIC docs/plan/program/rp-relay.md Part 4.3; route contract in
-- docs/relay-contract-vault-factory.md). Every table here is append-only for the application role
-- except where a row has a lifecycle (a problem is resolved, a device test gets its result, a recall
-- review is decided): those UPDATEs are granted column by column, never DELETE.
--
-- Nothing here edits a stock figure: a recall puts the lot on the existing inventory.lot_hold; stock
-- still moves only through the floor steps and the batch close that already write the ledger.
-- Rollback: scripts/migrations/rollback/2026-11-28-vault-factory-api.down.sql

-- @target: main

-- A problem raised from a kiosk task (FAC-BE-11). It raises a platform.floor_alert for the supervisor;
-- the alert id is kept so "the supervisor is on the way" is said only when the alert exists.
create table if not exists production.floor_problem (
  floor_problem_id uuid         primary key,
  station          varchar(80)  not null check (length(btrim(station)) > 0),
  floor_job_id     uuid,
  kind             varchar(30)  not null check (kind in ('WRONG_IDENTITY', 'SHORT_QUANTITY', 'CONTAINER_DAMAGED', 'SCALE_NOT_READING', 'LABEL_WILL_NOT_SCAN', 'OTHER')),
  note             text,
  floor_alert_id   uuid,
  raised_by        varchar(255) not null,
  raised_dt        timestamptz  not null default now(),
  resolved_by      varchar(255),
  resolved_dt      timestamptz
);
create index if not exists floor_problem_open_idx on production.floor_problem (station, raised_dt desc) where resolved_dt is null;

-- Operating rules per branch (FAC-BE-03), append-only: the rule in force is the newest row for
-- (site, rule_key). A value is never edited; a change is a new row with its reason.
create table if not exists platform.operating_rule (
  operating_rule_id uuid         primary key,
  site              varchar(80)  not null check (length(btrim(site)) > 0),
  rule_key          varchar(80)  not null check (rule_key ~ '^[a-z][a-z0-9_.]{1,79}$'),
  value             jsonb        not null,
  reason            text         not null check (length(btrim(reason)) >= 3),
  set_by            varchar(255) not null,
  set_dt            timestamptz  not null default now()
);
create index if not exists operating_rule_site_key_idx on platform.operating_rule (site, rule_key, set_dt desc);

-- Maceration defaults per branch and product class (FAC-BE-06), append-only like operating rules.
-- A formula's own production.maceration_setting still wins over a default.
create table if not exists production.maceration_default (
  maceration_default_id uuid         primary key,
  site                  varchar(80)  not null check (length(btrim(site)) > 0),
  product_class         varchar(40)  not null check (length(btrim(product_class)) > 0),
  min_days              integer      not null check (min_days >= 0),
  max_days              integer      not null check (max_days >= min_days),
  reason                text         not null check (length(btrim(reason)) >= 3),
  set_by                varchar(255) not null,
  set_dt                timestamptz  not null default now()
);
create index if not exists maceration_default_site_idx on production.maceration_default (site, product_class, set_dt desc);

-- A device test asked from the desk (FAC-BE-08). REQUESTED until the device reports; the result is
-- what the device said, never assumed.
create table if not exists platform.device_test (
  device_test_id uuid         primary key,
  device_id      uuid         not null,
  state          varchar(10)  not null default 'REQUESTED' check (state in ('REQUESTED', 'PASSED', 'FAILED')),
  result         text,
  requested_by   varchar(255) not null,
  requested_at   timestamptz  not null default now(),
  tested_at      timestamptz
);
create index if not exists device_test_device_idx on platform.device_test (device_id, requested_at desc);

-- A recall review started from a lot (FAC-BE-19). The lot goes on inventory.lot_hold in the same
-- transaction. The number is assigned here, from a sequence, never typed.
create sequence if not exists quality.recall_review_no_seq;
create table if not exists quality.recall_review (
  recall_review_id uuid         primary key,
  recall_no        varchar(20)  not null unique,
  subject_type     varchar(12)  not null check (subject_type in ('RM_LOT', 'OIL_BATCH')),
  subject_id       uuid         not null,
  lot_ref          varchar(60)  not null,
  lot_hold_id      uuid,
  state            varchar(12)  not null default 'OPEN' check (state in ('OPEN', 'DECIDED')),
  reason           text         not null check (length(btrim(reason)) >= 3),
  started_by       varchar(255) not null,
  started_dt       timestamptz  not null default now(),
  decided_by       varchar(255),
  decided_dt       timestamptz,
  decision         varchar(20),
  decision_reason  text
);
create index if not exists recall_review_started_idx on quality.recall_review (started_dt desc);

-- A request to change a person's role (FAC-BE-20). It changes nothing by itself: approving it is an
-- RBAC decision for the owner and is not built here.
create table if not exists iam.role_change_request (
  role_change_request_id uuid         primary key,
  user_id                uuid         not null,
  to_role_code           varchar(60)  not null,
  station                varchar(80),
  reason                 text         not null check (length(btrim(reason)) >= 3),
  state                  varchar(12)  not null default 'REQUESTED' check (state in ('REQUESTED', 'APPROVED', 'CANCELLED')),
  requested_by           varchar(255) not null,
  requested_dt           timestamptz  not null default now()
);
create index if not exists role_change_request_user_idx on iam.role_change_request (user_id, requested_dt desc);

-- Who looked behind a floor code (VT-141): the reason and the person, before the name is shown.
create table if not exists masterdata.floor_code_reveal (
  floor_code_reveal_id uuid         primary key,
  material_id          uuid         not null,
  code                 varchar(40)  not null,
  reason               text         not null check (length(btrim(reason)) >= 3),
  revealed_by          varchar(255) not null,
  revealed_dt          timestamptz  not null default now()
);

-- A PO returned to its creator (FAC-BE-17): who, why, when.
alter table procurement.purchase_order add column if not exists rejected_by     varchar(255);
alter table procurement.purchase_order add column if not exists rejected_reason text;
alter table procurement.purchase_order add column if not exists rejected_dt     timestamptz;

-- A QC person's call on a round (FAC-BE-28): confirm the table's proposal or go against it with a
-- reason. The proposal (decision) stays what the server computed; the person's call sits beside it.
alter table quality.batch_qc_round add column if not exists decided_decision   varchar(16);
alter table quality.batch_qc_round add column if not exists decided_by         varchar(255);
alter table quality.batch_qc_round add column if not exists decided_dt         timestamptz;
alter table quality.batch_qc_round add column if not exists decision_reason    text;
alter table quality.batch_qc_round add column if not exists overrides_proposal boolean;

do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'vault-factory-api grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'vault-factory-api grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant usage on schema production, platform, quality, iam, masterdata to %I', app);
  execute format('grant select, insert on production.floor_problem, platform.operating_rule, production.maceration_default, platform.device_test, quality.recall_review, iam.role_change_request, masterdata.floor_code_reveal to %I', app);
  execute format('grant update (resolved_by, resolved_dt) on production.floor_problem to %I', app);
  execute format('grant update (state, result, tested_at) on platform.device_test to %I', app);
  execute format('grant update (state, decided_by, decided_dt, decision, decision_reason) on quality.recall_review to %I', app);
  execute format('grant usage on sequence quality.recall_review_no_seq to %I', app);
end $$;
