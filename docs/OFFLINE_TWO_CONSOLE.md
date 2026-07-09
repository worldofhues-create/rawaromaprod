# Offline Two-Console Feasibility — Grounded Audit (2026-07-07)

# Is the air-gapped two-console model supportable? — Grounded verdict

## 1. Headline verdict

**Yes — mostly supportable today.** The architecture was built with exactly these seams (pluggable KMS, transactional outbox, per-deployment RBAC, encrypted BFF tunnel, modular-monolith clusters); what's missing is well-scoped new work: the relay itself, an offline KMS adapter, a finished-goods stock model, and one email side-channel to cut. No existing machinery fights the design — critically, there is **no DB-sync code to rip out**, because none exists.

## 2. Why the design already fits

Five seams in the code line up with the two-console model:

- **Vault/KMS swap point.** Recipe encryption is envelope encryption behind a port: `KmsPort` (`backend/cluster-formula/src/crypto/kms.port.ts:23-35`) is bound at exactly one line — `formula.module.ts:50` — and `VaultService`/`FormulasService` inject only the token. Postgres holds **only ciphertext**: `enc_payload/enc_iv/enc_tag` per ingredient (`packages/data-formula/src/schema/ingredients.ts:29-31`) and a KEK-wrapped DEK per formula (`vault.ts:24-25`). The KEK exists only in the `FORMULA_KEK` env (`config.schema.ts:60`, read at `env-kms.adapter.ts:25`) and fails closed when absent.
- **Transactional outbox = the relay's foundation.** Every cross-cluster fact is already a durable, self-describing envelope row (UUIDv7 id, type, zod-validated payload, `occurred_at`+`seq` total order) written in the producer's own transaction (`packages/data-kernel/src/outbox.ts`, `backend-kernel/src/events/outbox.recorder.ts`). The seam is proven: `EmailNotifierService` (`backend/api/src/notify/email-notifier.service.ts`) already runs as a *second independent consumer* with its own event-id dedupe ledger — exactly the pattern a relay exporter/importer uses.
- **RBAC is per-deployment by construction.** All identity state lives in the deployment's own Postgres (`packages/data-org/src/schema/security.ts`: `iam.user_master/role_master/permission_master/...`), tokens are HS256-signed with a per-deploy `JWT_SECRET` (`jwt.service.ts:38`), permissions are flattened into the JWT at mint (`cluster-org/src/auth/auth.service.ts:89-98`), and ~343 `@Permissions()` guards enforce per-route (`app.module.ts:84-86`). Run the same codebase twice with different DBs and secrets and the user sets are disjoint; a factory token is cryptographically useless online.
- **BFF encrypted tunnel + masking are done.** ECDH P-256 handshake → HKDF → AES-256-GCM over a single `POST /rpc` (`backend/api/src/crypto/session-keys.service.ts`, `crypto.controller.ts`); DevTools sees only ciphertext, the JWT travels inside the blob. `MaterialMaskingInterceptor` fail-closed strips material identity for non-reveal roles (`backend/api/src/masking/`). Proxy-ready today (`web/vercel.json`, `trustProxy: true` in `main.ts:22`).
- **The style is a hybrid modular monolith with extraction seams** — `docs/architecture-standard.md:3`'s own words. 13 clusters, each with its own `pgSchema` and `public-api.ts`, boundary-linted by `.dependency-cruiser.cjs`, one build with api + worker entrypoints (`backend/api/src/main.ts` / `worker.ts`). Two self-contained deployments is a configuration of this design, not a violation of it.

## 3. The one idea to get right: store-and-forward, never sync

The two DBs **never connect and never replicate**. What crosses the gap is a **signed, encrypted, hash-chained package file** (JSONL of outbox envelopes + a manifest with package sequence, prev-package hash, content SHA-256, Ed25519 signature), carried by an adapter/relay process on each side:

- **Exporter** — a new scheduled service reading each cluster's outbox past its *own* cursor (a new `relay_cursor` table, so it never fights the local publisher's `published_at` watermark) — modeled directly on `OutboxPublisher`'s drain loop (`outbox.publisher.ts:44`).
- **Importer** — verifies signature + chain + sequence continuity, inserts events into a new `relay_inbox` ledger `ON CONFLICT DO NOTHING` (the exact dedupe pattern `email-notifier.service.ts:118-122` already uses), then republishes onto the local `EventBus`. Subscribers change zero lines.

Honest gaps the audit found: **no relay/signing/inbox code exists today** (repo-wide grep finds nothing), outbox rows carry no hash-chain (that pattern exists only on `audit_events`, `data-kernel/src/audit.ts:70-74` — replicate it in the manifest), and `actor`/`requestId` aren't persisted in outbox rows (the publisher fabricates `actor:null` at `outbox.publisher.ts:85-86`) — a small additive migration if provenance must cross the gap.

## 4. Inventory across the gap — the concrete answer

**Don't sync stock. Grant it.** Single-writer per side, like consignment stock:

- **Factory console is the only writer of physical truth.** The RM ledger is already solid: `inventory_batch.quantity_on_hand` (`data-inventory/src/schema/inventory-batch.ts:36`), every movement through `createInventoryTransaction` writing ledger + history + signed delta in one transaction (`inventory.service.ts:184-251`), FEFO availability = on-hand − reservations (`inventory-view.service.ts:20-45`), and document-linked `stock_reservation` (`stock.ts:88-107`).
- **Online console is the only writer of orders and of its own local "remaining sellable" counter.** At checkout it atomically decrements: `UPDATE ... SET remaining = remaining − qty WHERE remaining >= qty`.
- **Two packages cross the gap.** (1) *Stock package, factory → online*: factory computes FG available-to-promise, **reserves** N units per SKU for the web channel via `stock_reservation` (so the floor can't dispatch them offline), and exports a signed grant `{packageId, sku → grantedQty, batches, expiry}`; online imports idempotently by packageId and adds to its allocation ledger. (2) *Order package, online → factory*: paid orders since the last exchange; factory imports, FEFO-picks, dispatches; the next stock package carries dispatch confirmations + fresh allocation.
- **Why overselling is impossible by construction, not by freshness:** the online store can never promise more than the factory physically reserved for it. Staleness only causes **under-selling** (unallocated stock sits at the factory) — the safe failure mode.

**The one hard blocker the audit found:** finished goods have **no stock model at all** today. `finished_good_batch_master.produced_qty` is write-once and never decremented (`data-packaging/src/schema/batch.ts:20`); dispatch inserts rows and emits `sales.dispatch.created`, whose only subscriber is the email notifier (`dispatch.service.ts:40-84`); order creation checks nothing (`orders.service.ts:42-121`); the portal even hardcodes dispatch qty 1 (`web/app.js:722`). So FG on-hand/ATP must be built *before* there is anything to grant — this is true even in a single-DB world. There is also no online storefront yet (no cart/checkout code exists); `sales_order` is a back-office desk.

## 5. Master key physically offline + encrypted

The online DB is **blind by construction** already: it holds only GCM ciphertext plus KEK-wrapped DEKs, and tampering is rejected by GCM tags (`vault.service.ts:159`). Remove `FORMULA_KEK` from a host and every wrap/unwrap throws `Formula vault unavailable` (`env-kms.adapter.ts:26-28`). Making the key *physically* offline is a one-line rebind at `formula.module.ts:50` to a new ~60-line `FileKmsAdapter` reading a 32-byte KEK from removable/encrypted media mounted only at the factory/admin station — `vault.service.ts`, `vault-crypto.ts`, and the formula flow need zero changes for any synchronous adapter. `encryption_key_ref` already versions which key sealed what (`formulas.service.ts:89`).

Three honest caveats: (a) if the KEK never touches the online box, the online runtime's **decrypt features break** (floor view / pick list / owner read all flow through `decryptVersion`, `vault.service.ts:66`) — in the two-console model decryption naturally moves to the factory console, which is where those users live anyway; (b) the audit-chain HMAC is keyed by the **same KEK** and fires on every vault write (`vault.service.ts:136`), so a strictly key-less online node needs the MAC key split into a separate secret — a small port change; (c) `KmsPort` is synchronous, so a networked HSM/cloud KMS would need the port made async (~4 awaits) — a file/passphrase adapter fits as-is.

## 6. Already built vs. must be built

| Area | Already in the code | Net-new work |
|---|---|---|
| Vault/KMS | Envelope encryption, one-line swap seam, key-ref versioning, fail-closed | `FileKmsAdapter` (~60 lines) + `FORMULA_KEK_FILE` config; split audit-MAC key from KEK |
| Relay | Outbox tables in 10 schemas, drain semantics, proven second-consumer pattern, UUIDv7, crypto template (`env-kms.adapter.ts`) | Exporter/importer services, `relay_cursor` + `relay_inbox` tables, package format (manifest hash-chain + Ed25519 signing), keygen script; optional actor/requestId columns |
| Boundary contract | Envelope declared once in `contracts/src/primitives/events.ts` | The stock-grant / order-package / dispatch-confirmation event contracts |
| Inventory | RM ledger, reservations, FEFO view, event history | **FG on-hand + ATP projection**, dispatch decrement, channel-allocation tables both sides, online atomic remaining counter, order-status write-back — and the storefront itself |
| RBAC/portals | Per-deploy DB + JWT secret, 343 route guards, 10-role portal SPA | `CONSOLE` env in the portal claim (today hard-coded `'owner'`, `auth.service.ts:27`), role→console tagging + login check; recommended: port refresh-reuse detection from retired `cluster-identity`; quarantine dead `data-iam` schema |
| True air gap | Everything else is local (in-proc bus, local containers, no AI/cloud calls) | Swap the one outbound call — Resend at `email-transport.service.ts:24` — for local SMTP (one class); add `pnpm boundaries` to CI |

## 7. AI layer

**Does not exist — not even stubbed.** Repo-wide grep finds no AI code or dependency anywhere; pgvector is only a docker-compose comment (no migration creates the extension, no vector column exists); docs explicitly defer it (`BUILD_STATE.md` P9 "seams only", `PHASE1A_SCHEMA_PLAN.md` lists AI Forecasting out of scope). Any AI capability is net-new, with the cluster pattern as its natural landing spot. Upside for this design: nothing currently phones an LLM cloud, so AI adds no air-gap conflict today.

## 8. Decisions you must make

1. **Scope of "offline."** (a) Vault-only offline (KEK on removable media, one console) — smallest step; (b) on-prem factory LAN console + cloud store — the full two-console model above; (c) fully air-gapped factory — adds the SMTP swap and a physical carry (USB/diode) discipline for packages.
2. **Where the KEK lives:** file on removable/encrypted media (fits the current sync `KmsPort` as-is), passphrase-derived (also sync), or HSM (requires making the port async). All are one adapter behind the same seam.
3. **Who decrypts recipes:** accept that in the strict model, floor view/pick list/owner recipe reads run only on the factory console.
4. **Exchange cadence and grant sizing:** how often packages cross the gap, and how much FG stock to allocate to the web channel per cycle — this is the business lever that trades under-selling risk against factory flexibility.
5. **Sequencing:** the FG stock model (ATP + dispatch decrement) must land first — it's a prerequisite even without the split — then the relay, then the storefront.
