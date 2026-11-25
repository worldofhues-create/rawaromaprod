-- Rollback of 2026-11-29-flags-register (FEATURE-SWITCHES). Removes the registered keys that no
-- environment has a state for and no change was ever recorded against; a key someone has set keeps
-- its row, because its flag_states and flag_audit rows (and the hash-chained audit row naming it)
-- are the record of that change. With a key gone the edge reads it as ON again (unknown -> on), the
-- state it was registered in. The grants stay: they give nothing the code does not use.
-- @target: main
delete from platform.flags f
 where f.key in ('all.auth', 'all.payments', 'all.uploads', 'all.search', 'buyer.search.ai', 'buyer.offers.counter', 'owner.listings.submit', 'builder.projects.import', 'ops.assignment.auto', 'admin.flags.write')
   and not exists (select 1 from platform.flag_states s where s.flag_id = f.id)
   and not exists (select 1 from platform.flag_audit a where a.flag_id = f.id);
delete from public.schema_migrations where id like '2026-11-29-flags-register%';
