-- Migration: 2026-11-29-flags-register (FEATURE-SWITCHES). The kill-switch registry, registered.
--
-- `platform.flags` was never filled on any box: no migration, seed or boot step inserted the keys
-- packages/contracts/src/registries/flags.ts declares, and `PlatformFlagsService.setFlag` refuses a
-- key that is not a row ("keys come from the contracts registry seed"; there was no such seed). So
-- `GET /v1/flags/snapshot` answered an empty list, the Platform consoles drew "No switches yet", and
-- every `PUT /v1/admin/flags/:key` failed. This registers each key once, and updates a key's words and
-- criticality (never its state) when the registry changes them.
--
-- ONLY KEYS THAT GUARD REAL CODE (owner, 26 Nov: "nothing should be a stub"). The template keys for
-- another product (buyer.*, owner.listings.submit, builder.projects.import, ops.assignment.auto) guarded
-- nothing; any row of theirs that nobody ever set is removed, so the Platform console cannot show a
-- switch that switches nothing. A row somebody did set keeps its history (flag_states, flag_audit).
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
  ('all.auth', 'Sign-in to the Factory and the Vault. The Platform console stays open, so it can be switched back on.', 'boolean', true, 'on'),
  ('all.payments', 'Approving and releasing supplier payments.', 'boolean', true, 'on'),
  ('all.uploads', 'Document uploads: QC attachments, gate-entry documents, documents and the document registry.', 'boolean', false, 'on'),
  ('all.search', 'The factory search.', 'boolean', false, 'on'),
  ('admin.flags.write', 'Changing any switch. When off, the only change allowed is turning this one back on.', 'boolean', true, 'on'),
  ('production.batch.start', 'Starting a new batch on the floor. Batches already started carry on.', 'boolean', true, 'on'),
  ('floor.kiosk.writes', 'Floor kiosk steps: pick, verify, mix, leftovers. When off the kiosks are read-only.', 'boolean', true, 'on'),
  ('qc.release', 'QC releases and decisions: receiving dispositions, batch QC decisions, finished-goods QC, CoA and raw-material lot releases.', 'boolean', true, 'on'),
  ('procurement.po.approve', 'Approving purchase orders.', 'boolean', false, 'on')
on conflict (key) do update set description = excluded.description, is_critical = excluded.is_critical;

delete from platform.flags f
 where f.key in ('buyer.search.ai', 'buyer.offers.counter', 'owner.listings.submit', 'builder.projects.import', 'ops.assignment.auto')
   and not exists (select 1 from platform.flag_states s where s.flag_id = f.id)
   and not exists (select 1 from platform.flag_audit a where a.flag_id = f.id);

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
