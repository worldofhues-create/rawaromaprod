-- Migration: 2026-11-05-pfa-floor (lane pf-a, production-floor plan phase P1, owner-approved
-- 2026-11-05). PROD-A-1..n.
--
-- ADDITIVE + IDEMPOTENT ONLY (PB-16 convention): every statement is IF NOT EXISTS or guarded, so a
-- second run is a no-op. Main box only: nothing here is formula content. The floor sees coded
-- material (floor code) and grams, never a name, a CAS number or a percentage.
--
--   platform.policy / policy_version / policy_override / policy_decision
--       the rules engine (§12.0). A version row is never updated: publishing writes the next
--       version, so a decision keeps the version it was made under. Overrides on one record need a
--       reason and are revoked, never deleted.
--   masterdata.floor_family_colour   the admin's ingredient family -> colour table (§12.2)
--   masterdata.floor_code            one code per material: colour + a RANDOM number in the family
--   inventory.lot_barcode            the opaque id printed on a raw lot (L-XXXXXXX), nothing else
--   production.floor_job / floor_line / floor_mix_step / floor_label
--       the Picker -> Verifier -> Mixer checklists over an existing production order + pick list,
--       weights as integer milligrams, and the hand-off labels (PICKED, VERIFIED, MIXED).
--
-- Rollback: scripts/migrations/rollback/2026-11-05-pfa-floor.down.sql
-- New permission codes and the six floor roles come from scripts/ra-permissions.ts / ra-roles.ts;
-- production applies docs/releases/rc-pfa-floor-permission-grants.sql, never db:seed.

-- @target: main

create table if not exists platform.policy (
  policy_key   varchar(60) primary key,
  title        varchar(200) not null,
  description  text,
  created_dt   timestamptz not null default now()
);

create table if not exists platform.policy_version (
  policy_key    varchar(60) not null references platform.policy(policy_key),
  version       integer     not null check (version >= 1),
  body          jsonb       not null,
  reason        text        not null check (btrim(reason) <> ''),
  created_by    varchar(255) not null,
  created_dt    timestamptz not null default now(),
  primary key (policy_key, version)
);

create table if not exists platform.policy_override (
  override_id   uuid primary key default gen_random_uuid(),
  policy_key    varchar(60) not null references platform.policy(policy_key),
  record_type   varchar(60) not null,
  record_id     varchar(100) not null,
  value         jsonb       not null,
  reason        text        not null check (btrim(reason) <> ''),
  created_by    varchar(255) not null,
  created_dt    timestamptz not null default now(),
  revoked_by    varchar(255),
  revoked_dt    timestamptz,
  revoke_reason text
);
create unique index if not exists policy_override_active_uq
  on platform.policy_override (policy_key, record_type, record_id) where revoked_dt is null;

create table if not exists platform.policy_decision (
  decision_id   uuid primary key default gen_random_uuid(),
  policy_key    varchar(60) not null,
  version       integer     not null,
  rule_id       varchar(100),
  record_type   varchar(60),
  record_id     varchar(100),
  ctx           jsonb       not null,
  value         jsonb,
  explain       text        not null,
  decided_by    varchar(255),
  decided_dt    timestamptz not null default now()
);
create index if not exists policy_decision_record_idx on platform.policy_decision (record_type, record_id);

-- The five policies the plan names. Two ship a default the owner set in §12 (floor.queue strict
-- alternation, receiving.shortfall 20% / 5%, qc.rework max 2). procurement.payment_terms and
-- planning.cover ship WITHOUT one: until an admin publishes rules, those hold and ask.
insert into platform.policy (policy_key, title, description) values
  ('floor.queue', 'Floor queue order', 'Which job the floor makes next. Default: strict alternation New, Delayed, New ...'),
  ('receiving.shortfall', 'Delivery shortfall and extra', 'When a short or over delivery is rejected or held.'),
  ('procurement.payment_terms', 'Supplier payment terms', 'Advance on approval, against GRN, or credit terms.'),
  ('planning.cover', 'Stock cover', 'How much finished stock to plan to hold.'),
  ('qc.rework', 'QC rework limit', 'How many reworks a batch may have before review.')
on conflict (policy_key) do nothing;

insert into platform.policy_version (policy_key, version, body, reason, created_by) values
  ('floor.queue', 1, '{"rules":[],"hasDefault":true,"defaultValue":{"mode":"alternate"}}', 'Owner decision 2026-11-05 (plan 12.3): strict alternation', 'system'),
  ('receiving.shortfall', 1, '{"rules":[],"hasDefault":true,"defaultValue":{"basis":"po","shortPct":20,"extraPct":5}}', 'Owner decision 2026-11-05 (plan 12.1)', 'system'),
  ('qc.rework', 1, '{"rules":[],"hasDefault":true,"defaultValue":{"maxReworks":2}}', 'Owner decision 2026-11-05 (plan 12.7)', 'system'),
  ('procurement.payment_terms', 1, '{"rules":[],"hasDefault":false}', 'No default: hold and ask until rules are published', 'system'),
  ('planning.cover', 1, '{"rules":[],"hasDefault":false}', 'No default: hold and ask until rules are published', 'system')
on conflict (policy_key, version) do nothing;

create table if not exists masterdata.floor_family_colour (
  family_code   varchar(30) primary key,
  family_name   varchar(100) not null,
  colour_name   varchar(30)  not null,
  colour_hex    char(7)      not null check (colour_hex ~ '^#[0-9A-Fa-f]{6}$'),
  initial       char(1)      not null,
  updated_by    varchar(255),
  updated_dt    timestamptz not null default now()
);
create unique index if not exists floor_family_colour_name_uq on masterdata.floor_family_colour (upper(colour_name));

create table if not exists masterdata.floor_code (
  material_id   uuid primary key,
  family_code   varchar(30) not null references masterdata.floor_family_colour(family_code),
  number        integer     not null check (number between 1 and 9999),
  created_by    varchar(255),
  created_dt    timestamptz not null default now(),
  unique (family_code, number)
);

create table if not exists inventory.lot_barcode (
  barcode            varchar(12) primary key check (barcode ~ '^L-[0-9A-HJKMNP-TV-Z]{7}$'),
  inventory_batch_id uuid not null unique,
  created_by         varchar(255),
  created_dt         timestamptz not null default now()
);

create table if not exists production.floor_job (
  floor_job_id          uuid primary key default gen_random_uuid(),
  job_no                varchar(20) not null unique,
  production_order_id   uuid not null unique,
  material_pick_list_id uuid not null,
  stage                 varchar(12) not null default 'PICK' check (stage in ('PICK', 'VERIFY', 'MIX', 'DONE')),
  promise_dt            timestamptz,
  expedite              boolean not null default false,
  order_ref             varchar(100),
  channel               varchar(30),
  customer_tier         varchar(30),
  tote                  varchar(30),
  picked_by             varchar(255),
  picked_dt             timestamptz,
  verified_by           varchar(255),
  verified_dt           timestamptz,
  mixed_by              varchar(255),
  mixed_dt              timestamptz,
  batch_no              varchar(40),
  created_by            varchar(255),
  created_dt            timestamptz not null default now()
);
create sequence if not exists production.floor_job_no_seq;

create table if not exists production.floor_line (
  floor_line_id              uuid primary key default gen_random_uuid(),
  floor_job_id               uuid not null references production.floor_job(floor_job_id),
  material_pick_list_item_id uuid not null unique,
  material_id                uuid not null,
  seq                        integer not null,
  target_mg                  bigint not null check (target_mg > 0),
  tolerance_ppm              integer not null default 10000 check (tolerance_ppm between 0 and 1000000),
  picked_batch_id            uuid,
  picked_mg                  bigint,
  pick_off_fefo_reason       text,
  picked_by                  varchar(255),
  picked_dt                  timestamptz,
  actual_mg                  bigint,
  weigh_source               varchar(10) check (weigh_source in ('typed', 'scale')),
  verified_by                varchar(255),
  verified_dt                timestamptz,
  unique (floor_job_id, seq)
);

create table if not exists production.floor_mix_step (
  floor_job_id  uuid not null references production.floor_job(floor_job_id),
  seq           integer not null,
  instruction   text not null,
  done_by       varchar(255),
  done_dt       timestamptz,
  primary key (floor_job_id, seq)
);

create table if not exists production.floor_label (
  floor_label_id uuid primary key default gen_random_uuid(),
  floor_job_id   uuid not null references production.floor_job(floor_job_id),
  kind           varchar(10) not null check (kind in ('PICKED', 'VERIFIED', 'MIXED')),
  reprint        boolean not null default false,
  reason         text,
  printed_by     varchar(255) not null,
  printed_dt     timestamptz not null default now(),
  check (not reprint or (reason is not null and btrim(reason) <> ''))
);

-- The application role (DB_APP_ROLE, passed as rawprod.app_role): the same grant pattern as
-- 2026-11-03-idempotency-key. Version rows are append-only by privilege: no UPDATE, no DELETE.
do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'pfa-floor grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'pfa-floor grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant usage on schema platform, masterdata, inventory, production to %I', app);
  execute format('grant select, insert on platform.policy, platform.policy_version, platform.policy_decision to %I', app);
  execute format('grant select, insert, update on platform.policy_override to %I', app);
  execute format('grant select, insert, update on masterdata.floor_family_colour to %I', app);
  execute format('grant select, insert on masterdata.floor_code, inventory.lot_barcode, production.floor_label to %I', app);
  execute format('grant select, insert, update on production.floor_job, production.floor_line, production.floor_mix_step to %I', app);
  execute format('grant usage on sequence production.floor_job_no_seq to %I', app);
end $$;
