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
| **FORMULA_KEK** | New value: `openssl rand -base64 32` — ⚠️ this is the formula-vault key-encryption key. If any formula ciphertext already exists with the old KEK, re-encrypt or re-seed; rotating it invalidates old sealed recipes. |
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

## 3b. PB-04 / SB-02 — ALEMBIC one-login identity bridge

Password sign-in (`/auth/login`, `/auth/users/:id/password`) is retired for launch —
`AuthService` refuses both unconditionally once `APP_ENV=prod`. Set these on the backend
service alongside the four secrets in step 3:

- `ALEMBIC_ASSERTION_VERIFY_KEY` — base64 DER, spki, Ed25519 **PUBLIC** key. Generated in the
  ALEMBIC repository by `node ops/scripts/rawprod-assertion-keygen.cjs` — only the public half
  comes here; the private half stays in ALEMBIC's own config (env or a secrets connector) and
  is never shared with this deployment.
- `ALEMBIC_ASSERTION_ISSUER` / `ALEMBIC_ASSERTION_AUDIENCE` — default `alembic` / `rawprod`.
  Leave unset unless this deployment talks to a differently-named ALEMBIC environment.
- `PASSWORD_LOGIN_ENABLED` — leave unset (default `false`). **Production refuses password
  sign-in unconditionally regardless of this flag** — it is a non-prod escape hatch only, for
  a test suite or a local dev box with no ALEMBIC to hand.

Also set `window.ALEMBIC_CONSOLE_URL` on each of `web/index.html`, `web-platform/index.html`
and `web-vault/index.html` (or inject it from the reverse proxy in front of them) to ALEMBIC's
console origin, so each console's "Sign in via ALEMBIC" button has somewhere to send the
browser, and so `RawProd — Open Factory/Platform/Vault` on the ALEMBIC side has somewhere to
land back.

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

## Demo logins (rotate before public! — and see PB-04/SB-02 above: password sign-in is
## refused outright once `APP_ENV=prod`, so these only work on a non-prod deployment)

Owner: `owner@rawaroma.local` (password in your local `.env` as `BOOTSTRAP_OWNER_PASSWORD`). The other
10 role users (`admin|procurement|receiving|qc|warehouse|compounding|filling|packaging|production|sales@rawaroma.local`)
share one demo password set during seeding (re-seed `sales` with `BOOTSTRAP_SALES_PASSWORD`). Role is assigned by the DB, not self-selected. Reset all of
these via `pnpm db:seed` with fresh `BOOTSTRAP_*_PASSWORD` values before any public exposure.
