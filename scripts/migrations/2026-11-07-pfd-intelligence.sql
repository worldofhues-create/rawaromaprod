-- Migration: 2026-11-07-pfd-intelligence (PROD-D, production floor plan sections 11, 12.3, 12.7.4, 12.9).
-- Nothing suggested production when there were no orders, an approved suggestion had nowhere to go
-- in the floor queue, and a batch that failed its third rework went to REVIEW with no screen, no
-- record of what the review decided, and nowhere to say whether a downgrade or a reblend was even
-- possible for that product or formula.
--
--   production.cover_suggestion      a stock-cover suggestion a person approved or dismissed, with
--                                    the arithmetic, the reasoning and the planning.cover rule and
--                                    version that sized it. Only decided suggestions are stored: the
--                                    live list is recomputed from today's data every time it is read.
--   production.cover_order_flag      an ALEMBIC order a planner marked recurring (kept in the demand
--                                    even when it looks like a one-off bulk order) or excluded.
--   production.floor_job.source      ORDER (a customer order) or SUGGESTED (from an approved
--                                    suggestion): suggested jobs rank below every customer job.
--   production.product_downgrade_target  the grade or product a batch of this product may be sold as
--                                    if review downgrades it. No row: downgrade is not offered.
--   production.formula_reblend_rule  whether a failed batch of this formula may be reblended into
--                                    another batch, and the most it may make up of that batch.
--   quality.batch_review_decision    the perfumer + vault_approver decision on a batch in REVIEW:
--                                    proposed by one, confirmed by the other (a different person).
--
-- Quantities are integer units of the SKU; shares are basis points. ADDITIVE + IDEMPOTENT. Main only.
-- Rollback: scripts/migrations/rollback/2026-11-07-pfd-intelligence.down.sql

-- @target: main

create table if not exists production.cover_suggestion (
  cover_suggestion_id uuid primary key default gen_random_uuid(),
  sku_code            varchar(50)  not null,
  product_sku_id      uuid,
  qty_units           integer      not null check (qty_units >= 0),
  suggested_units     integer      not null check (suggested_units >= 0),
  reasoning           text         not null check (btrim(reasoning) <> ''),
  inputs              jsonb        not null,
  policy_rule_id      text,
  policy_version      integer      not null,
  status              varchar(12)  not null check (status in ('APPROVED', 'DISMISSED')),
  decided_by          varchar(255) not null,
  decided_dt          timestamptz  not null default now(),
  note                text,
  purchase_request_ids jsonb       not null default '[]'::jsonb,
  floor_job_id        uuid,
  constraint cover_suggestion_note_chk check (status <> 'DISMISSED' or (note is not null and btrim(note) <> ''))
);
create index if not exists cover_suggestion_sku_idx on production.cover_suggestion (sku_code, decided_dt desc);

create table if not exists production.cover_order_flag (
  order_ref   varchar(100) primary key,
  flag        varchar(10)  not null check (flag in ('RECURRING', 'EXCLUDE')),
  reason      text         not null check (btrim(reason) <> ''),
  set_by      varchar(255) not null,
  set_dt      timestamptz  not null default now()
);

alter table production.floor_job add column if not exists source varchar(10) not null default 'ORDER';
alter table production.floor_job add column if not exists cover_suggestion_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'floor_job_source_chk') then
    alter table production.floor_job add constraint floor_job_source_chk check (source in ('ORDER', 'SUGGESTED'));
  end if;
end $$;

create table if not exists production.product_downgrade_target (
  product_id         uuid primary key,
  target_product_id  uuid,
  target_grade       varchar(100),
  reason             text         not null check (btrim(reason) <> ''),
  set_by             varchar(255) not null,
  set_dt             timestamptz  not null default now(),
  constraint product_downgrade_target_one_chk check (target_product_id is not null or (target_grade is not null and btrim(target_grade) <> '')),
  constraint product_downgrade_target_self_chk check (target_product_id is null or target_product_id <> product_id)
);

create table if not exists production.formula_reblend_rule (
  formula_id       uuid primary key,
  reblend_allowed  boolean      not null,
  max_share_bps    integer      check (max_share_bps between 1 and 10000),
  reason           text         not null check (btrim(reason) <> ''),
  set_by           varchar(255) not null,
  set_dt           timestamptz  not null default now(),
  constraint formula_reblend_rule_share_chk check (not reblend_allowed or max_share_bps is not null)
);

create table if not exists quality.batch_review_decision (
  batch_review_decision_id uuid primary key default gen_random_uuid(),
  oil_batch_id        uuid         not null,
  batch_qc_round_id   uuid         not null,
  outcome             varchar(10)  not null check (outcome in ('REJECT', 'DOWNGRADE', 'REBLEND')),
  reason              text         not null check (btrim(reason) <> ''),
  target_product_id   uuid,
  target_grade        varchar(100),
  reblend_into_oil_batch_id uuid,
  reblend_share_bps   integer      check (reblend_share_bps between 1 and 10000),
  status              varchar(10)  not null default 'PROPOSED' check (status in ('PROPOSED', 'CONFIRMED', 'WITHDRAWN')),
  proposed_by         varchar(255) not null,
  proposed_as         varchar(10)  not null check (proposed_as in ('PERFUMER', 'APPROVER')),
  proposed_dt         timestamptz  not null default now(),
  confirmed_by        varchar(255),
  confirmed_as        varchar(10)  check (confirmed_as in ('PERFUMER', 'APPROVER')),
  confirmed_dt        timestamptz,
  withdrawn_reason    text,
  qc_capa_id          uuid,
  constraint batch_review_two_people_chk check (confirmed_by is null or (confirmed_by <> proposed_by and confirmed_as <> proposed_as))
);
-- One live decision per batch: a second proposal while one waits is refused, not stacked.
create unique index if not exists batch_review_decision_live_uq on quality.batch_review_decision (oil_batch_id) where status in ('PROPOSED', 'CONFIRMED');

-- The application role (DB_APP_ROLE, passed as rawprod.app_role); same pattern as 2026-11-05-pfb-inbound-qc.
do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'pfd grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'pfd grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant select, insert, update on production.cover_suggestion, production.cover_order_flag, production.product_downgrade_target, production.formula_reblend_rule to %I', app);
  execute format('grant select, insert, update on quality.batch_review_decision to %I', app);
end $$;
