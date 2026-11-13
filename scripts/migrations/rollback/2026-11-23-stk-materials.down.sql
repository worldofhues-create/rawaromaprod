-- Rollback of 2026-11-23-stk-materials (STK-16, STK-18, STK-19). Seeded families are removed only where
-- no floor code uses them (a printed colour is never taken away). Supplier lots and hazard classes are lost.
-- @target: main
delete from masterdata.floor_family_colour f
 where f.updated_by = 'migration:2026-11-23-stk-materials'
   and not exists (select 1 from masterdata.floor_code c where c.family_code = f.family_code);
alter table masterdata.material drop constraint if exists material_hazard_class_chk;
alter table masterdata.material drop column if exists hazard_source;
alter table masterdata.material drop column if exists hazard_class;
drop index if exists inventory.rm_batch_master_supplier_lot_idx;
alter table inventory.rm_batch_master drop column if exists supplier_lot_ref;
alter table inventory.grn_items drop column if exists supplier_lot_ref;
