-- Migration: 2026-11-03-idempotency-key (SWEEP2-R1). The API accepted no Idempotency-Key, so a write
-- the console re-sent after a dropped channel (the tunnel retries up to three times) ran again: two
-- stock adjustments, two GRNs. One row per (user, key) holds the first request's hash and its result;
-- a repeat with the same key and the same request gets the stored result instead of a second write.
--
-- ADDITIVE + IDEMPOTENT (PB-16 convention). Single-tenant like every other platform table: the scope
-- is the signed-in user, so one person's key can never answer another's request. Main only.
-- Rollback: scripts/migrations/rollback/2026-11-03-idempotency-key.down.sql

-- @target: main

create table if not exists platform.idempotency_key (
  user_id          uuid         not null,
  idempotency_key  varchar(100) not null,
  request_hash     char(64)     not null,
  state            varchar(12)  not null default 'in_progress' check (state in ('in_progress', 'completed')),
  response         jsonb,
  created_dt       timestamptz  not null default now(),
  completed_dt     timestamptz,
  primary key (user_id, idempotency_key)
);
create index if not exists idempotency_key_created_dt_idx on platform.idempotency_key (created_dt);
