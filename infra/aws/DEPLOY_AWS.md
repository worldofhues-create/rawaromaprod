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
   Then run the **IAM bootstrap seed (§4a) — required**: without it the `iam` tables stay empty and
   no role can do anything. The demo box needs the same seed against `rawprod_demo`.
6. Copy `infra/aws/nginx/rawprod-large-headers.conf` to `/etc/nginx/conf.d/` (http-level
   `large_client_header_buffers 4 32k;` — live since 2026-09-25, when a ~12 KB owner token was refused
   by nginx's 8k default and the owner was locked out of Factory; `install-ops.sh app` and the demo's
   `install-box.sh app` both install it). Copy `infra/aws/nginx/rawprod-main.conf` and `infra/aws/nginx/security-headers-{factory,platform}.conf`
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

## 4a. IAM bootstrap seed — `scripts/db-seed.ts` is REQUIRED (prod AND demo)

`pnpm db:migrate` creates the `iam` tables and leaves them **empty**. Until `scripts/db-seed.ts`
has run against a database, `iam.permission_master`, `iam.role_master` and
`iam.role_permission_mapping` hold nothing: no role holds any permission, every guarded route
refuses, and an ALEMBIC-assertion sign-in lands on roles that do not exist. **Both environments
ran like that until 2026-09-25** — nothing in the bootstrap ran the seed (`deploy.sh`, the migrate
units and the demo's `reset-demo.sh` still do not), and it was run by hand on both that day.

So it is a required bootstrap step, **after the first migrate, on every RawProd main database**
(`rawprod` for production, `rawprod_demo` for the demo). It is idempotent: re-running inserts any
permission a newer release added (`RA_PERMISSIONS` + `CAPABILITY_PERMISSIONS`) and the grants
that follow from it, and refuses (throws, writes nothing further) if any grant would breach the
§107/§108/§113 invariants. It is a BOOTSTRAP step only: on an already-seeded database
(production) a release that adds permissions or grants applies the additive, idempotent SQL that
`pnpm exec tsx scripts/gen-permission-grants.ts --since <the release tag production runs>` prints
(same catalogue, same invariants, NOT EXISTS-guarded inserts, removals reported but never revoked)
instead of re-running the seed, which would also reset the owner's password hash.

Its environment, and nothing else:

| Variable | Production | Demo |
|---|---|---|
| `DATABASE_URL` | the OWNER url from `/etc/rawprod/migrate.env` (DDL/DML on `iam`) | the owner url from `/etc/rawprod-demo/migrate.env` — refuse unless it names `rawprod_demo` |
| `RAWPROD_ENVIRONMENT` | `production` | `demo` — the only value under which the seed provisions the passwordless `showcase` account |
| `BOOTSTRAP_OWNER_EMAIL` | the owner's real address (the `owner` user row; defaults to the sample `owner@rawaroma.local` if unset, which is wrong for a real deployment) | the demo owner address (2026-09-25: `owner@demo.rawprod.local`) |
| `BOOTSTRAP_OWNER_PASSWORD` | **random, per run, never stored**: `$(openssl rand -base64 36)` in the shell that runs the seed, `unset` straight after | same |
| `BOOTSTRAP_{ADMIN,FLOOR,QC,PROCUREMENT,RECEIVING,…}_PASSWORD` | **unset** — each one that is set creates a sample `*@rawaroma.local` login with that password | unset |
| `PGSSLROOTCERT` / `NODE_EXTRA_CA_CERTS` | the RDS bundle, as `migrate.env` has it | same |

Why the owner password is random and thrown away: people sign in to RawProd through an ALEMBIC
assertion, not a RawProd password, and the seed refuses to run without *some* owner password. A
value nobody knows keeps the owner row's password login unusable. It is never written to SSM, an
env file, a log or a shell history, and each re-run replaces it with another random value (the
seed resets an existing user's hash), so re-running is safe.

```
# on the app box, as root, from /srv/rawprod/app (demo: /srv/rawprod-demo/app with the demo files)
set -a; . /etc/rawprod/migrate.env; set +a
export RAWPROD_ENVIRONMENT=production BOOTSTRAP_OWNER_EMAIL=<owner address>
export BOOTSTRAP_OWNER_PASSWORD="$(openssl rand -base64 36)"
pnpm exec tsx scripts/db-seed.ts; unset BOOTSTRAP_OWNER_PASSWORD
# verify: role_master / permission_master / role_permission_mapping are non-zero, and
# formula:actual:read is held by formulator and vault_approver ONLY
```

## 5. Env files (`/etc/rawprod/*.env`, root-only, never in git)

| File | Used by | Must set |
|---|---|---|
| `api.env` | `rawprod-api.service` | `DATABASE_URL` (rawprod_app role), no `FORMULA_*` key (RC7: the main box reaches the Vault only over `VAULT_API_INTERNAL_URL`), `JWT_SECRET`, `CORS_ORIGINS=https://rawfactory.huecycle.in,https://rawplatform.huecycle.in`, `PORT=4100`, `NODE_ENV=production`, `APP_ENV=prod`, `RUN_WORKER_IN_PROCESS=true` |
| `migrate.env` | `rawprod-migrate.service` | `DATABASE_URL` (rawprod_owner role, DDL), `SKIP_TARGETS=formula`, `DB_APP_ROLE=rawprod_app` (RC7: the role grant migrations grant to, e.g. `2026-09-26-automation-app-role-grants.sql`) |
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

Exact-SHA only (git fetch + checkout --detach), `pnpm install --frozen-lockfile`, a serial `pnpm -r
build` of the packages that compile (the API runs from source via the swc loader per `DEPLOY.md` §3,
so `@core/api` is left out; a failed or OOM-killed build stops the deploy before migrations), restarts the migrate unit before the api unit,
health-checks `/health` (+ both static roots on `main`), writes `/srv/rawprod/DEPLOYED_SHA`.

A deploy or a rollback first takes `flock` on `/run/lock/raw-host-deploy.lock`, the lock Alembic's
`ops/deploy/deploy-sha.sh` takes, and refuses if the other is running. On `main` it then refuses to
build with under 1800 MB available (`RAWPROD_MIN_BUILD_MEM_MB`; no floor on `vault` unless that is
set). Both live in the script in the checkout, so the deploy that first brings them in runs the old
script and takes neither: check by hand that nothing else is building for that one.

`web/admin` was a template shell that no unit, vhost or process served, and it is removed. Failed
builds left all 38 of its tracked `.next` files modified on both boxes, and `git checkout` refuses to
delete a modified file, so before the first deploy of the commit that removes it, on each box:
`sudo -u rawprod git -C /srv/rawprod/app checkout -- web/admin/.next`. The ignored leftovers stay
under `web/admin/` and are harmless.

That first deploy on `vault` must not use the old script in the checkout: its parallel `pnpm -r build`
now runs to the end instead of dying on `web/admin`, about 1420 MB against the 970 MB available there,
and it hides the result. Run the target's own script:
`git -C /srv/rawprod/app show <sha>:infra/aws/deploy.sh > /tmp/rawprod-deploy.sh`, then
`RAWPROD_ROLE=vault bash /tmp/rawprod-deploy.sh <sha>`.

**Wrapper version 4 (VAULT-FIT, 14 Nov 2026).** The vault box has no `/usr/bin/node` or `/usr/bin/pnpm`
(both are in `/opt/node-v22.12.0/bin`, outside sudo's secure_path), and version 3 died there with exit
127 after it had already checked the new commit out under the running `vault-api`. The wrapper now finds
node 22 and pnpm as a pair (PATH, `/usr/bin`, `/usr/local/bin`, `/opt/node-v22*/bin`; `RAWPROD_NODE_BIN`
and `RAWPROD_PNPM` override), runs pnpm with node's directory on PATH and from the tree it works on (a
corepack pnpm takes its version from the current directory), and proves it runs before changing
anything. On `vault` it deploys STAGED (`RAWPROD_STAGED`, default 1 there, 0 on `main`): clone to
`/srv/rawprod/.stage-<sha>`, install, build, `db:migrate` from the clone through `systemd-run` with
`vault-migrate.env`, then swap the directories (`app` -> `app.prev`, stage -> `app`), restart, health.
Before the swap a failure leaves `app` and the service untouched; a red health check swaps back and
restarts the old tree, keeping the failed one as `app.failed`. Nothing is `git checkout`-ed in the live
tree, so modified tracked files there (the `.next` above) no longer block. It needs 1500 MB free on
`/srv/rawprod` (`RAWPROD_MIN_FREE_MB`). The demo vault (`/srv/rawprod-demo/app`) is not touched.

## 7a. `infra/aws/ship.sh`: one command from a pushed commit to production

Section 7 is what runs ON the box. This is what the operator runs on the laptop, and it is the way to
deploy from now on: it does the steps in a fixed order, refuses when one fails, and writes down what it
did. You follow what it prints. Where you are sure it is wrong, each refusal names its override.

```
infra/aws/ship.sh <sha>                       # dry run: every local step for real, NO AWS call of any kind
infra/aws/ship.sh <sha> --apply               # deploy to the main box
infra/aws/ship.sh <sha> --role vault --apply  # deploy to the vault box
infra/aws/ship.sh --rollback --apply          # the application goes back one release; the database does not
infra/aws/ship.sh --unlock --apply            # remove a dead ship's lock (refuses while a deploy runs)
infra/aws/nightly-proof.sh                    # what a fast deploy leaves out, on the deployed commit; reports only
```

A dry run asks the box nothing, so it takes what production runs from `--base <sha>`,
`RAWPROD_DEPLOYED_SHA`, or this laptop's last green ship, and says which. `--apply` reads it from the box
and refuses when `--base` disagrees.

**Refused before anything is built:** a checkout with uncommitted changes (what was looked at is then
not what is shipped); any of `ship.sh`, `ship-evidence.mjs`, `deploy.sh`, `backup/rawprod-backup.sh`,
`fast-proof-always.txt`, `scripts/touched-tests.mjs` differing from HEAD (the backup script and, on
`--rollback`, the wrapper run on the box as root); a commit on no branch of `origin`; a shell that is not
bash. Every `*DATABASE_URL*` and libpq `PG*` variable is removed from the run's environment (names go to
the evidence, never values), and every local gate runs without `AWS_*` and with no AWS config file, so
nothing local can reach production.

| Step | What runs | Stops the deploy |
|---|---|---|
| (a) pushed commit | clean checkout and committed tools; `git fetch`; the commit is on a branch of `origin`; it descends from `/srv/rawprod/DEPLOYED_SHA` (read over SSM with `--apply`); its own `deploy.sh` takes the host lock; a fresh detached worktree | yes |
| (b) build | `pnpm install --frozen-lockfile`, `pnpm typecheck`, the box's build (`pnpm -r --workspace-concurrency=1 --filter '!@core/admin-shell' --filter '!@core/api' build`) | yes |
| (c) touched tests | `scripts/touched-tests.mjs`: the always-on list, plus the tests the change touches; `pnpm test` when a sensitive path changed | yes |
| (d) migrations forward | throwaway local PostgreSQL: the deployed commit's `db:migrate` and `db:seed`, this commit's `db:migrate` twice (the second must apply nothing), `db:validate`; ledger rows, tables and row counts compared. Runs when `scripts/migrations/**`, `scripts/db-*.ts` or `packages/data-*` changed, or with `--force-migrations` | yes |
| ship lock | `/run/lock/raw-host-ship.lock` created on the box with `O_EXCL` | yes |
| (e) backup | main: `infra/aws/backup/rawprod-backup.sh` on the box (`pg_dump -Fc`, `pg_restore --list`, upload to `rawprod/pg_dump/`), then `head-object` from the laptop: same size, at least 500000 bytes, and stamped by this run. vault: `vault-pg` `LatestRestorableTime` under 15 minutes old | yes |
| (f) deploy | the commit's own `infra/aws/deploy.sh`, written to `/usr/local/sbin/rawprod-deploy` and compared by sha256, run with `RAWPROD_ROLE`; then on main `infra/aws/nginx/install-static.sh prod`, only if `DEPLOYED_SHA` is the commit | n/a |
| (g) health | `DEPLOYED_SHA` equals the commit; `/health` is 200 from outside on rawfactory, rawplatform and rawvault, and each console's `/` is 200 with a page in it | exits 1, `DEPLOYED BUT NOT GREEN`, prints the rollback command |
| evidence | `~/.rawprod/ship-evidence/<sha>/<stamp>-<role>-<mode>/ship.json` (sealed) and one log per gate; one line appended to `/etc/rawprod/ship-log.jsonl` on the box | no |

**One deploy per host.** The main box has 3.8 GB and no swap, and it ran out of memory when RawProd
and Alembic built together. Two locks on the box, both read before anything is sent:

- `/run/lock/raw-host-deploy.lock`, the `flock` of section 7. Held means a build is running now.
- `/run/lock/raw-host-ship.lock`, one line `system=rawprod role=main sha=<sha> started=<UTC> by=<who>`,
  from before the backup until after the health check. Alembic's `ops/scripts/ship.sh` READS both and
  refuses while either is held; it does not write this file, because after its backup everything it does
  is its wrapper, which holds the `flock`. `ship.sh --apply` refuses while either is held and prints the
  holder and how old its lock is (a ship holds it for at most about 100 minutes).

A ship that died (laptop closed, network gone) leaves the second lock behind; a reboot clears it, and
so does `ship.sh --unlock --apply`, which refuses while a deploy holds the `flock`. The vault box is a
separate host: `--role vault` locks there and does not block the main box.

**The tests a change touches** (`scripts/touched-tests.mjs`, one test per row in
`backend/api/src/__tests__/touched-tests.test.ts`):

| Changed path | Runs |
|---|---|
| anything | the `test` lines of `infra/aws/fast-proof-always.txt` (bridge contract, session cookie, vault boundary, labels, the deploy scripts) |
| a `sensitive` line of that file matches (migrations, `packages/data-*`, the bridge, `backend-kernel`, stock, the vault, the harness, the lockfile) | the whole suite, `pnpm test` |
| `backend/**/*.test.ts` | that file |
| `backend/api/src/<module>` | every test that imports it directly |
| `backend/<cluster>/**`, `packages/<pkg>/**` | every test that imports that package, by path or by name |
| `web/**`, `web-platform/**`, `web-vault/**`, `infra/**`, `scripts/**`, `tools/**` | every test whose text names the file, by path or by file name |
| `e2e/**` | nothing; the evidence says "e2e specs changed, not run" |
| `*.md`, `docs/**` | nothing more |

A changed source that selects no test is written into the evidence as "has no direct test". A change
that deletes an always-on test is refused.

**What a fast deploy does not run**, so nobody reads the evidence as more than it is: the whole unit
suite (unless a sensitive path changed: migrations, the schema, the bridge, sign-in and the policy
engine, stock, money in procurement and sales, the vault), any browser walk, and a rehearsal against
production's rows. The rehearsal in (d) runs on PostgreSQL 17, because PostGIS is installed on the laptop
only for 17, and production is 16.15.

**The nightly job** runs what is left out, and reports; it never blocks a deploy and never writes
evidence a deploy reads. `unit-tests.yml` and `browser-suite.yml` run on main every night at 20:30 UTC
(02:00 IST) as well as on push. `infra/aws/nightly-proof.sh` is the laptop's copy: typecheck and the whole
suite on a throwaway PostgreSQL for the deployed commit (`--legs ...,browser` adds the walks), verdict in
`~/.rawprod/nightly/latest.json`, no AWS call. `ship.sh` prints that verdict before it touches production.
A red night is a defect already in production: fix it forward through `ship.sh`.

**Going back.** `ship.sh --rollback --apply` takes the ship lock, sends the wrapper beside it (sha256 and
version 3 checked on the box), runs `rawprod-deploy --rollback`, republishes the consoles of the commit it
returned to, and runs (g). After a deploy that did not finish it returns to `DEPLOYED_SHA`, the commit
that last passed health; after one that did, to `previous-sha`. The database never moves: nothing here
runs a down migration, and the wrapper refuses (exit 3) when the ledger holds a migration the target
lacks. Then the answer is a forward fix, or the restore point from (e).

**"One proof per commit."** `--apply` straight after a dry run reuses the dry run's proof (same
commit, same deployed commit, same role, same `ship.sh`, under 24 hours old) and goes to the lock.
`--reprove` runs (a) to (d) again.

**Overrides**, each one printed by the refusal it answers: `--unlock` (a dead ship's lock),
`--force-migrations`, `--allow-row-loss` (a migration that removes rows on purpose), `--tests '<glob>'`
(add tests), `--base <sha>` (what production runs, for a dry run), and `--rollback --apply` for going back.

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

## 9. Public huecycle.in hosts (lane HOSTS, 2026-09-24)
`infra/aws/nginx/huecycle-hosts.conf` → `/etc/nginx/sites-available/huecycle-hosts.conf`, enabled as
`sites-enabled/zz-huecycle-hosts.conf` (must load after alembic.conf, rawaroma-demo-origin.conf, rawprod-cf-origin.conf —
it reuses their upstreams/maps). Cert: `certbot certonly --nginx --cert-name rawlanes.huecycle.in -d <9 names>` —
same nginx authenticator as raw.huecycle.in; `certbot.timer` renews. Change procedure: `nginx -t` then `systemctl reload nginx` only.
- rawfactory / rawplatform: static from `/var/www/rawprod-cf/{factory,platform}`, API `/rpc|/crypto/|/v1/|/auth/|/health` → 127.0.0.1:4100 (no-store).
- rawdemofactory / rawdemoplatform: static from `/var/www/rawprod-demo-cf/{factory,platform}`, API → :4110.
- rawdemoadmin / rawdemoagent / rawdemostudio include ALEMBIC's `security-headers-console-demo.conf` (connect-src
  `https://rawdemo.huecycle.in`), not the production console snippet (connect-src `https://raw.huecycle.in`). Both
  snippets live in the alembic repo's `ops/nginx/` and install to `/etc/nginx/alembic/`.
- On a RawProd web deploy, refresh the copy dirs with `infra/aws/nginx/install-static.sh prod|demo` (all three roots,
  factory/platform/vault, plus their console-config.js / vault-config.js); nothing in this file changes.
- rawvault (owner decision 2026-09-24): its own vhost `infra/aws/nginx/rawvault.conf` → `sites-enabled/zz-rawvault.conf`
  (loads after rawprod-cf-origin.conf, reuses `upstream rawprod_api_cf`). Static `/var/www/rawprod-cf/vault`; `/auth/`,
  `/rpc|/crypto/|/v1/` and `/health` → vault box `172.31.51.157:4100` over the private network; `/main/` → the MAIN
  RawProd API on this box (sign-in channel, prefix stripped).
- rawdemovault (recorded from live 2026-09-25, lane cfg-rp): `infra/aws/nginx/rawdemovault.conf` →
  `sites-enabled/zz-rawdemovault.conf`, the same shape pointed at the DEMO side: static `/var/www/rawprod-demo-cf/vault`,
  API → vault box `172.31.51.157:4111` (vault-demo-api), `/main/` → `upstream rawprod_demo_api` (4110, from
  rawaroma-demo-origin.conf). It loads before zz-rawvault.conf and relies on that file's http-level `limit_req_status 429`.
- Browser config (OPS_GREEN §17, recorded from live 2026-09-25): every static console gets `console-config.js`
  (`window.ALEMBIC_CONSOLE_URL`) injected by `sub_filter` ahead of `shell.js`/`platform.js`; rawvault gets
  `vault-config.js` (`window.MAIN_API='/main'`) ahead of `vault.js`. Sources: `infra/aws/nginx/static-config/`
  (README.txt there has the install targets). The demo factory origin (`demo/nginx/rawaroma-demo-origin.conf`, 8445)
  injects the demo console-config.js too; rawdemovault gets `static-config/demo-vault/vault-config.js`. A web deploy
  that refreshes a vault root must re-install `vault-config.js` -- `install-static.sh` does both.
- Env files: `infra/aws/env/render-env.sh app|vault` and `infra/aws/demo/render-demo-env.sh app|vault` render every key
  the boxes run with (INTERNAL_BRIDGE_KEY from `/rawaroma/bridge/internal-bridge-key`, both roles granted). Lane cfg-rp
  (2026-09-25) re-read the live files and made a re-render reproduce them: the ALEMBIC demo's CORS origins, public
  origin, bridge sweep, mail drops, `ALEMBIC_REF_PREFIX=DEMO` (set live 2026-09-25; the proforma rail is off
  without it) and `web-build.env`; the demo RawProd targets incl. vault; the demo vault CORS incl.
  rawdemovault. The demo's BRIDGE_HMAC_KEK and INTERNAL_BRIDGE_KEY follow what the demo RUNS with (production KEK; no
  bridge key) -- a parameter appearing in SSM never switches them. RUN_WORKER_IN_PROCESS=true is rendered ALWAYS (RC6):
  without the in-process worker the demo's bridge outbox never drains (201 events were stuck on 2026-09-25, and the
  RawProd->ALEMBIC projection and every worker automation were dead).
  `backend/api/src/__tests__/infra-live-capture.test.ts` runs both scripts against a sandbox. ALEMBIC PRODUCTION's
  `/etc/alembic/{api,web-build}.env` are rendered by the alembic repo's `ops/deploy/render-env.sh`.
- `deploy.sh` health: API at `127.0.0.1:4100/health`, consoles over HTTPS with `--resolve <host>:443:127.0.0.1`
  (port 80 only redirects), so a good deploy records `/srv/rawprod/DEPLOYED_SHA`.
