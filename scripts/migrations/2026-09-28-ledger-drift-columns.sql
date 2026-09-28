-- Migration: 2026-09-28-ledger-drift-columns (lane platform-roles)
--
-- ADDITIVE + IDEMPOTENT ONLY (PB-16 convention).
--
-- Why this file exists: production's schema_migrations ledger recorded 0005_procurement.sql and
-- 0010_sales.sql on 2026-09-24 00:17 UTC, BEFORE commit a9e8c2e (G1/G2/G8) regenerated those two
-- files with new ADD COLUMN IF NOT EXISTS lines. scripts/db-migrate.ts skips a block whose id is
-- already in the ledger, so the new lines never ran on production and the code that reads them
-- failed: GET /v1/sales-orders -> 500 `column "origin" does not exist`, and the PO cancel path
-- writes purchase_order.cancellation_reason. A read-only diff of every column the migration files
-- declare against production's information_schema (2026-09-28) found exactly these four missing
-- and no missing table.
--
-- Rule this implies: never add statements to a migration file that may already be in a ledger —
-- add a new, later-sorting file (like this one). The statements below are copied from
-- 0005_procurement.sql / 0010_sales.sql verbatim, so on a fresh database (where those files
-- already created the columns) this file is a no-op.
-- @target: main

ALTER TABLE "procurement"."purchase_order" ADD COLUMN IF NOT EXISTS "cancellation_reason" text;
ALTER TABLE "sales"."sales_order" ADD COLUMN IF NOT EXISTS "origin" varchar(30);
ALTER TABLE "sales"."sales_order" ADD COLUMN IF NOT EXISTS "alembic_ref" uuid;
ALTER TABLE "sales"."sales_order" ADD COLUMN IF NOT EXISTS "continuity_reason" text;
CREATE INDEX IF NOT EXISTS "sales_order_alembic_ref_idx" ON "sales"."sales_order" USING btree ("alembic_ref");
