-- STAGE-2-RP: batches as production (ee14722) holds them BEFORE the stage-2 release, one in each state a
-- deploy can find. Only columns that exist at ee14722 are named, so this file applies to a database at
-- that commit; the release's migrations then meet these rows. __TAG__ is replaced by the caller; every
-- id is md5(tag || name), so the same tag is the same rows, and every insert is ON CONFLICT DO NOTHING.
-- Used by backend/api/src/__tests__/stage2-existing-batches.test.ts (which applies it itself, or finds the
-- rows already there when STAGE2_LEGACY_TAG names a tag applied before the database was migrated forward).
insert into platform.uom_master (uom_id, uom_code, uom_name, status)
  select md5('stage2-legacy-kg')::uuid, 'kg', 'Kilogram', 'ACTIVE' where not exists (select 1 from platform.uom_master where lower(uom_code) = 'kg');
insert into packaging.product_master (product_id, product_code, product_name, status)
  values (md5('__TAG__product')::uuid, 'LEG-__TAG__', 'Legacy product __TAG__', 'ACTIVE') on conflict do nothing;
insert into packaging.product_sku (product_sku_id, product_id, sku_code, pack_size, status)
  values (md5('__TAG__sku')::uuid, md5('__TAG__product')::uuid, 'LEGSKU-__TAG__', '1 kg', 'ACTIVE') on conflict do nothing;

-- one plan line, order and oil batch per state
insert into production.production_plan_items (production_plan_item_id, formula_id, planned_qty, status)
  select md5('__TAG__plan' || n)::uuid, md5('__TAG__formula')::uuid, 10, 'ACTIVE' from unnest(array['mixed','qc1typed','rested','resting','norun','released','fgmade']) n on conflict do nothing;
insert into production.production_order (production_order_id, production_plan_item_id, order_qty, status)
  select md5('__TAG__order' || n)::uuid, md5('__TAG__plan' || n)::uuid, 10, 'ACTIVE' from unnest(array['mixed','qc1typed','rested','resting','norun','released','fgmade']) n on conflict do nothing;
insert into production.oil_batch_master (oil_batch_id, production_order_id, batch_number, produced_qty, uom_id, produced_dt, status, created_by, updated_by)
  select md5('__TAG__oil' || s.n)::uuid, md5('__TAG__order' || s.n)::uuid, 'LEG-' || upper(s.n) || '-__TAG__', 10,
         (select uom_id from platform.uom_master where lower(uom_code) = 'kg' limit 1), now() - make_interval(days => s.age), s.status, 'legacy', 'legacy'
    from (values ('mixed', 10, 'PRODUCED'),        -- mixed ten days ago, nothing decided
                 ('qc1typed', 10, 'PRODUCED'),     -- mixed, QC 1 typed as PASS, not yet sent to rest
                 ('rested', 25, 'IN_MATURATION'),  -- resting under its formula's 14 days since 20 days ago: served
                 ('resting', 5, 'IN_MATURATION'),  -- resting under its formula's 14 days since 3 days ago: not served
                 ('norun', 12, 'IN_MATURATION'),   -- IN_MATURATION with no rest run: its formula had no setting
                 ('released', 40, 'RELEASED'),     -- released before the deploy, filled, no finished batch yet
                 ('fgmade', 40, 'RELEASED')        -- released before the deploy, finished batch made with a typed lot
         ) s(n, age, status) on conflict do nothing;

-- typed QC results, as the factory recorded QC before the rounds
insert into production.production_qc (production_qc_id, oil_batch_id, observed_value, result, inspection_dt, status, created_dt, created_by, updated_by)
  select md5('__TAG__qc' || s.n || s.k)::uuid, md5('__TAG__oil' || s.n)::uuid, 1.47, 'PASS', now() - make_interval(days => s.age), 'ACTIVE', now() - make_interval(days => s.age), 'legacy', 'legacy'
    from (values ('qc1typed', '1', 9), ('rested', '1', 21), ('rested', '2', 1), ('resting', '1', 4), ('norun', '1', 11), ('norun', '2', 1)) s(n, k, age) on conflict do nothing;

-- the two rest runs opened before the deploy, under a formula's own setting (14 to 30 days)
insert into production.maceration_run (maceration_run_id, oil_batch_id, formula_id, status, started_at, min_days, max_days, qc1_production_qc_id, created_at, updated_at)
  select md5('__TAG__run' || s.n)::uuid, md5('__TAG__oil' || s.n)::uuid, md5('__TAG__formula')::uuid, 'MACERATING', now() - make_interval(days => s.age), 14, 30,
         md5('__TAG__qc' || s.n || '1')::uuid, now() - make_interval(days => s.age), now() - make_interval(days => s.age)
    from (values ('rested', 20), ('resting', 3)) s(n, age) on conflict do nothing;

-- finished goods: a filled package order with no finished batch yet, and one whose finished batch has a typed lot
insert into packaging.package_order (package_order_id, product_sku_id, oil_batch_id, order_qty, uom_id, status, created_by, updated_by)
  select md5('__TAG__pkg' || n)::uuid, md5('__TAG__sku')::uuid, md5('__TAG__oil' || n)::uuid, 4,
         (select uom_id from platform.uom_master where lower(uom_code) = 'kg' limit 1), 'IN_PROGRESS', 'legacy', 'legacy' from unnest(array['released','fgmade']) n on conflict do nothing;
insert into packaging.filling_session (filling_session_id, package_order_id, session_start_dt, session_end_dt, status, created_by, updated_by)
  select md5('__TAG__fill' || n)::uuid, md5('__TAG__pkg' || n)::uuid, now() - interval '2 days', now() - interval '2 days', 'DONE', 'legacy', 'legacy' from unnest(array['released','fgmade']) n on conflict do nothing;
insert into packaging.filling_session_details (filling_session_detail_id, filling_session_id, filled_qty, uom_id, rejected_qty, recorded_dt, status, created_by, updated_by)
  select md5('__TAG__filld' || n)::uuid, md5('__TAG__fill' || n)::uuid, 4, (select uom_id from platform.uom_master where lower(uom_code) = 'kg' limit 1), 0, now() - interval '2 days', 'ACTIVE', 'legacy', 'legacy'
    from unnest(array['released','fgmade']) n on conflict do nothing;
insert into packaging.finished_good_batch_master (finished_good_batch_id, package_order_id, product_sku_id, batch_number, produced_qty, uom_id, manufacturing_date, expiry_date, status, created_by, updated_by)
  values (md5('__TAG__fg')::uuid, md5('__TAG__pkgfgmade')::uuid, md5('__TAG__sku')::uuid, 'LEG-FG-__TAG__', 4,
          (select uom_id from platform.uom_master where lower(uom_code) = 'kg' limit 1), current_date - 2, current_date + 700, 'ACTIVE', 'legacy', 'legacy') on conflict do nothing;
