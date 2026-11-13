-- STOCK-E2E-1: RawProd's stock equation, read only. Every figure is integer milligrams.
-- psql -v ON_ERROR_STOP=1 -f reconcile-rp.sql  (run inside BEGIN READ ONLY; it writes nothing)
-- A mass unit is turned into mg by its code; a lot in any other unit is reported, never converted.
\pset footer off
-- the unit table, as a session-local view (temp schema only), then everything else read only
create temporary view _mg as
select u.uom_id, case lower(u.uom_code) when 'kg' then 1000000 when 'g' then 1000 when 'mg' then 1 end as f
  from platform.uom_master u;
begin transaction read only;

\echo '== R1 raw lots: received - issued = on hand, per lot (mg)'
with lot as (
  select ib.inventory_batch_id, ib.material_id, (ib.quantity_on_hand * m.f)::bigint as on_hand_mg,
         (coalesce((select sum(e.event_qty) from inventory.inventory_event_history e
                     where e.inventory_batch_id = ib.inventory_batch_id and e.event_type = 'RECEIVE'), 0) * m.f)::bigint as received_mg,
         (coalesce((select sum(e.event_qty) from inventory.inventory_event_history e
                     where e.inventory_batch_id = ib.inventory_batch_id and e.event_type like 'PRODUCTION_ISSUE%'), 0) * m.f)::bigint as issued_mg,
         (coalesce((select sum(fl.actual_mg) from production.floor_line fl where fl.picked_batch_id = ib.inventory_batch_id and fl.actual_mg is not null), 0))::bigint as weighed_mg
    from inventory.inventory_batch ib join _mg m on m.uom_id = ib.uom_id
   where ib.rm_batch_id is not null)
select count(*) as lots,
       sum(received_mg) as received_mg, sum(issued_mg) as issued_mg, sum(on_hand_mg) as on_hand_mg, sum(weighed_mg) as weighed_mg,
       count(*) filter (where received_mg - issued_mg <> on_hand_mg) as lots_not_balancing,
       count(*) filter (where issued_mg <> weighed_mg) as lots_issue_ne_weighed,
       count(*) filter (where issued_mg > 0) as lots_touched
  from lot;

\echo '== R2 per floor job: formula target, weighed, debited, ledger issue, oil batch made, genealogy'
select j.job_no, j.stage, ob.batch_number, ob.status as oil_status,
       sum(fl.target_mg)::bigint as target_mg,
       sum(fl.actual_mg)::bigint as weighed_mg,
       sum(fl.debited_mg)::bigint as debited_mg,
       (select (sum(e.event_qty) * 1000)::bigint from inventory.inventory_event_history e
          join production.material_issue mi on mi.material_issue_id = e.reference_document_id
         where mi.production_order_id = j.production_order_id and e.event_type like 'PRODUCTION_ISSUE%') as ledger_issue_mg,
       (ob.produced_qty * m.f)::bigint as oil_made_mg,
       (select (sum(c.consumed_qty) * 1000)::bigint from production.oil_batch_consumption c where c.oil_batch_id = ob.oil_batch_id) as genealogy_mg,
       count(*) filter (where fl.actual_mg < fl.target_mg) as lines_under, count(*) filter (where fl.actual_mg > fl.target_mg) as lines_over,
       count(*) as lines
  from production.floor_job j
  join production.floor_line fl on fl.floor_job_id = j.floor_job_id
  left join production.oil_batch_master ob on ob.oil_batch_id = j.oil_batch_id
  left join _mg m on m.uom_id = ob.uom_id
 group by j.job_no, j.stage, j.production_order_id, ob.oil_batch_id, ob.batch_number, ob.status, ob.produced_qty, m.f
 order by j.job_no;

\echo '== R3 per lot and job: what the lot gave the job equals what the scale read (mg)'
select j.job_no, count(*) as lot_lines,
       count(*) filter (where fl.actual_mg is not null and fl.actual_mg <> fl.debited_mg) as debit_ne_weighed
  from production.floor_line fl join production.floor_job j on j.floor_job_id = fl.floor_job_id
 group by j.job_no order by j.job_no;

\echo '== R4 scaling: the pick list line against order qty x the sealed share (target total vs order)'
select po.order_number, (po.order_qty * m.f)::bigint as order_mg, sum(fl.target_mg)::bigint as target_total_mg,
       (po.order_qty * m.f)::bigint - sum(fl.target_mg)::bigint as order_minus_target_mg
  from production.production_order po join _mg m on m.uom_id = po.uom_id
  join production.floor_job j on j.production_order_id = po.production_order_id
  join production.floor_line fl on fl.floor_job_id = j.floor_job_id
 group by po.order_number, po.order_qty, m.f order by po.order_number;

\echo '== R5 oil -> filled -> finished lot (pack units x pack size), and where the difference is written'
select ob.batch_number, ob.status, (ob.produced_qty * m.f)::bigint as oil_mg,
       pk.order_qty as package_order_units,
       (select sum(d.filled_qty) from packaging.filling_session fs join packaging.filling_session_details d on d.filling_session_id = fs.filling_session_id where fs.package_order_id = pk.package_order_id) as filled_units,
       (select sum(d.rejected_qty) from packaging.filling_session fs join packaging.filling_session_details d on d.filling_session_id = fs.filling_session_id where fs.package_order_id = pk.package_order_id) as rejected_units,
       s.pack_size, fg.batch_number as fg_lot, fg.produced_qty as fg_units, fg.status as fg_status,
       (select count(*) from packaging.finished_goods_batch_consumption c where c.finished_good_batch_id = fg.finished_good_batch_id) as fg_consumption_rows
  from production.oil_batch_master ob
  left join _mg m on m.uom_id = ob.uom_id
  left join packaging.package_order pk on pk.oil_batch_id = ob.oil_batch_id
  left join packaging.finished_good_batch_master fg on fg.package_order_id = pk.package_order_id
  left join packaging.product_sku s on s.product_sku_id = fg.product_sku_id
 order by ob.batch_number;

\echo '== R6 anything that records a loss, a yield or a write-off'
select table_schema || '.' || table_name as candidate from information_schema.columns
 where table_schema in ('production', 'packaging', 'inventory')
   and (column_name ~ '(yield|loss|scrap|wastage|write_?off|remnant|variance)')
 group by 1 order by 1;
rollback;
