-- Migration: 2026-11-29-flags-register (FEATURE-SWITCHES). The kill-switch registry, registered.
--
-- `platform.flags` was never filled on any box: no migration, seed or boot step inserted the keys
-- packages/contracts/src/registries/flags.ts declares, and `PlatformFlagsService.setFlag` refuses a
-- key that is not a row ("keys come from the contracts registry seed"; there was no such seed). So
-- `GET /v1/flags/snapshot` answered an empty list, the Platform consoles drew "No switches yet", and
-- every `PUT /v1/admin/flags/:key` failed. This registers each key once.
--
-- THE DEFAULT IS 'on', AND THAT IS WHAT MAKES THIS CHANGE NOTHING. An unregistered key reads as ON at
-- the edge (`FlagsService.isEnabled`: unknown -> on, fail-open), and `all.auth` is enforced today
-- (`@RequiredFlag('all.auth')` on the sign-in routes). The table's own default is 'off'; inserting
-- with it would switch sign-in off on the next boot. Every key is registered 'on', exactly the state
-- it is in now, and moving one is a person's change, with a reason, through the admin route.
--
-- Keep this list equal to FLAGS (backend/api/src/__tests__/flags-admin.test.ts asserts it).
-- Rollback: scripts/migrations/rollback/2026-11-29-flags-register.down.sql

-- @target: main

insert into platform.flags (key, description, kind, is_critical, default_state) values
  ('all.auth', 'Master auth kill-switch', 'boolean', true, 'on'),
  ('all.payments', 'Master payments kill-switch', 'boolean', true, 'on'),
  ('all.uploads', 'Master media/document upload switch', 'boolean', false, 'on'),
  ('all.search', 'Master search switch', 'boolean', false, 'on'),
  ('buyer.search.ai', 'AI search (phase 2 stub)', 'boolean', false, 'on'),
  ('buyer.offers.counter', 'Offer counter action', 'boolean', false, 'on'),
  ('owner.listings.submit', 'Listing submission', 'boolean', false, 'on'),
  ('builder.projects.import', 'Bulk unit CSV import', 'boolean', false, 'on'),
  ('ops.assignment.auto', 'Auto-assignment engine (P1.5)', 'boolean', false, 'on'),
  ('admin.flags.write', 'Flag mutation (guard the guard)', 'boolean', true, 'on')
on conflict (key) do nothing;

-- The application role (DB_APP_ROLE) reads the registry and writes a change: the state, its
-- flag_audit row, its hash-chained platform.audit_events row and its outbox event. Never DELETE,
-- and no UPDATE on either audit table. Same grant pattern as 2026-11-03-idempotency-key.
do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'flags grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'flags grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant usage on schema platform to %I', app);
  execute format('grant select on platform.flags to %I', app);
  execute format('grant select, insert, update on platform.flag_states to %I', app);
  execute format('grant select, insert on platform.flag_audit to %I', app);
  execute format('grant select, insert on platform.audit_events to %I', app);
  execute format('grant select, insert on platform.outbox to %I', app);
end $$;
