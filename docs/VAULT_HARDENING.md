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
`createFormulaClient`). PB-03: **production (`APP_ENV=prod`) now REFUSES to fall back to
`DATABASE_URL`** — `createFormulaClient` throws a clear boot error if `FORMULA_DATABASE_URL` is
unset in prod, and `backend/api/src/main.ts` runs a boot-time self-check
(`assertMainRoleCannotReadVault`, `backend/api/src/vault-isolation-check.ts`) that queries
`formula.formula_vault`/`formula.formula_ingredients` through the MAIN app's own `PG_CLIENT` and
refuses to start if either read succeeds. `scripts/provision-vault-isolation.sql` creates a
least-privilege `ra_vault` role and **surgically** revokes the main role's access to every table
that can hold recoverable secret material (`formula_ingredients`, `formula_stage_ingredients`,
`formula_vault`, `formula_access_policy`, `formula_approval`) — while keeping the non-secret
formula reads (`formula_master`, `formula_version`, `formula_event_hist`, `audit_events`) that the
dashboards + audit BFF need (`backend/api/src/dashboard/dashboard.service.ts`). The script is now
idempotent (safe to re-run).

**Order matters** (in the script): create + grant `ra_vault` → set `FORMULA_DATABASE_URL=ra_vault` +
redeploy → *then* revoke the main role. Running the revoke first would break the running vault. Not
auto-applied (it changes live DB grants); the owner/P0 applies it in a maintenance window — see
`DEPLOY.md` §3b for the full sequence, including the AWS KMS rewrap step.

After this: a compromise of the main app role / `DATABASE_URL` yields no recipe ciphertext and no
wrapped DEK — and both are useless without the KEK/CMK anyway. In production the wrapping key is a
real AWS KMS customer-managed key (`AwsKmsAdapter`, `backend/cluster-formula/src/crypto/aws-kms.adapter.ts`
— envelope encryption via `GenerateDataKey`/`Encrypt`/`Decrypt`, encryption context bound to
tenant+formula+vault-row, fail-closed on any KMS error/timeout); the env/file KEK adapters
(`EnvKmsAdapter`/`FileKmsAdapter`) are dev/test only as of PB-03 —
`resolveKmsAdapter`/`formula.module.ts` refuses to construct anything but `AwsKmsAdapter` when
`APP_ENV=prod`. Existing formulas move to the new key via `scripts/vault-rewrap.ts` (dry-run
default, preserves each DEK bit-for-bit, idempotent).

## Still open (design-dependent, deferred)
`FORMULA_ACCESS_POLICY` role-scoped grants still don't reach a non-owner (the edge perm is owner-only),
and there's no policy-grant revoke UI. Non-owner scoped read access is a Phase-2 access-control design.

PB-03 items NOT covered by this lane (code-side only; tracked separately per
`release/FINAL_OS_EXECUTION_STATE.json`): a dedicated Multi-AZ private `vault_prod` RDS instance
and its own EC2/network isolation (PB-01/SB-04), a live restore drill, and live
formulator/approver + owner-negative proof against a real deployed AWS KMS key (V5 §16).
