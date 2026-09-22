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
DATABASE_URL=... BOOTSTRAP_OWNER_PASSWORD=... pnpm db:seed       # roles + sample logins
DATABASE_URL=... pnpm db:seed:data      # Phase-1 demo dataset (the dashboards read this)
```

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
