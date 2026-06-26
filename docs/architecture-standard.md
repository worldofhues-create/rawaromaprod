# Architecture standard

The reusable shape every project starts from: a **hybrid modular monolith** — monolith economics
with microservice option value.

## Backend = one deployable, N clusters
- One NestJS (+Fastify) app, two containers from one build: **api** (HTTP + edge layer) and **worker**
  (jobs, events, outbox, schedulers — scale independently).
- **Clusters** are the would-be services. Each has: its own **PG schema**, a `public-api.ts` (the only
  cross-cluster import surface), **domain events** (default integration), its own queues.
- **Boundaries are enforced, not aspirational**: dependency-cruiser/ESLint block reaching past
  `public-api.ts`; one Drizzle client per schema makes cross-schema queries impossible.
- **Edge layer** (in-process, not a separate gateway): JWT verify + portal-audience, kill-switch flag
  guard, rate-limit, response envelope `{data,meta,error}`, request-id, CORS, webhook allowlist.

## Communication
1. **Events first** (in-proc bus + transactional outbox; broker-compatible envelope). Publish a fact,
   subscribers react. Extraction to NATS later = transport swap, not redesign.
2. **Sync only where a fresh answer is mandatory** — via DI of `public-api.ts` interfaces. Budget: a
   flow needing >2 sync hops is redesigned around a read-model projection.
3. **Read-model projections** — a cluster subscribes to others' events and maintains its own
   denormalized read model, so hot read paths do zero cross-cluster work at request time.

## Control plane (kill-switch) — built in
Every feature ships with a registered flag `portal.module.feature`. The platform cluster is the source
of truth; an in-memory snapshot (sub-ms eval) is distributed to the edge + clients. Killing a module
cascades: routes 503, nav hides, jobs pause. Critical flags require step-up + a reason; all changes
audited. **Reusable in every project for free.**

## Theming per role
Semantic tokens (`@core/tokens`) → CSS vars + Tailwind preset; theme switches at login by role claim;
NativeWind consumes the same tokens. Components use only semantic vars (`--color-surface`,
`--color-accent`, `--color-trust`) — **rebrand a whole project by editing one token file.**

## Frontend
Apps are thin shells; real UI lives in feature packages (`core/` logic + `web/` + `native/`).
Server state via TanStack Query; client/session state via zustand; forms via react-hook-form + zod
from `@core/contracts`. SEO surfaces use SSR/ISR + JSON-LD.

## Reuse tiers (lint-enforced)
0 tooling · 1 generic packages (`ui`, `data-kernel`, `tokens`, auth/flags/offline kits — **zero domain
vocabulary**) · 2 domain features · 3 apps. Lower tiers never import higher; a domain-vocabulary lint
keeps `PropertyCard` out of `@core/ui`.

## Scale & extraction path (no rewrites)
worker replicas → api replicas (stateless, sessions in Redis) → move hottest schema to its own PG node
(connection-string change) → **extract a cluster** (own container + DB + NATS transport) → only then K8s.
