# Web layer — reusable frontend skeleton

The standard web frontend every new project starts from. **Apps are thin shells; reusable
logic lives in packages**, split by reuse tier and (for features) by `core/` (platform-agnostic)
vs `web/` (React). Stack: **Next.js 15 (App Router) · React 19 · Tailwind v4 · shadcn-style
Radix components · TanStack Query · react-hook-form + zod · zustand · TypeScript strict.**

## Packages

| Path | Name | Tier | What it is |
|---|---|---|---|
| `web/ui` | `@core/ui` | 1 — generic | Domain-free component kit (Button, Card, Input, Label, Badge, Dialog, **DataTable**). Themed only through semantic CSS vars. Ships verbatim in every project. |
| `web/feature-auth` | `@core/feature-auth` | 2 — feature | Reusable auth screens. `core/` = TanStack Query mutations + zustand session store + injected `AuthApiClient`; `web/` = react-hook-form + zod forms (schemas from `@core/contracts`) composed from `@core/ui`. |
| `web/admin` | `@core/admin-shell` | 3 — app | Next.js 15 App Router sample shell — copy this to start a new app. |

Wires to existing workspace packages: **`@core/tokens`** (semantic tokens + 7 portal themes +
CSS emitter) and **`@core/contracts`** (zod DTOs). All cross-package deps use `workspace:*`;
packages resolve via their `main: ./src/index.ts` (no build step for consumers — Next
`transpilePackages` handles the app side).

## The reuse-tier model (docs/01 §8)

```
Tier 0  tooling        eslint/ts/tailwind/depcruise configs, CI            → stays verbatim
Tier 1  generic pkgs   @core/ui (+ future @core/lib)                       → stays, ZERO domain words
Tier 2  domain feature @core/feature-auth, @core/feature-*                 → auth ships; domain ones deleted from template
Tier 3  apps           @core/admin-shell (+ project apps)                  → all but one example deleted
```

**Mechanically enforced — not discipline (CI failures):**

- **`web/.dependency-cruiser.cjs`** — Tier 1 may never import a feature or app; Tier 2 may
  never import an app. Run `depcruise --config web/.dependency-cruiser.cjs web`.
- **Domain-vocabulary lint** over `web/ui/src` — a banned-word list (`property`, `listing`,
  `inspection`, `trust`-as-domain, `offer`, …). A `PropertyListingCard` physically cannot
  land in `@core/ui`; it belongs in a feature composing a generic `Card`/`DataTable`. The
  generic `--color-trust` **token** is allowed; a domain **type** named trust is not.
- **Token-discipline lint** over `web/ui`/`web/feature-*` — only semantic utilities
  (`bg-surface`, `text-accent`, `rounded-md`); raw palette classes (`bg-blue-500`) fail.

## Theming (per role, docs/01 §6)

1. `@core/tokens` defines semantic tokens (`color.surface`, `color.accent`, `color.trust`,
   `radius.md`, …) and 7 portal themes (buyer / owner / builder / inspector / ops / finance /
   admin).
2. Its emitter (`allPortalThemeCss()`) generates the `:root[data-portal="x"] { --color-…: … }`
   blocks → materialized into **`web/ui/src/styles/theme.css`** (regen command in that file's
   header).
3. **`@core/ui`'s Tailwind preset** maps each semantic var onto a Tailwind theme key
   (`colors.surface = var(--color-surface)`, …), so components author with semantic
   utilities only.
4. An app sets **`<html data-portal="admin">`** (see `web/admin/app/layout.tsx`). That single
   attribute picks the active variable block — the whole app re-skins.
5. **Multi-role apps** make `data-portal` dynamic: read the portal from the JWT role claim at
   login and set it on `<html>` (worked example in `layout.tsx`). The `portal` field is the
   same one on every auth request/response in `@core/contracts`.

**Rebrand = edit the token files in `@core/tokens` and regenerate `theme.css`. Zero component
or app edits.**

## DataTable reuse (the Tier-1 generic in action)

`@core/ui`'s `<DataTable>` is fully generic — parameterized over an arbitrary row type, no
domain types. The **app** owns the row shape and the typed `columns` and hands them to the
table, which provides sorting, pagination, and row selection for free
(`web/admin/app/(dashboard)/users/page.tsx`). The same component renders a finance ledger or
an ops queue elsewhere — only the columns change. (A graduation candidate for a shared
`@agency/*` package once it survives two projects unchanged.)

## State & forms

- **Server state → TanStack Query** (`useLogin`, `useRegister` mutations). **Client/session
  state → zustand** (`useAuthStore`) — never server data.
- **Forms → react-hook-form + `@hookform/resolvers/zod`** using `@core/contracts` schemas
  (`identity.auth.loginRequest`, `registerRequest`, `forgotPasswordRequest`) — one source of
  truth for validation, shared with the backend.
- **Transport is injected.** `@core/feature-auth` declares an `AuthApiClient` interface; the
  app provides the real (OpenAPI-generated) or a mock client via `<AuthApiProvider>`. The
  feature owns zero networking.

## How to start a new app from this shell

1. **Copy `web/admin`** to `web/<your-app>` and rename it in `package.json`
   (`@core/<your-app>-shell`).
2. **Pick the portal**: set `data-portal` in `app/layout.tsx` (constant for single-role, or
   dynamic from the role claim for multi-role).
3. **Inject the real API client** in `app/providers.tsx` (replace the demo `AuthApiClient`
   with the typed client generated from the contracts' OpenAPI spec).
4. **Compose**: build routes from `@core/ui` primitives + `@core/feature-*` screens. Put any
   project-specific UI in a new Tier-2 `web/feature-<domain>` package — never in `@core/ui`.
5. **New brand/portal?** Add or edit a token set in `@core/tokens`, regenerate `theme.css`.
   Done — no component changes.

CI runs `pnpm -r typecheck`, the dependency-cruiser check, and the domain-vocabulary /
token-discipline lints on every push.
