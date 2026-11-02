-- Migration: 2026-11-02-production-order-number (FACTORY-DEFECTS). A production order had no number
-- of its own, so every screen showed the first 8 characters of its uuidv7: a clock, near-identical
-- across orders made together (01A19912, 01A19913).
--
-- ADDITIVE + IDEMPOTENT (PB-16 convention). Existing orders get their number from the tail of their
-- id, the same rule new orders use (planning.service.ts). Nullable: nothing else changes. Main only.

-- @target: main

alter table production.production_order add column if not exists order_number varchar(40);
update production.production_order
   set order_number = 'MO-' || upper(right(replace(production_order_id::text, '-', ''), 12))
 where order_number is null;
create unique index if not exists production_order_order_number_uq on production.production_order (order_number);
