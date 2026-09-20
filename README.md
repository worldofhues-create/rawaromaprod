# Common Reusable Codes — the standard core for every project

A domain-free, verified foundation you clone (or copy packages from) to start any new product.
It encodes one architectural standard so a new project is "swap the tokens + add domain clusters",
not "re-decide everything". Born out of the Namasthethu build; stripped of all domain code.

> **Scope `@core/*`.** Every package is project-agnostic. The reuse rule (enforced by lint downstream):
> generic packages never import domain vocabulary — a `MediaCard` lives in `@core/ui`, a
> `PropertyCard` never does.

## What's inside

| Layer | Package | Reuse | Status |
|---|---|---|---|
| Contracts | `@core/contracts` | zod primitives (envelope/pagination/events/ids) + registries (errors/permissions/flags) + per-cluster DTOs/events; zod→OpenAPI codegen | ✅ typecheck |
| Design | `@core/tokens` | semantic token contract + 7 portal themes → CSS vars (web) / NativeWind (mobile). Rebrand = edit one file | ✅ typecheck |
| Data | `@core/data-kernel` | domain-free DB kit: UUIDv7, base columns, soft-delete, money, PostGIS types, **transactional outbox + hash-chained audit**, migrate/seed runners | ✅ typecheck + DB |
| Data | `@core/data-iam` | identity schema: users (single source), credentials, OTP, sessions, **RBAC**, **organizations/teams** + seeds (roles, permissions) | ✅ DB-verified |
| Data | `@core/data-platform` | control plane: **kill-switch flags**, generic **geo tree** (deep admin hierarchy + PostGIS), generic **master-data engine** (incl. Indian measurement units), themes, content | ✅ DB-verified |
| Backend | `@core/backend-kernel` + `@core/cluster-*` + `@core/api` | NestJS+Fastify edge layer (JWT/RBAC/flags/envelope), in-proc event bus + outbox publisher, identity & platform clusters, sample api+worker | 🚧 scaffolding |
| Web | `@core/ui` + `@core/feature-auth` + `@core/admin-shell` | shadcn/Tailwind kit themed by tokens, reusable auth screens, Next.js 15 admin shell, generic data-table | 🚧 scaffolding |
| Infra | `infra/` + `.github/` | docker-compose dev stack, Caddy, CI, env templates, network-masking topology | ✅ |

## The standard in one breath
**pnpm monorepo · contract-first (zod→OpenAPI) · NestJS modular-monolith backend (8 clusters, schema-per-cluster, outbox events, extraction-ready) · Postgres 17 + PostGIS + Drizzle (no cross-schema FKs) · Redis + BullMQ · Next.js 15 + Tailwind + shadcn themed by tokens · Expo + NativeWind (mobile, later) · custom IAM (no per-MAU auth vendor) · kill-switch control plane · Dokploy + Cloudflare infra.** Full rationale in [`docs/`](docs).

## Start a new project from this
```bash
# 1. Clone / use-as-template, rename remote
git clone https://github.com/Lovesh1/Common_reusable_codes.git my-app && cd my-app

# 2. Bring up the data plane + verify the core works
docker compose -f infra/docker-compose.dev.yml up -d
pnpm install
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/app
pnpm --filter @core/data-iam migrate && pnpm --filter @core/data-iam seed
pnpm --filter @core/data-platform migrate && pnpm --filter @core/data-platform seed

# 3. Add your domain: generate a cluster (data + backend) and feature packages,
#    re-skin via @core/tokens. Keep @core/* as the untouched foundation.
```
See [`docs/REUSE-GUIDE.md`](docs/REUSE-GUIDE.md) for the full new-project playbook.

## Verify the core (anytime)
```bash
pnpm install
pnpm -r typecheck
# DB: see step 2 above — applies all schemas + seeds to a fresh database
```

## Layout
```
packages/   contracts · tokens · data-kernel · data-iam · data-platform   (verified core)
backend/    backend-kernel · cluster-identity · cluster-platform · api      (NestJS)
web/        ui · feature-auth · admin                                        (Next.js)
infra/      docker-compose.dev · Caddyfile · .env.example · README          (recipe)
docs/       REUSE-GUIDE · data-conventions · architecture-standard · coding-standard
```
