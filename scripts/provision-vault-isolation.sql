-- #6 Vault role-isolation (the crown-jewel wall). The vault code already reads the formula schema
-- through its OWN connection (FORMULA_DATABASE_URL / createFormulaClient) — but in the current
-- single-Neon deploy that falls back to DATABASE_URL, so the MAIN app role can read the ciphertext.
-- This provisions a least-privilege `ra_vault` role and REVOKES the main role's access to the
-- crown-jewel tables ONLY (ciphertext + wrapped DEK), while keeping the non-secret formula reads
-- (formula_master / formula_event_hist / audit_events) that the dashboards + audit BFF rely on.
--
-- Result: a compromise of the main app role / DATABASE_URL yields NO recipe ciphertext and NO
-- wrapped key — and even those are useless without the KEK (held off-DB). Defense in depth.
--
-- ORDER OF OPERATIONS (critical — do NOT run the REVOKE before the vault uses ra_vault):
--   1. Run steps 1–2 below (create ra_vault, grant it the formula schema).
--   2. Set FORMULA_DATABASE_URL in the app env to the ra_vault connection string; redeploy.
--      (The vault now reads ciphertext as ra_vault; the main role no longer needs it.)
--   3. THEN run step 3 (revoke the main role's access to the crown-jewel tables).
-- Running step 3 while FORMULA_DATABASE_URL still falls back to the main role WILL break the vault.
--
-- On Neon, create the role via the Neon console/API if `CREATE ROLE` is restricted; the GRANT/REVOKE
-- statements run as the DB owner. Replace <STRONG_PASSWORD> and <MAIN_ROLE> (e.g. neondb_owner).

-- 1) least-privilege vault role
CREATE ROLE ra_vault LOGIN PASSWORD '<STRONG_PASSWORD>';
GRANT USAGE ON SCHEMA formula TO ra_vault;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA formula TO ra_vault;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA formula TO ra_vault;
ALTER DEFAULT PRIVILEGES IN SCHEMA formula GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ra_vault;

-- 2) (do the env switch to FORMULA_DATABASE_URL=ra_vault here, then redeploy, BEFORE step 3)

-- 3) surgical revoke: the MAIN app role loses the crown jewels but keeps non-secret formula reads.
REVOKE SELECT, INSERT, UPDATE, DELETE ON formula.formula_ingredients        FROM <MAIN_ROLE>;
REVOKE SELECT, INSERT, UPDATE, DELETE ON formula.formula_stage_ingredients  FROM <MAIN_ROLE>;
REVOKE SELECT, INSERT, UPDATE, DELETE ON formula.formula_vault              FROM <MAIN_ROLE>;
-- (formula_master, formula_version, formula_event_hist, audit_events stay readable by the main
--  role so dashboards, traceability, and the access-audit view keep working.)

-- Verify: as <MAIN_ROLE>, `SELECT * FROM formula.formula_ingredients LIMIT 1;` must now be denied,
-- while `SELECT formula_code FROM formula.formula_master LIMIT 1;` still works.
