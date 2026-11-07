-- Rollback: 2026-11-07-stock3. The quantities are lost; issued_qty keeps what it last said, so a line
-- left open by a partial issue stays open under the old code until something issues it.

-- @target: main

alter table production.production_order_ingredients drop column if exists issued_amount;
