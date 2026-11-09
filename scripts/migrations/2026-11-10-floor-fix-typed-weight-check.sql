-- Migration: 2026-11-10-floor-fix-typed-weight-check (FLOOR-FIX-3). A weight typed by hand (not a
-- stable scale reading) needs a second person: the typist asks, a verifier, supervisor or admin who
-- is not the typist signs, and the weight is accepted once, for that station and that figure. The row
-- is the audit record (who typed, who signed, as what role, when, used for what).
--
-- ADDITIVE + IDEMPOTENT. Rollback: scripts/migrations/rollback/2026-11-10-floor-fix-typed-weight-check.down.sql
--
-- @target: main

create table if not exists platform.typed_weight_check (
  check_id     uuid primary key,
  station      varchar(60)  not null,
  mg           bigint       not null check (mg > 0),
  reason       text,
  typed_by     uuid         not null,
  status       varchar(10)  not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'USED')),
  signed_by    uuid,
  signed_role  varchar(20),
  signed_at    timestamptz,
  used_at      timestamptz,
  used_for     text,
  created_at   timestamptz  not null default now(),
  check (signed_by is null or signed_by <> typed_by),
  check (status = 'PENDING' or (signed_by is not null and signed_at is not null))
);
create index if not exists typed_weight_check_station_idx on platform.typed_weight_check (station, status);
