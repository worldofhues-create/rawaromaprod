-- #6 / PB-03 / SB-01 — Vault role-isolation (the crown-jewel wall). The vault code reads the
-- formula schema through its OWN connection (FORMULA_DATABASE_URL / createFormulaClient), and
-- as of PB-03 production REFUSES to fall back to DATABASE_URL (formula.tokens.ts throws a
-- boot error instead) — so this script's step 2 is now a hard prerequisite, not an optional
-- hardening step. This provisions a least-privilege `ra_vault` role and REVOKES the main
-- role's access to every table that can hold recoverable secret material (ciphertext + wrapped
-- DEK + access-control/approval metadata), while keeping the non-secret formula reads
-- (formula_master / formula_version / formula_event_hist / audit_events) that the dashboards +
-- audit BFF rely on (backend/api/src/dashboard/dashboard.service.ts queries those four via the
-- MAIN role today — revoking them would be a real regression, not a hardening).
--
-- Result: a compromise of the main app role / DATABASE_URL yields NO recipe ciphertext, NO
-- wrapped key, and NO access-policy/approval metadata — and even those are useless without the
-- KEK/CMK (held off-DB / in AWS KMS). Defense in depth.
--
-- IDEMPOTENT: safe to re-run. CREATE ROLE is guarded by an existence check (Postgres has no
-- native `CREATE ROLE IF NOT EXISTS`); every GRANT/REVOKE/ALTER DEFAULT PRIVILEGES statement is
-- naturally idempotent in Postgres (re-granting/re-revoking an already-granted/revoked
-- privilege is a no-op, not an error).
--
-- ORDER OF OPERATIONS (critical — do NOT run step 3 before the vault is actually reading as
-- ra_vault):
--   1. Run steps 1-2 below (create ra_vault, grant it the formula schema).
--   2. Set FORMULA_DATABASE_URL in the app env to the ra_vault connection string; redeploy.
--      (The vault now reads ciphertext as ra_vault; the main role no longer needs it.)
--   3. THEN run step 3 (revoke the main role's access to the crown-jewel tables).
-- Running step 3 while FORMULA_DATABASE_URL still falls back to the main role WILL break the
-- vault. (In production this can no longer happen silently — createFormulaClient throws if
-- FORMULA_DATABASE_URL is unset under APP_ENV=prod — but the order still matters for a
-- non-prod / staging run against this same script.)
--
-- On a managed Postgres where `CREATE ROLE` is restricted, create the role via the provider's
-- console/API instead and skip straight to step 1's GRANTs, run as the DB owner. Replace
-- <STRONG_PASSWORD> and <MAIN_ROLE> (e.g. the app's normal DATABASE_URL role) below.

-- 1) least-privilege vault role (idempotent: create only if it doesn't already exist)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ra_vault') THEN
    CREATE ROLE ra_vault LOGIN PASSWORD '<STRONG_PASSWORD>';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA formula TO ra_vault;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA formula TO ra_vault;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA formula TO ra_vault;
ALTER DEFAULT PRIVILEGES IN SCHEMA formula GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ra_vault;

-- 2) (do the env switch to FORMULA_DATABASE_URL=ra_vault here, then redeploy, BEFORE step 3)

-- 3) surgical revoke: the MAIN app role loses every table that can hold recoverable secret
-- material but keeps non-secret formula reads (dashboards/traceability/audit BFF).
REVOKE SELECT, INSERT, UPDATE, DELETE ON formula.formula_ingredients        FROM <MAIN_ROLE>;
REVOKE SELECT, INSERT, UPDATE, DELETE ON formula.formula_stage_ingredients  FROM <MAIN_ROLE>;
REVOKE SELECT, INSERT, UPDATE, DELETE ON formula.formula_vault              FROM <MAIN_ROLE>;
REVOKE SELECT, INSERT, UPDATE, DELETE ON formula.formula_access_policy     FROM <MAIN_ROLE>;
REVOKE SELECT, INSERT, UPDATE, DELETE ON formula.formula_approval          FROM <MAIN_ROLE>;
-- (formula_master, formula_version, formula_event_hist, audit_events stay readable by the main
--  role so dashboards, traceability, and the access-audit view keep working — see
--  backend/api/src/dashboard/dashboard.service.ts and VAULT_HARDENING.md §3.)

-- Verify (run as <MAIN_ROLE>, or via `SET ROLE`):
--   SELECT * FROM formula.formula_vault LIMIT 1;         -- must now be DENIED
--   SELECT * FROM formula.formula_ingredients LIMIT 1;   -- must now be DENIED
--   SELECT * FROM formula.formula_access_policy LIMIT 1; -- must now be DENIED
--   SELECT * FROM formula.formula_approval LIMIT 1;      -- must now be DENIED
--   SELECT formula_code FROM formula.formula_master LIMIT 1; -- must still WORK
-- The RawProd API also runs this same check automatically at boot when APP_ENV=prod
-- (backend/api/src/main.ts assertMainRoleCannotReadVault) and refuses to start if it fails.
