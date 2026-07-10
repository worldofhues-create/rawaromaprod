# Vault hardening (#6) — access-control, isolation, tamper-evidence

Hardening for the crown-jewel Formula Vault, on top of the existing envelope encryption (per-formula
DEK, AES-256-GCM, KEK-wrapped, KEK never in Postgres) and the hash-chained access audit.

## 1. Append-only access audit — DONE (auto-applied)
`data-kernel/audit.ts` mandates the access log be append-only "with a table grant … not here", but it
was never provisioned. `scripts/create-vault-audit-guard.cjs` installs a `BEFORE UPDATE OR DELETE`
trigger on `formula.audit_events` that raises on any modify/delete — stronger than a grant (role-
independent). Even a DB-write attacker can't rewrite or delete a row of the tamper-evident log; the
vault's own append (INSERT) is unaffected. Included in `pnpm db:provision`.

## 2. Runtime chain verification — DONE
`GET /v1/formula-audit-verify` (owner-only, `formula:actual:read`) → `VaultService.verifyAuditChain()`
walks the chain by `chain_seq` and checks: strictly-monotonic no-gap seq · `prev_hash` links to the
prior row · `row_hash` recomputes = `KEK-HMAC(prev_hash || canonical(row))`. Any tampered / deleted /
reordered row breaks the recompute (an attacker without the KEK can't forge it). Returns
`{ ok, rows, firstBadSeq, reason }`.

## 3. `ra_vault` role-isolation — SCRIPT + RUNBOOK (apply deliberately)
The vault reads the formula schema through its own connection (`FORMULA_DATABASE_URL` /
`createFormulaClient`), but in the single-Neon deploy that falls back to `DATABASE_URL`, so the main
app role can read the ciphertext. `scripts/provision-vault-isolation.sql` creates a least-privilege
`ra_vault` role and **surgically** revokes the main role's access to the crown-jewel tables only
(`formula_ingredients`, `formula_stage_ingredients`, `formula_vault`) — while keeping the non-secret
formula reads (`formula_master`, `formula_event_hist`, `audit_events`) that the dashboards + audit BFF
need.

**Order matters** (in the script): create + grant `ra_vault` → set `FORMULA_DATABASE_URL=ra_vault` +
redeploy → *then* revoke the main role. Running the revoke first would break the running vault. Not
auto-applied (it changes live DB grants); the owner applies it in a maintenance window.

After this: a compromise of the main app role / `DATABASE_URL` yields no recipe ciphertext and no
wrapped DEK — and both are useless without the KEK anyway. Layered with the offline-KEK `FileKmsAdapter`
(see `OFFLINE_CONSOLE.md`), the recipe is protected by encryption **and** role-isolation **and** an
optionally-offline key.

## Still open (design-dependent, deferred)
`FORMULA_ACCESS_POLICY` role-scoped grants still don't reach a non-owner (the edge perm is owner-only),
and there's no policy-grant revoke UI. Non-owner scoped read access is a Phase-2 access-control design.
