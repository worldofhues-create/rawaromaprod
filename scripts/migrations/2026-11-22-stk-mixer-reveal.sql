-- Migration: 2026-11-22-stk-mixer-reveal (STOCK-FIX-RP: STK-15; owner decision D-1 / LD-35, WO-FLOOR-6).
--
-- D-1: the MIXER sees the material name beside the floor code, on the current step of an active batch
-- only: no list, no print, no export, every view logged per mixer, batch and time. Pickers and
-- verifiers see codes only; no station sees a percentage. Before this the mixer saw "Add line N: CODE"
-- and nothing else (rehearsal step 3b).
--
--   production.floor_job.mixer_assigned_to   the one mixer the batch is assigned to, by name, by a
--                                            production supervisor; nobody else may reveal or mix it
--   production.floor_mix_reveal              one row per view: who, which job, which step and line,
--                                            when. Ids and times only: the name is never written here.
--                                            Append-only (the same trigger as the oil ledger).
-- ADDITIVE + IDEMPOTENT. Rollback: scripts/migrations/rollback/2026-11-22-stk-mixer-reveal.down.sql

-- @target: main

alter table production.floor_job add column if not exists mixer_assigned_to varchar(255);
alter table production.floor_job add column if not exists mixer_assigned_by varchar(255);
alter table production.floor_job add column if not exists mixer_assigned_dt timestamptz;

create table if not exists production.floor_mix_reveal (
  floor_mix_reveal_id uuid primary key,
  floor_job_id        uuid not null references production.floor_job(floor_job_id),
  step_seq            integer not null,
  floor_line_id       uuid not null,
  revealed_to         varchar(255) not null,
  revealed_dt         timestamptz not null default clock_timestamp()
);
create index if not exists floor_mix_reveal_job_idx on production.floor_mix_reveal (floor_job_id, revealed_dt);
create index if not exists floor_mix_reveal_user_idx on production.floor_mix_reveal (revealed_to, revealed_dt);

create or replace function production.stk_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only: a stock movement is corrected by a new row, never rewritten', tg_table_name;
end $$;
drop trigger if exists floor_mix_reveal_append_only on production.floor_mix_reveal;
create trigger floor_mix_reveal_append_only before update or delete on production.floor_mix_reveal
  for each row execute function production.stk_append_only();

do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'stk-mixer-reveal grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'stk-mixer-reveal grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant select, insert on production.floor_mix_reveal to %I', app);
end $$;
