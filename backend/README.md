# Backend layer — reusable modular-monolith skeleton

The standard backend every project starts from: a NestJS 10 + Fastify **modular monolith**
with microservice-grade internal boundaries (own PG schema, `public-api.ts`, events), an
in-process **edge layer**, a transactional **outbox** event bus, and an in-memory
**flag** (kill-switch) control plane. See `Namasthethu/docs/01-architecture.md` and
`06-services-and-apis.md` for the full design — this README is the operational summary.

## Packages

| Package | Scope | What it is |
|---|---|---|
| `backend/backend-kernel` | `@core/backend-kernel` | The reusable core: config, per-schema Drizzle clients, edge layer (guards / interceptors / filter / middleware / zod pipe), in-proc event bus + outbox publisher, in-memory flag snapshot, decorators, `/health`. **Domain-free — ships with every project.** |
| `backend/cluster-identity` | `@core/cluster-identity` | identity cluster (`iam` schema): `/v1/auth/*` + `/v1/me`, Argon2id, JWT access+refresh, sessions, RBAC. Exports the `UserLookup` public port. |
| `backend/cluster-platform` | `@core/cluster-platform` | platform cluster (`platform` schema): control-plane flags, geo suggest, master data. Drives the flag snapshot; emits `platform.flag.changed`. Exports `PlatformLookup`. |
| `backend/api` | `@core/api` | The sample deployable: `main.ts` (Fastify HTTP api) + `worker.ts` (outbox publisher + job consumers). Two entrypoints, one codebase. |

## How the edge layer + outbox + flags fit together

**Edge layer** (in `backend-kernel/src/edge`) is installed globally in `api/src/app.module.ts`:

```
request → RequestIdMiddleware (x-request-id)
        → JwtAuthGuard      (verify access token + portal audience → request.user)
        → PermissionsGuard  (@Permissions('domain:resource:action') via Reflector)
        → FlagGuard         (@RequiredFlag('portal.module.feature') vs in-memory snapshot)
        → handler           (body/query validated by ZodValidationPipe, contracts schemas)
        → ResponseEnvelopeInterceptor  → { data, meta, error }
   (any throw) → AllExceptionsFilter   → { data:null, meta, error:{ code, message, requestId } }
```

`@Public()` opts a route out of auth (register/login/refresh/health/flag-snapshot).
Errors are thrown as `DomainError(code, msg, status)` and map straight to a
`@core/contracts` `ErrorCode`.

**Outbox (reliable events).** A service writes its domain rows **and** an outbox row in
one Drizzle transaction via `recordOutbox(tx, schema.outbox, event, payload)`. The
`OutboxPublisher` (worker process, scheduled) drains `published_at IS NULL` rows in
occurrence order, publishes each onto the in-proc `EventBus`, and stamps `published_at`.
At-least-once → subscribers must be idempotent. Swapping the bus for NATS at the
extraction stage changes nothing for producers/subscribers (same envelope).

**Flags (kill-switch control plane).** The platform cluster is the source of truth
(`platform.flags × platform.flag_states`). On boot it hydrates the kernel's in-memory
`FlagsService` snapshot; on an admin `PUT /v1/admin/flags/:key` it upserts the state,
writes a mandatory-reason audit row, records a `platform.flag.changed` outbox event, and
pushes the new state into the in-memory map **synchronously** (sub-ms reads, no broker).
`FlagGuard` reads that map to 503 a killed route.

## How to add a cluster

1. **Data**: add `@core/data-<cluster>` (its `pgSchema`, tables, `outboxTable`/`auditTable`)
   in `packages/`. (Already done for iam + platform.)
2. **Wire the db client**: add a token + per-schema `drizzle(client, { schema })` provider
   in `backend-kernel/src/db/drizzle.module.ts` and export it from `db/index.ts`.
3. **Create `backend/cluster-<name>`**: copy the shape of `cluster-platform`
   (`package.json`, `tsconfig.json`, `src/<module>/*.controller.ts` + `*.service.ts`,
   `public-api.ts`, `<name>.module.ts`, `index.ts`).
   - Controllers: REST plural-noun routes, `@Permissions(...)`, `@RequiredFlag(...)`,
     `ZodValidationPipe(contractSchema)`.
   - Services: inject the cluster's `*_DB` token; cross-cluster talk **only** via an
     injected `public-api.ts` interface or an outbox event — never a deep import.
   - Emit events with `recordOutbox(tx, <schema>.outbox, contracts.<cluster>Events.x, payload)`.
4. **Register the outbox source**: add a `{ cluster, db, table }` line in
   `provideOutboxSources` (`backend-kernel/src/events/outbox.registry.ts`).
5. **Compose**: import the new module in `api/src/app.module.ts` and `worker.module.ts`.

## Conventions

- TypeScript strict, **NodeNext ESM**: `"type":"module"`, relative imports end in `.js`.
- NestJS needs `experimentalDecorators` + `emitDecoratorMetadata` + `reflect-metadata`
  (set in every backend package `tsconfig.json`).
- Validation: zod from `@core/contracts` via `ZodValidationPipe` at every boundary.
- REST plural-noun routes; events `cluster.entity.verb` (past tense); errors `DOMAIN_REASON`;
  flags `portal.module.feature`; DB snake_case.
- IDs are UUIDv7 (`@core/data-kernel` `uuidv7()`), time-sortable + non-enumerable.

## Required environment

`DATABASE_URL` (Postgres), `JWT_SECRET` (≥32 chars), optional `REDIS_URL`, `PORT`
(default 3000), `APP_ENV` (`dev|staging|prod`). Full schema + defaults in
`backend-kernel/src/config/config.schema.ts` (validated at boot — bad env fails fast).

## Run locally (verified)

```bash
# 0. data plane up + schemas applied (from repo root)
docker compose -f infra/docker-compose.dev.yml up -d
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/app
pnpm --filter @core/data-iam migrate && pnpm --filter @core/data-iam seed
pnpm --filter @core/data-platform migrate && pnpm --filter @core/data-platform seed

# 1. run the api (dev). JWT_SECRET must be ≥32 chars.
JWT_SECRET=dev-only-secret-please-change-32chars-min! \
pnpm --filter @core/api dev          # → http://localhost:3000

# health + a full auth round-trip
curl localhost:3000/health
curl -XPOST localhost:3000/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"a@b.com","fullName":"A","portal":"buyer","acceptedTerms":true,"acceptedPrivacy":true,"password":"Sup3rSecret!"}'
```

Verified end-to-end against Postgres 17 + PostGIS: register (Argon2id + JWT + session),
`GET /v1/me`, login, `GET /v1/geo/suggest` (pg_trgm), `GET /v1/masters`.

> **Dev runner = SWC, not tsx.** NestJS uses constructor *parameter* decorators; tsx/esbuild
> won't forward `experimentalDecorators` to cross-package (workspace) files, so it transforms
> them as TC39 decorators and fails. `@swc-node/register` applies one config globally and
> handles `emitDecoratorMetadata` correctly. The root `tsconfig.json` carries the decorator
> options so the runner picks them up regardless of cwd. **Production** uses `nest build` →
> `node dist/main.js` (tsc, no runner quirk).
