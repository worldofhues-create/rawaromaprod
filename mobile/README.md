# Mobile layer — reusable React Native skeleton

The standard mobile foundation every new project starts from. **Apps are thin Expo shells;
reusable logic lives in packages**, split by reuse tier exactly like the web layer. Same
contracts, same tokens, same state/forms stack — so web and mobile stay in lockstep.

Stack: **Expo SDK 53 · expo-router 4 · React Native 0.79 · React 19 · NativeWind 4 (Tailwind 3)
· TanStack Query · react-hook-form + zod · zustand · expo-secure-store · expo-sqlite ·
TypeScript strict.**

## The 3-app strategy (docs/07-mobile-apps.md)

One codebase, three store apps — same pattern as Zomato (consumer / partner / delivery):

| App | Roles | Scope | Theme |
|---|---|---|---|
| **Consumer** | buyer | search, detail, saved, inquiries, offers | buyer warm/light |
| **Partner** | owner + builder | lead inbox, visits, offers, listing-lite | owner indigo |
| **Field** | inspector (+ later lawyer/valuer) | task queue, geo camera, **offline-first** | inspector high-contrast dark |

Three apps (not one role-switcher): store positioning/ratings per audience, smaller bundles,
independent update cadence, security isolation (Field/Partner carry no consumer attack
surface). `mobile/consumer` here is the one **sample shell** — copy it to start any app.

## Packages

| Path | Name | Tier | What it is |
|---|---|---|---|
| `mobile/ui-native` | `@core/ui-native` | 1 — generic | Domain-free RN component kit (Text, Button, Card, Input, Badge, Screen). Themed only through semantic tokens via `<ThemeProvider>`. Ships verbatim. |
| `mobile/core` | `@core/mobile-core` | 1 — generic | Cross-app engine (no UI): typed API client over `@core/contracts`, auth/session (zustand + SecureStore), flags client, offline mutation queue (SQLite). |
| `mobile/consumer` | `@core/app-consumer` | 3 — app | Sample Expo app (expo-router). Copy to start a new app. |

Wires to existing workspace packages: **`@core/tokens`** (semantic tokens + 7 portal themes)
and **`@core/contracts`** (zod DTOs). All cross-package deps use `workspace:*`; packages
resolve via `main: ./src/index.ts` (Metro transpiles workspace sources — no build step).

## Theming (same tokens as web, docs/01 §6)

The whole point: **mobile themes from the EXACT same `@core/tokens` as web**, so a rebrand is a
one-file edit that re-skins both platforms.

1. `@core/tokens` defines semantic tokens (`color.surface`, `color.accent`, `color.trust`, …)
   and 7 portal themes (buyer / owner / builder / inspector / ops / finance / admin).
2. `@core/ui-native`'s **Tailwind preset** (`tailwind.preset.ts`) maps each semantic var onto a
   Tailwind theme key (`colors.surface = var(--color-surface)`, …) — identical mapping to web's
   preset — so components author with semantic utilities only (`bg-surface`, `text-accent`,
   `rounded-md`), never raw palette classes.
3. Web sets the active variable block with `<html data-portal="x">`. Mobile has no DOM, so
   **`<ThemeProvider portal="buyer">`** applies the chosen portal's tokens as NativeWind CSS
   vars (`vars()`) on a root `View` (`src/theme/tokens-to-vars.ts` reuses `@core/tokens`'
   own `tokensToCssVars`). Same variables, different delivery mechanism.
4. **Theme per role**: the consumer app hard-sets `portal="buyer"`. A multi-role app reads the
   portal from the JWT role claim at login and passes it to `ThemeProvider` (or calls
   `useTheme().setPortal(...)` after login) — the whole app re-skins to that role.

**Rebrand = edit `@core/tokens` only. Zero component or app edits.**

## Offline mutation queue — the Field-app engine (`mobile/core/src/offline/queue.ts`)

A real, typed, **SQLite-backed** (`expo-sqlite`) at-least-once queue — not a stub:

- `OfflineQueue.open(dbName)` creates the `mutation_queue` table + drain index.
- `enqueue(kind, payload)` durably persists a mutation as `pending` (FIFO by `created_at,id`).
- `drain(sender, opts)` walks eligible rows, calls the injected `sender` per row; on success
  marks `done`, on failure increments `attempts` and sets `next_attempt_at` with **exponential
  backoff** (`baseBackoffMs * 2^(attempt-1)`, capped at `maxBackoffMs`); at `maxAttempts` the
  row is parked as `failed`. Call on every foreground / connectivity-regain.
- `counts()` powers a sync badge; `retryFailed()` un-parks; `purgeDone()` housekeeps.

Conflict policy is the caller's (docs prescribe *server wins on template version, client wins on
responses*); the queue only guarantees durable, ordered, retried delivery of opaque mutations.

## Security (docs/07 §4)

- **Tokens in expo-secure-store, never AsyncStorage.** `mobile/core/src/auth/secure-tokens.ts`
  is the only place tokens are read/written (keychain/keystore-backed), so the backend is
  swappable in one file. `useAuth` persists the token pair there on login and clears it on
  logout; the API client pulls the bearer token from it per request.
- **Follow-ups (documented, wired later):**
  - **Certificate pinning** to the API host — pin in the native networking layer (e.g.
    `react-native-ssl-pinning` / an Expo config plugin) so MITM proxies are rejected.
  - **Biometric unlock** — gate SecureStore reads with `requireAuthentication: true` (Face ID /
    fingerprint) once a passcode is enrolled, optional for Partner/Field.
  - Root/jailbreak detection on Field (evidence integrity); screenshot blocking on Partner
    document screens.

## State & forms

- **Server state → TanStack Query** (`useLogin`/`useRegister`/`useLogout` in `@core/mobile-core`).
  **Client/session state → zustand** (`useSessionStore`).
- **Forms → react-hook-form + `@hookform/resolvers/zod`** using `@core/contracts` schemas
  (`identity.auth.loginRequest`, …) — one validation source shared with the backend.
- **Transport is injected.** The app constructs the typed `ApiClient` + endpoints
  (`mobile/consumer/lib/api.tsx`) and provides them via context; features take `endpoints` and
  own zero networking — same discipline as web's `<AuthApiProvider>`.

## Kill-switches (`mobile/core/src/flags/flags-client.ts`)

`createFlagsClient(api).refresh(portal)` fetches the per-portal flag snapshot on launch +
foreground and caches it in memory; `isEnabled(key)` / the `useFlag(key)` hook evaluate in
sub-ms (a killed module disappears from the tab bar). Same `portal.module.feature` keys as web.

## Version pairing (the typecheck-sensitive bit)

Pinned as a consistent set — **NativeWind 4 runs on Tailwind 3, NOT Tailwind 4** (web uses
Tailwind 4; mobile must stay on 3.4.x):

| Expo SDK | React Native | React | NativeWind | Tailwind | expo-router |
|---|---|---|---|---|---|
| `^53.0.0` | `^0.79.0` | `^19.0.0` | `^4.1.23` | `^3.4.17` | `~4.0.0` |

`className` typing comes from `nativewind/types` — every package that authors `className` has a
`nativewind-env.d.ts` (`/// <reference types="nativewind/types" />`) and lists it in `tsconfig`
`types`. RN packages use `moduleResolution: Bundler`, `jsx: react-jsx`, and `lib` including DOM
(some RN/fetch types need it).

## How to start a new app from this shell

1. **Copy `mobile/consumer`** to `mobile/<app>`, rename in `package.json` + `app.json`.
2. **Pick the portal**: set `APP_PORTAL` in `app/_layout.tsx` (constant for single-role, or
   dynamic from the role claim for multi-role).
3. **Point at your API**: set `extra.apiUrl` in `app.json` (read in `lib/api.tsx`).
4. **Compose** routes from `@core/ui-native` primitives + `@core/mobile-core` hooks. Put
   project-specific UI in a Tier-2 `mobile/feature-<domain>` package — never in `@core/ui-native`.
5. **New brand/portal?** Edit a token set in `@core/tokens`. Done — no component changes.
