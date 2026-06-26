# Reuse guide — starting a new project from this repo

This repo is your **template seed**. A new product = keep `@core/*`, add domain clusters + features,
re-skin via tokens. Nothing here is product-specific.

## 1. Bootstrap
```bash
# Use as a GitHub template (or clone + reset remote)
git clone https://github.com/Lovesh1/Common_reusable_codes.git my-app
cd my-app && rm -rf .git && git init

docker compose -f infra/docker-compose.dev.yml up -d
pnpm install
pnpm -r typecheck                          # core compiles
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/app
pnpm --filter @core/data-iam migrate && pnpm --filter @core/data-iam seed
pnpm --filter @core/data-platform migrate && pnpm --filter @core/data-platform seed
```
You now have auth, RBAC, orgs, feature flags, geo, master data, and a themed UI kit — day zero.

## 2. Re-skin (5 min)
Edit `packages/tokens/src/portals.ts` — change palettes/radius/density per portal. That's the entire
rebrand; components reference only semantic vars, so nothing else changes.

## 3. Add your domain
Per bounded context (e.g. `catalog`, `orders`):
1. **Data** — add `packages/data-catalog` (new PG schema `catalog`, tables via `@core/data-kernel`
   helpers, its own `__migrations_catalog` table, idempotent seeds). Follow `docs/data-conventions.md`.
2. **Contracts** — add `packages/contracts/src/clusters/catalog` (zod DTOs + events). Register any new
   flags/permissions/error codes.
3. **Backend** — add `backend/cluster-catalog` (NestJS module: controllers + services wired to the data
   package + `@core/backend-kernel` edge/events/outbox). Expose only `public-api.ts` to other clusters.
4. **Web** — add `web/feature-catalog` (Tier-2: screens/hooks/forms composing `@core/ui`) and wire it
   into an app shell under `web/`. Keep domain words OUT of `@core/ui`.

## 4. What to keep untouched (the reusable core)
`@core/data-kernel`, `@core/data-iam`, `@core/data-platform`, `@core/contracts` primitives+registries,
`@core/tokens`, `@core/backend-kernel`, `@core/ui`. Improve them upstream here and pull the change into
every project — don't fork per project.

## 5. Graduation rule
A package proven across **two projects unmodified** can graduate to a published private registry
(`@core/* `on GitHub Packages). Until then, template-copy. `@core/data-engagement`-style infra
(notifications, billing) graduates first.

## 6. Verify before shipping
`pnpm -r typecheck` · run migrations against a fresh DB · the CI in `.github/workflows/ci.yml` does both
on every push, plus a Postgres+PostGIS schema-drift check.
