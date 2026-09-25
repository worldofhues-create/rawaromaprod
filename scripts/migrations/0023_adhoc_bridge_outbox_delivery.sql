-- OPS_GREEN §17 (P1 poison event) — bridge.outbox_delivery: per-event delivery state for
-- bridge.outbox (RawProd -> ALEMBIC). Backoff, the dead-letter park (permanent refusal after
-- one attempt, or 12 transient failures) and the operator's discard, one row per outbox event
-- that has failed at least once. Drizzle definition: packages/data-bridge/src/schema/
-- outbox-delivery.ts. Additive and idempotent (PB-16 convention); the bridge relay treats a
-- missing row as "never failed".
-- @target: main

create schema if not exists bridge;

create table if not exists bridge.outbox_delivery (
  outbox_id uuid primary key,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  last_http_status integer,
  parked_at timestamptz,
  parked_reason varchar(20),
  discarded_at timestamptz,
  discarded_by varchar(255),
  discard_reason text,
  updated_at timestamptz not null default now()
);

do $$ begin
  alter table bridge.outbox_delivery
    add constraint bridge_outbox_delivery_parked_reason_ck
    check (parked_reason is null or parked_reason in ('permanent', 'max_attempts'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table bridge.outbox_delivery
    add constraint bridge_outbox_delivery_parked_pair_ck
    check ((parked_at is null) = (parked_reason is null));
exception when duplicate_object then null; end $$;

create index if not exists bridge_outbox_delivery_parked_idx
  on bridge.outbox_delivery (parked_at)
  where parked_at is not null and discarded_at is null;
