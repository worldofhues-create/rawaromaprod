-- Migration: 2026-11-21-stk-reserve-at-planning (STOCK-FIX-RP: STK-7, STK-8, STK-9; LD-19 "reserve at
-- formula grams x batch size").
--
-- STK-9: nothing was reserved when a production order was planned. A shortfall surfaced only when the
-- picker found the shelf short, and two orders could both be planned on the same last kilogram. Now
-- planning reserves each line's mass on one raw lot (the floor's picking rule: FEFO, then receipt
-- order; QC-released, unheld, unexpired lots only), as inventory.stock_reservation rows for the order
-- (the convention the consumption debit already consumes), and records on the line what it holds:
--   required_mg        the line in integer mg, from the Vault's largest-remainder split (STK-7): the
--                      lines total the order exactly, whatever unit the order is in
--   reserved_mg        what planning reserved for the line (0 = short at planning)
--   reserved_batch_id  the lot it is reserved on
-- A cancelled order releases its reservations; the issue at the floor consumes them.
--
-- ADDITIVE + IDEMPOTENT. Existing lines keep null required_mg and reserve nothing (they were planned
-- before this rule). Rollback: scripts/migrations/rollback/2026-11-21-stk-reserve-at-planning.down.sql

-- @target: main

alter table production.production_order_ingredients add column if not exists required_mg bigint;
alter table production.production_order_ingredients add column if not exists reserved_mg bigint;
alter table production.production_order_ingredients add column if not exists reserved_batch_id uuid;
alter table production.production_order_ingredients drop constraint if exists production_order_ingredients_mg_chk;
alter table production.production_order_ingredients add constraint production_order_ingredients_mg_chk
  check ((required_mg is null or required_mg > 0) and (reserved_mg is null or (reserved_mg >= 0 and (required_mg is null or reserved_mg <= required_mg))));
-- STAGE-2-RP: this file used to end with
--   create index if not exists stock_reservation_document_idx ... where released_dt is null;
-- which created nothing on any database: 0006_inventory.sql already makes an index of that name (on
-- the same column, without the WHERE), so IF NOT EXISTS skipped it. But the rollback DROPPED that
-- name, taking 0006's index with it, and the next db:migrate then made the partial one: a database
-- that had been rolled back and re-applied no longer matched one that never was (found by the
-- release's down-and-up proof). 0006's index serves the lookup by order, so nothing is added here
-- and nothing is dropped there.
