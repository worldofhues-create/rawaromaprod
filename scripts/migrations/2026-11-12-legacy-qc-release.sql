-- Migration: 2026-11-12-legacy-qc-release (FLOOR-QC-IN-1-LEGACY). Owner decision 2026-11-12, verbatim:
--   "Legacy release for lots with an existing QC release, marked as such with no sample records
--    created. Lots without one go to QC_PENDING."
--
-- FLOOR-QC-IN-1 (2026-11-11-floor-claims) made "released" mean an incoming inspection ACCEPT/PASS taken
-- on a recorded result AND a retained sample. Lots that were on the floor before that rule have no
-- sample on file, so this migration settles each raw lot (inventory.rm_batch_master) that is still live
-- (not REJECTED, not consumed, not past expiry) into one of two groups:
--
--   Group A  "an existing QC release": the lot's LATEST quality.qc_inspections row reads ACCEPT or PASS
--            (the exact rule cluster-inventory batch/lot-qc.ts rmLotQcRefusal applied before this).
--            -> one inventory.lot_qc_event row of kind LEGACY_RELEASE. released_at / released_by are
--               copied from the ACCEPT quality.qc_disposition when there is one (disposed_dt /
--               disposed_by), else from that inspection (inspection_dt, else updated_dt / updated_by).
--               `source` names the row they came from. Nothing on file -> null, never a guess.
--            -> NO qc_sample_retention, qc_result_details or qc_inspections row is created. The lot's
--               status is not touched: it stays usable.
--   Group B  no QC record at all: no qc_inspections row for the lot.
--            -> status QUARANTINE (RawProd's raw-lot state for "awaiting incoming QC"; there is no
--               QC_PENDING state for raw lots -- QC_PENDING exists only for finished oil batches,
--               cluster-production produce/produce-queue.service.ts), a QUARANTINED lot_qc_event, and a
--               PENDING inspection so it appears in QC's Test queue, exactly as the G3 quarantine intake
--               opens one (api automation/quarantine-intake.service.ts).
--
-- "A CoA on file" is NOT a separate evidence path here, deliberately: RawProd holds no certificate of
-- analysis per RAW lot. production.batch_coa is per finished oil batch; platform.document_registry
-- links documents to vendor | material | formula | customer | other (api documents/documents.service.ts
-- DOCUMENT_ENTITY_TYPES), never a lot; inventory.receiving_audit_line.checks->coaPresent is an auditor's
-- tick per PO line, not a document. Treating any of those as a lot's release would assert a QC fact we
-- do not hold, so a lot whose only evidence is one of them is Group B (re-inspected).
--
-- Lots with a QC record that is not a release (PENDING / HOLD / REWORK) are left exactly as they are:
-- they are already in QC's hands and already refused by the floor.
--
-- Every lot this touches is written to inventory.legacy_qc_release_2026_11_12 with its prior status;
-- the rollback restores from it. IDEMPOTENT: a lot already in that table is never settled twice.
-- Rollback: scripts/migrations/rollback/2026-11-12-legacy-qc-release.down.sql

-- @target: main

alter table inventory.lot_qc_event add column if not exists released_at timestamptz;
alter table inventory.lot_qc_event add column if not exists released_by varchar(255);
alter table inventory.lot_qc_event add column if not exists source text;
alter table inventory.lot_qc_event drop constraint if exists lot_qc_event_event_check;
alter table inventory.lot_qc_event add constraint lot_qc_event_event_check
  check (event in ('QUARANTINED', 'RELEASED', 'REJECTED', 'LEGACY_RELEASE'));
-- A legacy release always names the record it was taken from.
alter table inventory.lot_qc_event drop constraint if exists lot_qc_event_legacy_source_chk;
alter table inventory.lot_qc_event add constraint lot_qc_event_legacy_source_chk
  check (event <> 'LEGACY_RELEASE' or (source is not null and length(trim(source)) > 0));

create table if not exists inventory.legacy_qc_release_2026_11_12 (
  rm_batch_id          uuid primary key,
  grp                  char(1) not null check (grp in ('A', 'B')),
  prior_status         varchar(30),
  opened_inspection_id uuid,
  settled_dt           timestamptz not null default clock_timestamp()
);

-- "Released" for a raw lot, in ONE place: the latest inspection's result, or LEGACY_RELEASE when a
-- legacy release is newer than every inspection (a re-test opened after it supersedes it). Null when
-- the lot has neither. Every floor and QC check reads this.
create or replace function inventory.rm_lot_qc_result(p_rm_batch_id uuid) returns text
language sql stable as $$
  select case
           when l.at is not null and (q.created_dt is null or l.at > q.created_dt) then 'LEGACY_RELEASE'
           when q.created_dt is not null then upper(coalesce(q.overall_result, ''))
         end
    from (select 1) one
    left join lateral (select overall_result, created_dt from quality.qc_inspections
                        where rm_batch_id = p_rm_batch_id order by created_dt desc nulls last limit 1) q on true
    left join lateral (select at from inventory.lot_qc_event
                        where rm_batch_id = p_rm_batch_id and event = 'LEGACY_RELEASE' order by at desc limit 1) l on true
$$;

-- The badge's facts: when, who (and their name when the id is a user on file), and the source row.
create or replace function inventory.rm_lot_legacy_release(p_rm_batch_id uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object('label', 'Released before the sample rule',
           'releasedAt', to_char(l.released_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'releasedBy', l.released_by,
           'releasedByName', (select u.user_name from iam.user_master u where u.user_id::text = l.released_by),
           'source', l.source)
    from inventory.lot_qc_event l
   where l.rm_batch_id = p_rm_batch_id and l.event = 'LEGACY_RELEASE'
   order by l.at desc limit 1
$$;

do $$
declare
  v_actor constant text := 'migration:2026-11-12-legacy-qc-release';
  r record;
  new_id uuid;
begin
  -- Group A: latest inspection ACCEPT/PASS.
  for r in
    select rb.rm_batch_id, rb.status, q.qc_inspection_id, q.inspection_dt, q.updated_dt, q.updated_by,
           d.qc_disposition_id, d.disposed_dt, d.disposed_by
      from inventory.rm_batch_master rb
      join lateral (select * from quality.qc_inspections q where q.rm_batch_id = rb.rm_batch_id
                     order by q.created_dt desc nulls last limit 1) q on true
      left join lateral (select * from quality.qc_disposition d where d.qc_inspection_id = q.qc_inspection_id
                          and upper(coalesce(d.disposition_code, '')) in ('ACCEPT', 'PASS')
                          order by d.disposed_dt desc nulls last, d.created_dt desc limit 1) d on true
     where upper(coalesce(q.overall_result, '')) in ('ACCEPT', 'PASS')
       and upper(coalesce(rb.status, '')) not in ('REJECTED', 'CONSUMED', 'DEPLETED', 'EXHAUSTED', 'CLOSED')
       and not (rb.expiry_date is not null and rb.expiry_date < current_date)
       and not exists (select 1 from inventory.legacy_qc_release_2026_11_12 s where s.rm_batch_id = rb.rm_batch_id)
  loop
    insert into inventory.lot_qc_event (rm_batch_id, event, detail, actor, released_at, released_by, source)
    values (r.rm_batch_id, 'LEGACY_RELEASE', 'Released before the sample rule: QC release on file, no sample record', v_actor,
            case when r.qc_disposition_id is not null then r.disposed_dt else coalesce(r.inspection_dt, r.updated_dt) end,
            case when r.qc_disposition_id is not null then r.disposed_by::text else r.updated_by end,
            case when r.qc_disposition_id is not null then 'quality.qc_disposition:' || r.qc_disposition_id
                 else 'quality.qc_inspections:' || r.qc_inspection_id end);
    insert into inventory.legacy_qc_release_2026_11_12 (rm_batch_id, grp, prior_status) values (r.rm_batch_id, 'A', r.status);
  end loop;

  -- Group B: no inspection at all.
  for r in
    select rb.rm_batch_id, rb.status
      from inventory.rm_batch_master rb
     where not exists (select 1 from quality.qc_inspections q where q.rm_batch_id = rb.rm_batch_id)
       -- a lot recorded under FLOOR-QC-IN-1 is not legacy: it is born QUARANTINE and the intake opens its inspection
       and not exists (select 1 from inventory.lot_qc_event e where e.rm_batch_id = rb.rm_batch_id)
       and upper(coalesce(rb.status, '')) not in ('REJECTED', 'CONSUMED', 'DEPLETED', 'EXHAUSTED', 'CLOSED')
       and not (rb.expiry_date is not null and rb.expiry_date < current_date)
       and not exists (select 1 from inventory.legacy_qc_release_2026_11_12 s where s.rm_batch_id = rb.rm_batch_id)
  loop
    new_id := gen_random_uuid();
    update inventory.rm_batch_master set status = 'QUARANTINE', updated_by = v_actor, updated_dt = now() where rm_batch_id = r.rm_batch_id;
    insert into inventory.lot_qc_event (rm_batch_id, event, detail, actor)
    values (r.rm_batch_id, 'QUARANTINED', 'Lot on hand before the sample rule with no QC record: held for re-inspection', v_actor);
    insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result, status, created_by, updated_by)
    values (new_id, r.rm_batch_id, 'PENDING', 'PENDING', v_actor, v_actor);
    insert into inventory.legacy_qc_release_2026_11_12 (rm_batch_id, grp, prior_status, opened_inspection_id) values (r.rm_batch_id, 'B', r.status, new_id);
  end loop;
end $$;

do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'legacy-qc-release grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  execute format('grant select on inventory.legacy_qc_release_2026_11_12 to %I', app);
end $$;
