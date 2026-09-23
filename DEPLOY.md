> **RETIRED-for-production (PB-01, L-DEP).** This Vercel + Render + Neon runbook is no longer
> the production deploy path — FINAL_OS §2.2/§5/§41 require AWS-only (EC2 + systemd + nginx +
> RDS PostgreSQL; no Vercel/Render/Neon/Aurora). The AWS path lives in `infra/aws/` and
> `infra/aws/DEPLOY_AWS.md`. This file is kept, not deleted, because a Vercel/Render preview
> deploy is still a legitimate way to demo a branch before AWS cutover (MIGRATION_AWS_PLAN.md
> Phase D7 decommissions it only after 7 days green + a restore drill) — it is retired as the
> path to PRODUCTION, not removed as a tool.

# RAW AROMACHEM — Go-Live Runbook (Vercel + Render + Neon)

Topology: **Vercel** (static portal `web/`) → rewrites the encrypted tunnel to **Render**
(NestJS API + in-process worker) → **Neon** Postgres. Only `POST /rpc` and `POST /crypto/handshake`
(ciphertext) ever appear in the browser network tab — the backend host is proxied, never exposed.

---

## 0. ⚠️ Rotate the secrets first (they were shared in chat)

Everything below was pasted in plaintext during development and **must be rotated before this is
public**:

| Secret | Action |
| --- | --- |
| **Neon DB password** | Reset the role password in the Neon console; update `DATABASE_URL`. |
| **JWT_SECRET** | New value: `openssl rand -base64 48` |
| **FORMULA_KEK** | DEV/TEST ONLY as of PB-03 — production uses AWS KMS instead (see §3b below) and ignores this var entirely. If still using it for a non-prod environment: `openssl rand -base64 32` — ⚠️ this is the formula-vault key-encryption key. If any formula ciphertext already exists with the old KEK, re-encrypt (`scripts/vault-rewrap.ts`) or re-seed; rotating it invalidates old sealed recipes. |
| **All demo logins** | The 10 role users currently share one demo password (owner has its own). Reset via the seed with fresh per-role `BOOTSTRAP_*_PASSWORD` values, or disable demo logins. |

Never commit any of these. `.env` is gitignored; `render.yaml` marks them `sync:false` (set in the
Render dashboard).

## 1. Push the repo

`app/` is already a git repo (no remote yet). Create a private GitHub repo and push `main`:

```bash
cd app
gh repo create raw-aroma --private --source . --remote origin
git add -A && git commit -m "RAW AROMACHEM Phase-1"
git push -u origin main
```

## 2. Database (Neon)

Schema (185 tables) + RBAC + Phase-1 demo data are already provisioned on Neon. After rotating the
password, re-point `DATABASE_URL` (DIRECT endpoint, not `-pooler`). To reseed demo data:

```bash
DATABASE_URL=... pnpm db:push           # idempotent schema
DATABASE_URL=... [FORMULA_DATABASE_URL=...] pnpm db:migrate   # additive column/table migrations — ALWAYS run after db:push
DATABASE_URL=... BOOTSTRAP_OWNER_PASSWORD=... pnpm db:seed       # roles + sample logins
DATABASE_URL=... pnpm db:seed:data      # Phase-1 demo dataset (the dashboards read this)
```

`db:push` is CREATE-ONCE (it skips any schema that already has tables), so a database
provisioned before a given branch added new columns/tables to the Drizzle schema files will NOT
pick them up from `db:push` alone. `pnpm db:migrate` applies `scripts/migrations/*.sql` —
additive, idempotent (`ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`), safe to re-run,
and safe to run before OR after `db:seed`. Run it every time after `db:push`, on every
environment (including one being provisioned for the first time — the migrations are no-ops
there since `db:push` already created the current shape).

## 3. Backend (Render)

Render → **New → Blueprint** → pick the repo (it reads `render.yaml`). Then set the four `sync:false`
secrets in the service's Environment tab: `DATABASE_URL`, `JWT_SECRET`, `FORMULA_KEK`, and
`CORS_ORIGINS` (your Vercel origin, e.g. `https://raw-aroma.vercel.app`).

- Node: pinned to 22.12.0 via `.node-version` (avoid Render's default bleeding-edge Node).
- Build: `npm install -g pnpm@10.28.2 && pnpm install --frozen-lockfile --prod=false`
  (NOT `corepack enable` — it fails on Render's read-only `/usr/bin`.)
- Start: `node --import @swc-node/register/esm-register backend/api/src/main.ts`
  (Run from source via the swc loader — the workspace packages export `src/*.ts`, so a compiled
  `dist/main.js` resolves deps to `.ts` and crashes with `ERR_UNKNOWN_FILE_EXTENSION`. Worker runs
  in-process via `RUN_WORKER_IN_PROCESS=true`.)
- Health: `/health`. Free tier sleeps after 15 min idle → first request cold-starts (~30–60 s).
- Verify: `curl https://<your-render-host>/health` → `{"data":{"status":"ok","deps":{"database":"up"}}}`

## 3b. Formula Vault — AWS KMS (PB-03 / V4 §109.2)

The Formula Vault (`@ra/cluster-formula`) reads/writes through its OWN Postgres connection
(never the main `DATABASE_URL` role in production — SB-01) and, in production, wraps every
formula's data-encryption key (DEK) with a real AWS KMS customer-managed key (CMK) instead of
an env/file secret. This section names the config keys and the CMK key-policy shape; it does
NOT change where the process itself runs (Render today per the topology above — the AWS
EC2/systemd target topology is a separate lane, PB-01/S1, not this one).

### Config keys (names only — set actual values as platform secrets, never in git)

| Key | Required when | Notes |
| --- | --- | --- |
| `FORMULA_DATABASE_URL` | **Always in prod** (`APP_ENV=prod`) | Dedicated `ra_vault`-role connection string. Boot FAILS without it in prod — never falls back to `DATABASE_URL` (`scripts/provision-vault-isolation.sql` provisions the role/grants). |
| `FORMULA_KMS_KEY_ID` | **Always in prod** | The CMK id/ARN. Boot FAILS without it in prod — no adapter other than AWS KMS is accepted. |
| `FORMULA_KMS_REGION` | Optional | Pins the KMS client region; unset lets the AWS SDK's ambient region resolve it. |
| `FORMULA_KMS_TENANT_ID` | Optional | Folded into every KMS `EncryptionContext`. Default `rac` — this deployment is the one tenant. |
| `FORMULA_KMS_TIMEOUT_MS` | Optional | Fail-closed bound per KMS round trip. Default `4000`. |
| `FORMULA_AUDIT_HMAC_WRAPPED` | Recommended after first prod boot | Opaque KMS ciphertext (safe to store as config) that makes the audit-chain HMAC key STABLE across restarts. First boot without it mints one and logs the wrapped value with an instruction to persist it here — see `aws-kms.adapter.ts` `loadOrMintAuditKey`. |
| `FORMULA_KEK` / `FORMULA_KEK_FILE` | Dev/test/CI ONLY | The Phase-1 env/file KEK adapters. Production ignores these entirely even if set — `resolveKmsAdapter` (`formula.module.ts`) only ever constructs `AwsKmsAdapter` when `APP_ENV=prod`. |

### Migrating existing (env/file-KEK-wrapped) formulas to AWS KMS

Run `scripts/vault-rewrap.ts` (dry-run by default; `--apply` to write) — see its header for the
full contract. It preserves each formula's existing DEK bit-for-bit (re-wraps, never
regenerates), so sealed ingredients never need re-encryption. Order:

1. Apply `scripts/provision-vault-isolation.sql` steps 1–2 (create `ra_vault`, point
   `FORMULA_DATABASE_URL` at it, redeploy).
2. `FORMULA_DATABASE_URL=... FORMULA_KEK=<current> FORMULA_KMS_KEY_ID=<target CMK> tsx scripts/vault-rewrap.ts` (dry run — review the report).
3. Re-run with `--apply`.
4. Redeploy with `FORMULA_KEK`/`FORMULA_KEK_FILE` removed from the environment entirely and
   `APP_ENV=prod` set (forces `AwsKmsAdapter`).
5. THEN apply `scripts/provision-vault-isolation.sql` step 3 (revoke the main role).

### KMS key policy template

Principals: the Vault service's OWN IAM role only. Explicitly denies every other role named in
V4 §109.2 (ALEMBIC web/API, Aria, Agent, Admin, Content, analytics, search, generic workers) —
belt-and-braces on top of the IAM allow-list actually granting nothing to them; the explicit
`Deny` survives a future accidental broad `Allow` added elsewhere (e.g. an org-wide
`kms:Decrypt` policy). Replace the `<...>` placeholders per environment.

```json
{
  "Version": "2012-10-17",
  "Id": "rawprod-formula-vault-cmk-policy",
  "Statement": [
    {
      "Sid": "EnableRootAccountAdmin",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<ACCOUNT_ID>:root" },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "AllowVaultServiceRoleEnvelopeOps",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<ACCOUNT_ID>:role/<VAULT_SERVICE_ROLE_NAME>" },
      "Action": [
        "kms:GenerateDataKey",
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:DescribeKey"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": { "kms:ViaService": "kms.<REGION>.amazonaws.com" }
      }
    },
    {
      "Sid": "DenyEveryOtherRawAromaRole",
      "Effect": "Deny",
      "Principal": {
        "AWS": [
          "arn:aws:iam::<ACCOUNT_ID>:role/<ALEMBIC_WEB_API_ROLE_NAME>",
          "arn:aws:iam::<ACCOUNT_ID>:role/<ARIA_ROLE_NAME>",
          "arn:aws:iam::<ACCOUNT_ID>:role/<AGENT_ROLE_NAME>",
          "arn:aws:iam::<ACCOUNT_ID>:role/<ADMIN_ROLE_NAME>",
          "arn:aws:iam::<ACCOUNT_ID>:role/<CONTENT_ROLE_NAME>",
          "arn:aws:iam::<ACCOUNT_ID>:role/<ANALYTICS_ROLE_NAME>",
          "arn:aws:iam::<ACCOUNT_ID>:role/<SEARCH_ROLE_NAME>",
          "arn:aws:iam::<ACCOUNT_ID>:role/<GENERIC_WORKER_ROLE_NAME>"
        ]
      },
      "Action": [
        "kms:GenerateDataKey",
        "kms:Encrypt",
        "kms:Decrypt"
      ],
      "Resource": "*"
    }
  ]
}
```

## 4. Frontend (Vercel)

Vercel → **New Project** → same repo → set **Root Directory = `web`** (framework: Other, no build).
Edit `web/vercel.json`: replace `RAW_AROMA_API_HOST` with your Render hostname (e.g.
`raw-aroma-api.onrender.com`), commit, push. The two rewrites tunnel `/crypto/*` and `/rpc` to Render
so the app calls same-origin and the backend host stays hidden.

## 5. Verify live

1. Open the Vercel URL → login as `owner@rawaroma.local`.
2. Confirm the Super-Admin **chain-of-custody** dashboard renders with real products + the donut/hero.
3. Login as `compounding@rawaroma.local` → confirm product names show as `Protected ◆` and materials
   as `ING-A0xx` aliases (masking holds end-to-end).
4. DevTools → Network: only `POST /rpc` + `POST /crypto/handshake`, all ciphertext. No readable paths,
   tokens, or data.

## Demo logins (rotate before public!)

Owner: `owner@rawaroma.local` (password in your local `.env` as `BOOTSTRAP_OWNER_PASSWORD`). The other
10 role users (`admin|procurement|receiving|qc|warehouse|compounding|filling|packaging|production|sales@rawaroma.local`)
share one demo password set during seeding (re-seed `sales` with `BOOTSTRAP_SALES_PASSWORD`). Role is assigned by the DB, not self-selected. Reset all of
these via `pnpm db:seed` with fresh `BOOTSTRAP_*_PASSWORD` values before any public exposure.
