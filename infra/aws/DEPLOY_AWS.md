# RawProd on AWS — deploy runbook (PB-01 / PB-02 / PB-16, lane L-DEP)

This replaces `DEPLOY.md` (Vercel + Render + Neon) as the production path. It mirrors ALEMBIC's
own ops pattern (`/Users/apple/Downloads/alembic/ops/`) rather than inventing a new one: systemd
units for every long-running process, nginx terminating TLS in front of loopback upstreams,
Let's Encrypt via certbot, and an exact-SHA deploy script with a compatibility-checked rollback.
`render.yaml` and every `web*/vercel.json` have been deleted (G8 — production is AWS-only;
`infra/aws/nginx/` has the equivalent static-file serving); `DEPLOY.md` is now a short pointer
to this file.

Authority: `MIGRATION_AWS_PLAN.md` (the approved-direction plan this lane executes against) and
`FINAL_OS_EXECUTION_STATE.json` PB-01/PB-02/PB-16.

## 1. Topology

```
Internet ─HTTPS─► EC2 alembic-app (unchanged: alembic-api, alembic-web)
   raw/rawadmin/rawagent.huecycle.in

   rawfactory.huecycle.in   → nginx (infra/aws/nginx/rawprod-main.conf) → static web/
   rawplatform.huecycle.in  → nginx (same file)                        → static web-platform/
      /rpc, /crypto/*, /v1/*, /auth/*, /health  → 127.0.0.1:4100 (rawprod-api.service)
                                                       │
      private SG alembic-db ──► RDS alembic-pg (PG16): DB `alembic` (unchanged) + DB `rawprod` (new)

Internet ─HTTPS (allow-list only, H5)─► EC2 vault-app  vault.huecycle.in
   nginx (infra/aws/nginx/vault.conf) → static web-vault/
      /rpc, /crypto/*, /v1/*, /auth/*, /health → 127.0.0.1:4100 (vault-api.service)
                                                       │ private SG vault-db (vault-app SG only)
                                                       ▼
                                          RDS vault-pg (PG16, CMK alias/rawprod-vault-dek)
```

Hostnames (`rawfactory.huecycle.in`, `rawplatform.huecycle.in`, `vault.huecycle.in`) are the
plan's §5 H7 **proposed** names — DNS is a human cutover step (no Route53 zone; huecycle.in is
hosted outside AWS). Every `server_name` and `ssl_certificate` path in `infra/aws/nginx/*.conf`
is marked `PLACEHOLDER` and needs a find-and-replace once H7 is answered.

## 2. Ports, and why they are not ALEMBIC's

`rawprod-api.service` and `vault-api.service` both listen on **127.0.0.1:4100** — not `:3000` or
`:4000`, because the main EC2 already runs `alembic-web` on `:3000` and `alembic-api` on `:4000`
(RawProd's factory/platform nginx sits on the **same box** as ALEMBIC's, per the plan's topology
— it is additive, `infra/aws/nginx/rawprod-main.conf` does not touch `alembic*.conf`). `:4100` is
free on that host; the vault EC2 reuses the same port number for consistency even though it has
no ALEMBIC processes to collide with.

## 3. Install order (one-time, per host)

**Main EC2** (alongside the existing ALEMBIC install):
1. Node 22.12.0 (pin matching `.node-version` — NodeSource or nvm system-wide), pnpm via corepack.
2. `useradd rawprod` (or reuse an existing service account per your convention).
3. `git clone` the repo to `/srv/rawprod/app`, owned by `rawprod`.
4. `mkdir -p /etc/rawprod /srv/rawprod` and write `api.env`, `migrate.env` (§5 below).
5. Copy `infra/aws/systemd/{rawprod-migrate,rawprod-api}.service` to `/etc/systemd/system/`,
   `systemctl daemon-reload`, `systemctl enable --now rawprod-migrate.service rawprod-api.service`.
6. Copy `infra/aws/nginx/rawprod-main.conf` and `infra/aws/nginx/security-headers-{factory,platform}.conf`
   to `/etc/nginx/rawprod/` (create the dir), symlink `rawprod-main.conf` into
   `sites-enabled/`, `certbot --nginx -d rawfactory.huecycle.in -d rawplatform.huecycle.in`,
   `nginx -t && systemctl reload nginx`.

**Vault EC2** (its own instance, own SG, own IAM role — MIGRATION_AWS_PLAN.md §2/§3 B4):
1-4 as above, but `/etc/rawprod/vault.env` and `/etc/rawprod/vault-migrate.env` (§5), and
`infra/aws/nginx/vault.conf` + `security-headers-vault.conf`.
5. **Before** exposing this host publicly: replace `infra/aws/nginx/vault-allowlist.conf.placeholder`
   with a real `vault-allowlist.conf` (H5 — office IP/VPN) and swap `vault.conf`'s `deny all;`
   for `include /etc/nginx/rawprod/vault-allowlist.conf;`. Until H5 is answered, leave `deny
   all;` in place — a reachable-by-accident Vault console is the one failure mode this topology
   exists to prevent.
6. `systemctl enable --now vault-migrate.service vault-api.service`, certbot, `nginx -t && reload`.

## 4. PB-16 — schema provisioning

`pnpm db:migrate` (both `rawprod-migrate.service` and `vault-migrate.service` run nothing else)
is the **canonical** schema provisioner: `scripts/migrations/0000..NNNN*.sql`, ordered,
idempotent, tracked in a `public.schema_migrations` ledger per connection. It is verified (see
`scripts/db-migrate.ts`'s own header, and this lane's session notes) to:
- bring an **empty** database to the exact schema `pnpm db:push` produces, plus the previously
  ad-hoc `create-*.cjs` tables `db:push` never touched — a strict superset, checked via a
  normalised `pg_dump -s` diff;
- bring an **already-populated, older-schema** database (e.g. one provisioned by an earlier
  commit's `db:push`) up to the same full current schema, by adding missing tables AND missing
  *columns* on tables that already existed (see the `ADD COLUMN IF NOT EXISTS` guards
  `scripts/gen-schema-migrations.mjs` emits per column) — the exact case the old `db:push`
  (create-once, skips a schema the moment it has any table) could not handle.

`SKIP_TARGETS` (env var, comma-separated) is what keeps the two migrate services from ever
touching the database they cannot reach: `migrate.env` sets `SKIP_TARGETS=formula` (the main EC2
has no route to vault-pg), `vault-migrate.env` sets `SKIP_TARGETS=main` (the vault EC2 has no
route to `rawprod` on alembic-pg) and needs no `DATABASE_URL` at all — only
`FORMULA_DATABASE_URL`.

To regenerate `scripts/migrations/0000-0013*.sql` after a Drizzle schema change:
`node --import @swc-node/register/esm-register scripts/gen-schema-migrations.mjs`, review the
diff, commit. `0014+` (the former `create-*.cjs` scripts' schema DDL) and
`2026-09-24-ui-parity.sql` are hand-maintained.

## 5. Env files (`/etc/rawprod/*.env`, root-only, never in git)

| File | Used by | Must set |
|---|---|---|
| `api.env` | `rawprod-api.service` | `DATABASE_URL` (rawprod_app role), `FORMULA_DATABASE_URL` (until PB-03 lands — see §6), `JWT_SECRET`, `CORS_ORIGINS=https://rawfactory.huecycle.in,https://rawplatform.huecycle.in`, `PORT=4100`, `NODE_ENV=production`, `APP_ENV=prod`, `RUN_WORKER_IN_PROCESS=true` |
| `migrate.env` | `rawprod-migrate.service` | `DATABASE_URL` (rawprod_owner role, DDL), `SKIP_TARGETS=formula` |
| `vault.env` | `vault-api.service` | `DATABASE_URL` (interim — see §6), `FORMULA_DATABASE_URL` (ra_vault role, vault-pg), `FORMULA_KEK` or a KMS adapter once PB-03 lands, `JWT_SECRET` (P0 decision 2026-09-24: the SAME signing key as `api.env`, ALWAYS — rendered from the same `/rawaroma/rawprod/JWT_SECRET` SSM param, not a separate copy; vault-api verifies RawProd-issued JWTs, so a mismatched key would reject every caller), `PORT=4100` |
| `vault-migrate.env` | `vault-migrate.service` | `FORMULA_DATABASE_URL` (ra_vault_owner role, vault-pg), `SKIP_TARGETS=main` — **no `DATABASE_URL`** |

No GSTIN, no static tenant config, no credential ever lives in these files beyond the connection
strings/secrets themselves — matches the Shopify-style self-service posture the platform requires
elsewhere and ALEMBIC's own `ops/aws/README.md` "no secrets in api.env beyond what an instance
role can't cover" rule where it applies.

## 6. Known gaps, stated rather than hidden

- **`vault-api.service` is not module-isolated.** The app has one `AppModule` that imports every
  cluster; there is no vault-only entrypoint. `vault-api.service`'s own header comment is the
  full explanation — short version: it runs the whole app, `DATABASE_URL` still points at the
  shared `rawprod` database (for the iam/platform tables auth needs to boot at all), and only
  `FORMULA_DATABASE_URL` is the real, isolated connection. Closing this is PB-03 (or a new
  vault-only entrypoint) — not done here, and not pretended to be done.
- **`rawprod-api.service` / `vault-api.service` bind `0.0.0.0`, not `127.0.0.1`.**
  `backend/api/src/main.ts` hardcodes the bind address; there is no `HOST`/`HOSTNAME` env var it
  reads (unlike ALEMBIC's Next renderer, which shipped exactly this bug once — see
  `alembic-web.service`'s own comment on it — before a drop-in fixed the flag Next actually
  reads). The only thing standing between this port and the internet is the EC2 security group
  allowing 80/443 and nothing else. A future app-code change adding a loopback bind is a real
  improvement; it is not built in this ops-only lane.
- **No ALB/ACM/WAF.** PB-01's acceptance line mentions them; this lane followed
  `MIGRATION_AWS_PLAN.md`'s own target topology instead, which explicitly chooses nginx+certbot
  on EC2 (ALEMBIC's proven pattern, §1.1: no ALB/ACM exist in the account today either) over
  introducing a load balancer this estate's traffic does not need. If a future decision adds one,
  nginx moves to being the backend behind it; nothing here blocks that.

## 7. `infra/aws/deploy.sh`

```
RAWPROD_ROLE=main  infra/aws/deploy.sh <sha>        # main EC2: rawprod-migrate + rawprod-api
RAWPROD_ROLE=vault infra/aws/deploy.sh <sha>        # vault EC2: vault-migrate + vault-api
infra/aws/deploy.sh --status
infra/aws/deploy.sh --rollback   # refuses if the ledger has outrun the previous SHA — see script
```

Exact-SHA only (git fetch + checkout --detach), `pnpm install --frozen-lockfile`, `pnpm -r
build` (a no-op for the API — it runs from source via the swc loader per `DEPLOY.md` §3 — real
for any workspace package that does compile), restarts the migrate unit before the api unit,
health-checks `/health` (+ both static roots on `main`), writes `/srv/rawprod/DEPLOYED_SHA`.

## 8. `scripts/migrate/` — PB-02 migration tooling

- `neon-dump.sh <main|formula>` — a consistent (`--serializable-deferrable`), directory-format,
  checksummed snapshot. `main` excludes the `formula` schema; `formula` dumps only it, to a
  separate output (never restored into `rawprod` — MIGRATION_AWS_PLAN.md Phase C2).
- `restore.sh <main|formula> <dump-dir>` — extensions first (needs an elevated/master
  connection, same reason `CREATE EXTENSION postgis` needs `rds_superuser`), then roles, then the
  restore itself (deliberately **not** `--no-privileges`/`--no-acl` — see the script's header for
  the exact ALEMBIC lesson that flag exists to avoid), then ownership handoff, then a grants
  sanity check.
- `reconcile.ts` — source vs target counts + business aggregates across every domain
  `MIGRATION_AWS_PLAN.md` §4 lists (iam/platform, masterdata, procurement, gate/GRN+inventory,
  quality, production, packaging/FG/ATP, sales/dispatch, bridge/outbox/workflow, location
  PostGIS, formula/vault), plus an optional ALEMBIC baseline. JSON report, non-zero exit on any
  mismatch. `SOURCE_DATABASE_URL`/`TARGET_DATABASE_URL` (+ `*_FORMULA_DATABASE_URL`, same
  fallback convention as `db-migrate.ts`).

Verified locally end-to-end this lane (Docker PostGIS PG, `postgres://apple@127.0.0.1:5433`):
seed → dump (main + formula) → restore into a fresh database → `reconcile.ts` reports 0/43
mismatches → mutate one row in the target → `reconcile.ts` catches it (non-zero exit, names the
exact failing check) in two independent domains (a status-value mutation and a row deletion).
