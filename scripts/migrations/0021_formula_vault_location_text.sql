-- HAND-WRITTEN (release-convergence fix, rc-rawprod-2026-09-24.4).
-- formula_vault.vault_location holds JSON.stringify(<wrapped DEK / KMS envelope>)
-- (formulas.service.ts, vault-rewrap.ts); an AWS KMS envelope exceeds varchar(255), so
-- every seal failed with "value too long for type character varying(255)".
-- Widening varchar -> text is metadata-only in Postgres (no rewrite) and idempotent.
-- @target: formula
ALTER TABLE "formula"."formula_vault" ALTER COLUMN "vault_location" TYPE text;
