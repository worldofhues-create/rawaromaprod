-- Migration: 2026-11-23-stk-materials (STOCK-FIX-RP: STK-16, STK-17, STK-18, STK-19).
--
-- STK-16  A raw lot could not be traced to the supplier's batch: no goods-receipt field held the
--         supplier's lot reference. inventory.grn_items.supplier_lot_ref and the same column on the
--         raw lot it creates (inventory.rm_batch_master). Null when the supplier gave none: never made up.
-- STK-18  The master had no hazard class. masterdata.material.hazard_class is the UN dangerous-goods
--         class as a person read it off a source (the SDS, the supplier's declaration), and
--         hazard_source names that source; a class is never stored without one, and "not regulated"
--         is a class like any other, so it needs a source too. Null is "classification pending", which
--         every floor screen already prints (rule 1: the absence of a restriction is never asserted).
-- STK-19  No floor-code families existed, not even Signal (D-2). The nine families D-2 names are
--         seeded (the Factory prototype's colours, and Signal #2F5DFF for the solvents); a family or a
--         colour already on file is left as it is. Numbers are now issued in order (the service).
-- ADDITIVE + IDEMPOTENT. Rollback: scripts/migrations/rollback/2026-11-23-stk-materials.down.sql

-- @target: main

alter table inventory.grn_items add column if not exists supplier_lot_ref varchar(100);
alter table inventory.rm_batch_master add column if not exists supplier_lot_ref varchar(100);
create index if not exists rm_batch_master_supplier_lot_idx on inventory.rm_batch_master (supplier_lot_ref) where supplier_lot_ref is not null;

alter table masterdata.material add column if not exists hazard_class varchar(16);
alter table masterdata.material add column if not exists hazard_source text;
alter table masterdata.material drop constraint if exists material_hazard_class_chk;
alter table masterdata.material add constraint material_hazard_class_chk check (
  hazard_class is null or (
    hazard_class in ('1', '2.1', '2.2', '2.3', '3', '4.1', '4.2', '4.3', '5.1', '5.2', '6.1', '6.2', '7', '8', '9', 'NOT_REGULATED')
    and hazard_source is not null and btrim(hazard_source) <> ''));

insert into masterdata.floor_family_colour (family_code, family_name, colour_name, colour_hex, initial, updated_by)
select v.code, v.name, v.colour, v.hex, v.initial, 'migration:2026-11-23-stk-materials'
  from (values ('citrus', 'Citrus', 'Yellow', '#E8C547', 'Y'), ('woody', 'Woody', 'Brown', '#7A4E2D', 'B'),
               ('musk', 'Musk', 'Grey', '#8A8A93', 'G'), ('floral', 'Floral', 'Pink', '#E07A9B', 'P'),
               ('aldehydic', 'Aldehydic', 'White', '#F4F4F6', 'W'), ('spicy', 'Spicy', 'Red', '#C8322B', 'R'),
               ('amber', 'Amber', 'Orange', '#E5781F', 'O'), ('aquatic', 'Aquatic', 'Teal', '#0C8A8A', 'T'),
               ('solvent', 'Solvent', 'Signal', '#2F5DFF', 'S')) as v(code, name, colour, hex, initial)
 where not exists (select 1 from masterdata.floor_family_colour f where f.family_code = v.code or upper(f.colour_name) = upper(v.colour));
