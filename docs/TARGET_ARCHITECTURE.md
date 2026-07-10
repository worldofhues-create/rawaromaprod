# Raw Aroma — Target Architecture (two-console air-gap + AI layer)

> Companion to the grounded feasibility audit in `docs/OFFLINE_TWO_CONSOLE.md` (2026-07-07).
> One codebase, two deployments. The two databases **never** connect — only signed packages cross the gap.
> Status legend: **BUILT** = in the code today (audited) · **PARTIAL** = seam exists, small change · **NEW** = well-scoped new work.

```
                    INTERNET
                        │
        ┌───────────────────────────────┐
        │  PUBLIC STOREFRONT      [NEW] │  cart · checkout · payments — sells ONLY the granted allocation
        └───────────────────────────────┘
                        │
        ┌───────────────────────────────┐
        │  ONLINE PORTAL (per-role)     │  Owner · Sales & Dispatch · Procurement · Admin   [BUILT]
        └───────────────────────────────┘
                        │  ECDH P-256 → AES-256-GCM over POST /rpc (browser sees ciphertext)  [BUILT]
        ┌───────────────────────────────┐
        │  BFF EDGE                     │  request-id → JWT → RBAC (~343 guards) → flags → zod
        │  (encryption IS in the BFF)   │  → envelope → MASKING (fail-closed)               [BUILT]
        └───────────────────────────────┘
                        │
        ┌───────────────────────────────┐
        │  ONLINE API + WORKER          │  same NestJS codebase · CONSOLE=online  [PARTIAL: console tag]
        └───────────────────────────────┘
                        │
        ┌───────────────────────────────────────────────────────────┐
        │  ONLINE POSTGRES — owns: orders · sales · customers ·     │
        │  master data · SEALED formula blobs (ciphertext + wrapped │
        │  DEK only 🔒) · channel-allocation ledger [NEW] · outbox  │
        │  NO KEK HERE → cannot decrypt anything (fails closed)     │
        └───────────────────────────────────────────────────────────┘
                        │ outbox → export adapter
════════════════════════ AIR GAP ═══════════════════════════════════
              RELAY — store-and-forward   [NEW process, BUILT foundation]
              · signed package: JSONL outbox envelopes + manifest
                (package seq · prev-package hash · SHA-256 · Ed25519 sig),
                AES-256-GCM in transit
              · exporter drains past relay_cursor; importer verifies
                sig+chain+seq, dedupes via relay_inbox ON CONFLICT DO NOTHING,
                republishes on the local bus — clusters change ZERO lines
              · transport: USB sneakernet / data diode / DMZ forwarder / QR
              · ONLINE→OFFLINE: paid orders · masters · sealed blobs · requests
              · OFFLINE→ONLINE: stock grants (ATP) · production · QC · dispatch
              · NEVER crosses: DB connection · replication · KEK · plaintext
════════════════════════ AIR GAP ═══════════════════════════════════
                        │ import adapter → outbox
        ┌───────────────────────────────────────────────────────────┐
        │  OFFLINE POSTGRES — owns: production · QC · RM inventory  │
        │  ledger [BUILT] · FG stock + ATP [NEW — the prerequisite] │
        │  · dispatch + documents · outbox · 🔒 formula vault       │
        │  (ciphertext + wrapped DEKs, hash-chained access audit)   │
        └───────────────────────────────────────────────────────────┘
                        │
        ┌───────────────────────────────┐
        │  OFFLINE API + WORKER         │  same codebase · CONSOLE=factory · in-proc worker ·
        │  (in-house server)            │  local Caddy/TLS (infra/ compose is the seed)   [BUILT]
        └───────────────────────────────┘
                        │
        ┌───────────────────────────────┐
        │  FACTORY PORTAL (per-role)    │  Receiving · QC · Warehouse · Compounding · Filling ·
        │                               │  Packaging — floor sees ALIASES only (masking)  [BUILT]
        └───────────────────────────────┘
                        │
        ┌───────────────────────────────┐
        │  UNSEAL / ADMIN STATION 🔒    │  KmsPort seam (keyRef/wrapDek/unwrapDek/macAudit) [BUILT]
        │  KEK on removable media / HSM │  one-line swap formula.module.ts:50 → FileKmsAdapter [NEW ~60 lines]
        │  admin-held, mounted only     │  plaintext recipes exist ONLY here, ONLY in RAM,
        │  during unseal windows        │  ONLY during unseal · split audit-MAC key [PARTIAL]
        └───────────────────────────────┘
```

## AI integration layer — [NEW, 0% today; socket ready]

Lands as a new cluster behind the same edge pipeline. Guardrails: AI reads via `public-api.ts`
ports only · sees masked data in non-reveal contexts · no path to the KEK · every AI action is a
**suggestion** gated by the approval matrix.

| Online AI (cloud allowed) | Factory AI (local inference ONLY) | Shared substrate |
|---|---|---|
| demand forecasting from order history | QC anomaly detection on parameter readings | pgvector per side, embeddings computed on-side |
| vendor scoring, price/reorder suggestions | FEFO / batch-consumption optimisation | vault content NEVER embedded online |
| customer insights for the storefront | production scheduling suggestions | AI events ride the same outbox (auditable) |
| may call a cloud LLM — this side holds no secrets | on-box Ollama/ONNX — nothing formula-adjacent leaves | zero cloud calls exist today → no air-gap conflict |

## Inventory without sync — "grant, don't replicate"

Single-writer per side. The store can never promise more than the factory physically reserved
for it — **overselling is impossible by construction**; staleness only under-sells (safe).

1. **Factory computes ATP** — FG on-hand − reservations *(NEW: FG stock model — `produced_qty` is never decremented today)*
2. **Reserve the web grant** — N units/SKU locked via `stock_reservation` so the floor can't dispatch them *(BUILT)*
3. **Stock package →** signed grant `{sku → qty, batches, expiry}` crosses the gap; online imports idempotently
4. **Store sells the allocation** — atomic `remaining = remaining − qty WHERE remaining ≥ qty` *(NEW)*
5. **Orders package ←** paid orders return; factory FEFO-picks + dispatches; confirmations ride the next grant

## Built vs. new (from the audit)

| Area | Done | Net-new |
|---|---|---|
| BFF tunnel + masking | 100% | — |
| Vault / offline key | 90% | FileKmsAdapter (~60 lines) + audit-MAC key split |
| RBAC / two consoles | 85% | CONSOLE tag on roles + login check |
| Air-gap hygiene | 90% | Resend → local SMTP (one class) |
| Relay | ✅ SHIPPED | export/import/status endpoints, relay_cursor/inbox/package tables, Ed25519 sign+SHA256+chain, boundary contract (formula.* never crosses), keygen + sneakernet CLI — verified 2026-07-09 (commit 3e079c7). Activate by setting RELAY_SIGNING_KEY/RELAY_VERIFY_KEY in env. |
| Inventory ATP | ✅ SHIPPED | FG ATP (`GET /v1/fg-stock` + `/by-sku`), `finished_good_reservation` table, over-dispatch guard (409), reservation CRUD — live-verified 2026-07-09 (commit e426f9f) |
| Storefront | 5% | public website, cart, checkout, payments |
| AI layer | 0% | everything (both flavors) |

**Design readiness ≈ 90% · implementation ≈ 65% (storefront excluded).**

## Build sequence

1. ~~**FG stock + ATP**~~ — ✅ **DONE** (live-verified 2026-07-09): derived ATP `available = produced − dispatched − consumed − reserved`, `finished_good_reservation` table, over-dispatch guard, reservation CRUD, real dispatch modal
2. ~~**Relay + boundary contracts**~~ — ✅ **DONE** (verified 2026-07-09): signed store-and-forward export/import/status over the outbox, Ed25519 + hash chain, boundary allow-list (`formula.*` never crosses), sneakernet CLI. Needs `RELAY_SIGNING_KEY`/`RELAY_VERIFY_KEY` in env to activate export/import.
3. ~~**Offline console**~~ — ✅ **CODE DONE** (2026-07-10): FileKmsAdapter (offline KEK, verified 7/7) + env-driven KMS swap + key ceremony, CONSOLE=online|factory login gate (unset=unified, current deploy unchanged), air-gap notify (zero outbound on factory), `pnpm db:provision`, runbook `docs/OFFLINE_CONSOLE.md`. Remaining = the physical on-prem standup (ops: run db:provision on the in-house DB, mount the KEK media, CONSOLE=factory).
4. **Storefront** — public shop selling against the granted allocation
5. **AI layer** — online forecasting first; factory local-inference second

Architecture style: **hybrid modular monolith, extraction-ready** — two self-contained deployments
of one codebase is a *configuration* of this design, not a violation of it.
