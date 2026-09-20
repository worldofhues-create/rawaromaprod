# Coding standard

The conventions that keep every project's code consistent and liftable.

## TypeScript
- **strict** everywhere + `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `noImplicitOverride`.
- **NodeNext ESM**: `"type": "module"`, import specifiers end in `.js` (even for `.ts` sources).
- No `any` in committed code. zod validates at every boundary; infer types from schemas.
- Internal-source packages: `main`/`types` → `./src/index.ts` (no build step for consumers); a separate
  `tsconfig.build.json` emits when a published artifact is needed. Typecheck config is `noEmit`.

## Naming
- REST: plural-noun resources (`/users`, `/listings`).
- Events: `cluster.entity.verb` past tense (`identity.user.registered`).
- Flags: `portal.module.feature`. Permissions: `domain:resource:action`. Errors: `DOMAIN_REASON`.
- DB: snake_case. TS: camelCase vars, PascalCase types.

## Boundaries
- Backend clusters import only each other's `public-api.ts` (or talk via events).
- Frontend tiers: generic packages (`@core/ui`, `@core/tokens`) are **domain-free** — a banned-word
  lint blocks domain vocabulary. Components reference only semantic tokens, never raw colors
  (`bg-[var(--color-surface)]`, not `bg-blue-500`).

## API shape
- Response envelope `{ data, meta, error }`. Cursor pagination (`?cursor=&limit=`).
- Idempotency-Key on payments/offers/webhooks. Versioned routes `/v1/...`.
- Every event carries `{ id, occurredAt, actor, requestId, version, payload }`.

## Security defaults (never regress)
- Argon2id passwords; JWT 15m access + rotating refresh (reuse detection); OTP hashed + throttled.
- Repository reads auto-scoped by owner/tenant (IDOR defense in a base class, not per-handler).
- Secrets never in repo (SOPS/Doppler). Parameterized queries only. Per-cluster DB roles.

## Generators (the standard self-propagates)
`gen:cluster`, `gen:module`, `gen:feature`, `gen:app` scaffold the exact folder contract so new code is
born compliant. Ship them in every repo.
