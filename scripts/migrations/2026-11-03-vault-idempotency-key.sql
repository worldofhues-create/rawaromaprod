-- Migration: 2026-11-03-vault-idempotency-key (SWEEP2-R1, Vault). The same store as
-- 2026-11-03-idempotency-key, on the Vault's own database: the Vault API has no path to the main
-- database, and its channel re-sends a formula write the same way the Factory's does.
--
-- ADDITIVE + IDEMPOTENT (PB-16 convention). Formula target only.
-- Rollback: scripts/migrations/rollback/2026-11-03-vault-idempotency-key.down.sql

-- @target: formula

create table if not exists formula.idempotency_key (
  user_id          uuid         not null,
  idempotency_key  varchar(100) not null,
  request_hash     char(64)     not null,
  state            varchar(12)  not null default 'in_progress' check (state in ('in_progress', 'completed')),
  response         jsonb,
  created_dt       timestamptz  not null default now(),
  completed_dt     timestamptz,
  primary key (user_id, idempotency_key)
);
create index if not exists idempotency_key_created_dt_idx on formula.idempotency_key (created_dt);
