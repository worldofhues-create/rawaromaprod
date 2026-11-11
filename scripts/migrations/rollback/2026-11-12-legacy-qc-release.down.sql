-- Rollback for 2026-11-12-legacy-qc-release (FLOOR-QC-IN-1-LEGACY). Restores every lot the migration
-- settled from inventory.legacy_qc_release_2026_11_12:
--   Group A  its LEGACY_RELEASE event is removed (no other row was written for it).
--   Group B  its prior status comes back, its QUARANTINED event goes, and the PENDING inspection the
--            migration opened is removed -- ONLY while it is still PENDING with no result recorded. An
--            inspection QC has since worked on is kept, and so is the lot's QC status; the notice says how many.
-- Every LEGACY_RELEASE row goes (the kind exists only through this migration); every other lot QC
-- event recorded after the migration is never touched.

-- @target: main

do $$
declare
  v_actor constant text := 'migration:2026-11-12-legacy-qc-release';
  kept int;
begin
  if to_regclass('inventory.legacy_qc_release_2026_11_12') is null then
    delete from inventory.lot_qc_event where event = 'LEGACY_RELEASE';
    return;
  end if;

  select count(*) into kept from inventory.legacy_qc_release_2026_11_12 s
    join quality.qc_inspections q on q.qc_inspection_id = s.opened_inspection_id
   where upper(coalesce(q.overall_result, '')) <> 'PENDING'
      or exists (select 1 from quality.qc_result_details d where d.qc_inspection_id = q.qc_inspection_id);
  if kept > 0 then raise notice 'legacy-qc-release rollback: % re-inspection(s) already worked by QC are kept, with their lot status', kept; end if;

  update inventory.rm_batch_master rb set status = s.prior_status, updated_by = v_actor, updated_dt = now()
    from inventory.legacy_qc_release_2026_11_12 s
    join quality.qc_inspections q on q.qc_inspection_id = s.opened_inspection_id
   where s.grp = 'B' and rb.rm_batch_id = s.rm_batch_id
     and upper(coalesce(q.overall_result, '')) = 'PENDING'
     and not exists (select 1 from quality.qc_result_details d where d.qc_inspection_id = q.qc_inspection_id);
  delete from quality.qc_inspections q using inventory.legacy_qc_release_2026_11_12 s
   where s.grp = 'B' and q.qc_inspection_id = s.opened_inspection_id
     and upper(coalesce(q.overall_result, '')) = 'PENDING'
     and not exists (select 1 from quality.qc_result_details d where d.qc_inspection_id = q.qc_inspection_id);
  delete from inventory.lot_qc_event e using inventory.legacy_qc_release_2026_11_12 s
   where e.rm_batch_id = s.rm_batch_id and e.actor = v_actor and e.event = 'QUARANTINED';
  -- LEGACY_RELEASE exists only through this migration, and the constraint restored below forbids it.
  delete from inventory.lot_qc_event where event = 'LEGACY_RELEASE';
end $$;

drop function if exists inventory.rm_lot_legacy_release(uuid);
drop function if exists inventory.rm_lot_qc_result(uuid);
drop table if exists inventory.legacy_qc_release_2026_11_12;
alter table inventory.lot_qc_event drop constraint if exists lot_qc_event_legacy_source_chk;
alter table inventory.lot_qc_event drop constraint if exists lot_qc_event_event_check;
alter table inventory.lot_qc_event add constraint lot_qc_event_event_check check (event in ('QUARANTINED', 'RELEASED', 'REJECTED'));
alter table inventory.lot_qc_event drop column if exists source;
alter table inventory.lot_qc_event drop column if exists released_by;
alter table inventory.lot_qc_event drop column if exists released_at;
delete from public.schema_migrations where id like '2026-11-12-legacy-qc-release%';
