-- Migration: 2026-09-24-ui-parity (security review item 8)
--
-- ADDITIVE + IDEMPOTENT ONLY: every statement is `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`
-- / a guarded DO block. Safe to run against a fresh db:push'd database (no-ops, columns/table
-- already exist) or an already-live one that predates the ui-parity branch. Never drops or
-- renames anything.
--
-- Why this file exists: `scripts/db-push.ts` is CREATE-ONCE — `pushGroup()` skips a whole
-- schema the instant `information_schema.tables` shows ANY table already in it. The
-- ui-parity branch added new columns to `formula.formula_version` and
-- `procurement.purchase_order`, plus a whole new `packaging.packaging_qc` table, straight into
-- the Drizzle schema files (packages/data-formula, packages/data-procurement,
-- packages/data-packaging) without a migration. On a FRESH database db:push already produces
-- the right shape (it diffs the current schema files) — this migration only matters for a
-- database that was provisioned BEFORE these columns/table were added to the schema files.
--
-- Two targets, split by the "-- @target:" marker comments below (scripts/db-migrate.ts parses
-- them and sends each block to the right connection):
--   formula -> FORMULA_DATABASE_URL (falls back to DATABASE_URL) — the formula.* schema lives
--              on its own `ra_vault`-role connection (scripts/db-schema-groups.ts).
--   main    -> DATABASE_URL — every other schema (procurement, packaging, ...).

-- @target: formula
-- §109.8 lifecycle columns on formula.formula_version — submitted_by/dt (submit-for-review),
-- locked_by/dt (lock), superseded_by_version_id (automatic on the successor's approval). See
-- packages/data-formula/src/schema/master.ts.
ALTER TABLE formula.formula_version ADD COLUMN IF NOT EXISTS submitted_by uuid;
ALTER TABLE formula.formula_version ADD COLUMN IF NOT EXISTS submitted_dt timestamptz;
ALTER TABLE formula.formula_version ADD COLUMN IF NOT EXISTS locked_by uuid;
ALTER TABLE formula.formula_version ADD COLUMN IF NOT EXISTS locked_dt timestamptz;
ALTER TABLE formula.formula_version ADD COLUMN IF NOT EXISTS superseded_by_version_id uuid;
CREATE INDEX IF NOT EXISTS formula_version_superseded_by_idx ON formula.formula_version (superseded_by_version_id);

-- @target: main
-- Self-ref "Generate replacement PO" flow (FAIL-03/04) — packages/data-procurement/src/schema/po.ts.
ALTER TABLE procurement.purchase_order ADD COLUMN IF NOT EXISTS replacement_of_po_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_order_replacement_of_po_id_fk'
  ) THEN
    ALTER TABLE procurement.purchase_order
      ADD CONSTRAINT purchase_order_replacement_of_po_id_fk
      FOREIGN KEY (replacement_of_po_id) REFERENCES procurement.purchase_order (purchase_order_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS purchase_order_replacement_of_po_idx ON procurement.purchase_order (replacement_of_po_id);

-- Finished-good packaging QC gate (Phase-1A Data Dictionary revision, doc 10 Phase-1B) — a
-- whole new table. packages/data-packaging/src/schema/qc.ts. uuidv7() must already exist
-- (scripts/db-push.ts's PREREQS installs it on every connection this migration also assumes
-- has already been provisioned by db:push).
CREATE TABLE IF NOT EXISTS packaging.packaging_qc (
  packaging_qc_id uuid PRIMARY KEY DEFAULT uuidv7(),
  finished_good_batch_id uuid REFERENCES packaging.finished_good_batch_master (finished_good_batch_id),
  leakage_check varchar(30),
  label_check varchar(30),
  carton_check varchar(30),
  overall_result varchar(30),
  inspected_by uuid,
  inspection_dt timestamptz,
  status varchar(30),
  created_dt timestamptz NOT NULL DEFAULT now(),
  updated_dt timestamptz NOT NULL DEFAULT now(),
  created_by varchar(255),
  updated_by varchar(255)
);
CREATE INDEX IF NOT EXISTS packaging_qc_batch_idx ON packaging.packaging_qc (finished_good_batch_id);
