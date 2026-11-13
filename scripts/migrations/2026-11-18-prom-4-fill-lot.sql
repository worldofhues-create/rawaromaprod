-- Migration: 2026-11-18-prom-4-fill-lot (PROM-4, LD-85). The storefront prints "Every pack carries a
-- lot number tied to its batch record"; the owner: "it has to be true". Before this, the finished-good
-- lot and the generic oil-batch number were whatever the caller typed (FACTORY.md: the lot is
-- "Assigned at fill", never typed). Now the server mints both:
--
--   packaging.fg_lot_seq              the finished-good lot, FG-<yymm>-<nnnnn>, minted at fill
--   production.oil_batch_no_seq       an oil batch made off the floor, OB-<yymm>-<nnnnn> (the floor's
--                                     compound step keeps minting B-<yymm>-<job> itself)
--   finished_good_batch_master        lot_assigned_at_fill (false on every lot made before this, whose
--                                     number was typed: a fact, never back-filled) and the rule version
--   platform.policy fill.lot_server_assigned   v1 = required; the only valid value (a Block)
--
-- ADDITIVE + IDEMPOTENT. No existing number is changed.
-- Rollback: scripts/migrations/rollback/2026-11-18-prom-4-fill-lot.down.sql

-- @target: main

create sequence if not exists packaging.fg_lot_seq;
create sequence if not exists production.oil_batch_no_seq;

alter table packaging.finished_good_batch_master add column if not exists lot_assigned_at_fill boolean not null default false;
alter table packaging.finished_good_batch_master add column if not exists lot_rule_version integer check (lot_rule_version >= 0);

insert into platform.policy (policy_key, title, description) values
  ('fill.lot_server_assigned', 'Lot assigned at fill', 'The finished-good lot is minted by the server at fill and printed on every pack. It is never typed, so this rule has one valid value.')
on conflict (policy_key) do nothing;

insert into platform.policy_version (policy_key, version, body, reason, created_by) values
  ('fill.lot_server_assigned', 1, '{"rules":[],"hasDefault":true,"defaultValue":{"required":true}}',
   'Owner LD-85, 13 Nov 2026: every pack carries a lot number tied to its batch record; the lot is assigned at fill', 'system')
on conflict (policy_key, version) do nothing;

-- The application role mints from both sequences.
do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'prom-4 grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'prom-4 grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant usage on sequence packaging.fg_lot_seq to %I', app);
  execute format('grant usage on sequence production.oil_batch_no_seq to %I', app);
end $$;
