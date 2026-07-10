> Definitive line-by-line completion audit — 10 area agents + live 107-endpoint sweep, 2026-07-09. Top security + reproducibility claims independently re-verified against source.

# Raw Aroma — Completion Audit (Definitive)

_Source: 10 line-by-line area audits, each cross-checked against a live endpoint sweep (91/107 endpoints return real data, 0 server errors) plus targeted live probes with the owner token against `api.onrender.com`. Date: 2026-07-09._

> **Hardening progress (post-audit, 2026-07-09):**
> - ✅ **H-R reproducibility FIXED** — ad-hoc objects scripted + `pnpm db:provision` one-command fresh-deploy entrypoint (commit 3f6d66f).
> - ✅ **H-S1 / H-S2 / H-S3 security FIXED & live-verified** — role-grant subset guard, password-reset rank guard, per-resource search auth. Negative-tested on prod: admin→owner grant, vendor-PAN search, owner-password reset all now **403** (commit 2d8ceb0).
> - ✅ **H-A1 relay-apply FIXED & verified** — relay now hydrates each event with its domain rows (registry, PKs verified) and materializes them on import via idempotent transactional upsert. Proven on live data: order deleted → re-created by apply (commit 1041d42).
> - ✅ **Write-correctness batch — 8 of 9 FIXED** (2026-07-10): W1 inventory ledger — H-C1 transfer moves stock, H-C2 sign by movement kind, H-C4 release idempotent (commit 41130d9); W2 QC gating — H-I2 packaging-QC-FAIL blocks ATP+dispatch, H-I1 RM-QC REJECT/HOLD blocks availability, H-I3 REWORK emits+notifies (commit e09beaa); W3 production — H-C5 order no longer a dead-end (PLANNING→INPROGRESS, commit 41130d9), H-C6 guarded oil-batch state machine (commit 8e0dec2). **Remaining: H-C3** (production consumption → RM on-hand decrement) — the one cross-cluster item; needs an inventory worker subscriber with idempotency, deferred as its own careful pass so it can't corrupt live on-hand.
>
> **→ All three Step-3 blockers (reproducibility, security, relay-apply) are cleared. Step 3 (offline console + FileKmsAdapter) is unblocked.**

## 1. Headline

- **Phase-1 (factory ERP, M01–M12): ~70% complete** — importance-weighted **69.7%**, simple mean **70.2%** across 9 areas (they converge, so the number is stable, not an artifact of weighting).
- **Two-console track: 62% for steps 1–2**, but **~25% across the full 5-step track** — the relay is code-complete yet **inert** (imports verify + dedupe but never apply), and steps 3–5 are 0–5%.
- **Verdict:** The factory happy-path spine genuinely *runs* end-to-end (auth → procurement → inventory → formula vault → production → packaging → sales/dispatch → notify), but the last ~30% is concentrated in three honest buckets — **reproducibility (fresh deploy breaks)**, **security (two formula-thesis-defeating escalations + a search data-leak)**, and **write-side correctness (inventory ledger + lifecycle state machines)**. It is *not* yet safe to stand up a second (offline) deploy without closing the reproducibility + relay-apply gaps first.

## 2. Scorecard

**Weights** — assigned by module breadth × business criticality (foundational/security modules punch above endpoint count; Formula Vault is the platform's entire reason to exist). Phase-1 weights sum to 100.

| Area | Weight | Complete | One-line status | Top gap |
|---|---:|---:|---|---|
| M01 Enterprise Foundation (auth/RBAC/locations/masters) | 14 | **66%** | Auth + reads rock-solid; RBAC lifecycle is append-only | Privilege escalation: any `admin` self-grants `owner` role → `formula:actual:read` |
| M02–M03 Procurement (+procanalytics BFF) | 13 | **72%** | Full 24-step chain runs live; robustness/reproducibility thin | 5 code-referenced DB objects have no migration → fresh deploy 500s incl. PO list |
| M04 Inventory (+inventory-view BFF) | 13 | **60%** | Reads real; three real write flows; but ledger mutation leaks | Stock transfer is record-only; on-hand sign/deduction/idempotency defects |
| M05 Quality (cluster-quality) | 8 | **55%** | Disposition flow + events run live; verdict has no teeth | QC ACCEPT/REJECT/HOLD does **nothing** to inventory — failed batch stays available |
| M06 Formula Vault (SECURITY-CRITICAL) | 12 | **80%** | Crypto core genuinely strong; single audited decrypt chokepoint | Access-grant path inert + no revoke; role-isolation not enforced in live deploy |
| M07 Production (cluster-production) | 12 | **61%** | Crown-jewel vault→order flow correct; lifecycle not modeled | `production_order` stuck `PENDING` forever; oil-batch status is raw any→any PATCH |
| M08–M09 Packaging + Finished Goods | 11 | **80%** | Produce→ATP→reserve→dispatch loop closed and live | Packaging QC non-functional — FAIL batch still fully sellable/dispatchable |
| M10–M11 Sales + Dispatch (+dispatchdocs BFF) | 10 | **72%** | Order/dispatch flows run; over-dispatch guard real but leaky | `dispatch_document` table has no schema-as-code → fresh deploy 500s |
| M12 + cross-cutting BFF (notify/search/docs/dashboard/audit/geo) | 7 | **86%** | Strongest-running slice; notify fully wired + live delivery | SEARCH bypasses per-resource read auth → vendor bank/PAN exfiltration |
| **Phase-1 weighted total** | **100** | **≈70%** | Runs end-to-end; last 30% = reproducibility + security + write correctness | — |
| _Two-console offline (steps 1–2)_ | _n/a_ | **62%** | Read/ATP real; relay a verified courier that never delivers | Relay `importPackage` never applies imported events (no republish) |

Weighted arithmetic: (66×14 + 72×13 + 60×13 + 55×8 + 80×12 + 61×12 + 80×11 + 72×10 + 86×7) / 100 = **69.74%**.

## 3. What actually works end-to-end (the verified spine)

These are confirmed by code + sweep + (where noted) live probe — real writes, real transactions, real events, not "shows":

- **Auth spine.** Argon2id login mints access+refresh and writes `iam.login_history`; the owner token authenticated **all 91** data endpoints; `/v1/login-history` returns real rows (`auth.service.ts:63-107`).
- **Location hierarchy.** warehouse_type→warehouse→floor→zone→rack→shelf→bin full create+list+edit+deactivate (`warehouse.controller.ts`, `edit.service.ts:24-159`).
- **Procurement 24-step chain (live).** stock_requirement → PR submit/approve (server-side SoD) → RFQ → quotation → PO approve/issue/acknowledge → GRN link → replacement-PO / credit-note; PO-issue emits `procurement.po.issued` → email; vendor rate-history/performance/ledger are genuinely computed SQL aggregations (`requirement.service.ts`, `po.service.ts`, `procanalytics.service.ts`).
- **Inventory core writes.** GRN receive is one atomic multi-table tx + outbox (`grn.service.ts:47-231`); RM-batch release, signed-delta stock adjustment, and FEFO availability (`available = onHand − reserved`) all correct; reserve→release nets out live.
- **Quality disposition (live-proven).** `dispose()` flips `overall_result`+status and emits `quality.qc.passed/failed/hold` **in the same tx**; HOLD verified live → `quality.qc.hold` email SENT (`inspections.service.ts:181-244`).
- **Formula Vault (security core).** Seal = AES-256-GCM per-formula DEK wrapped under KEK; **`decryptVersion` is the single decrypt chokepoint**, APPROVED-only, writing a hash-chained audit row in the same tx; masking interceptor is global + fail-closed. 3 formulas / 3 audit rows live (`vault.service.ts:66-103`).
- **Production crown-jewel flow.** `createOrder` reads the APPROVED formula's pick list through the vault (403 on unapproved), expands the BOM, emits `production.order.created` atomically; pick-list→material-issue→mixing→oil-batch→production-qc all transactional + events; `qc.recorded` → email (`planning.service.ts:162-221`).
- **Packaging → FG → dispatch loop.** package_order→filling→FG-batch (emits `packaging.fg_batch.created` → email); FG-stock ATP read-model (`produced − dispatched − consumed − reserved`, FEFO); reservation create/release; dispatch over-dispatch guard (409) — the write/read loop is genuinely closed (`batch.service.ts`, `fg-stock.service.ts`, `dispatch.service.ts`).
- **Sales/dispatch.** order create+items→confirm, dispatch create+items with over-dispatch guard, dispatch-document chain (challan/invoice/eway/POD) — all live with real rows.
- **M12 notify (live-verified).** In-process worker drains 7 cluster outboxes, routes by role, and delivers via Resend: **47 SENT / 3 LOGGED across 9 distinct multi-role recipients and 14 event types**; condition-scan auto-approves PO <₹25k >24h (4 `po.auto_approved` rows prove the UPDATE fires). SEARCH (with params), EDIT-registry PATCH, DOCUMENTS versioning, DASHBOARD (30 aggregates), TRACE (FG→vendor), GEO/ORGUNITS CRUD all read live.
- **Event backbone.** Outbox→EventBus drain (2s poll) + Ed25519-signed hash-chained relay **export** that correctly excludes `formula.*`.

## 4. What's left (prioritized)

### First, separate the two kinds of "empty"

- **Unseeded data — TRIVIAL (run a seed/POST, no code):** the 12 masters returning `200`-but-empty in the sweep — bins, brands, business-units, contacts, countries, currencies, floors, location-types, organizations, product-categories (M01), plus vendor-credit-notes (M02) and stock-audits (M04). Every one has a live POST create route. **Effort: ~0.5 day of seed data.** Do **not** confuse these with functional gaps.
- **Reproducibility — REAL but bounded (write migrations):** several tables the running code depends on exist only via out-of-band DDL / `.cjs` scripts and are **absent from the Drizzle `db:push` pipeline**, so a *fresh* (or offline) deploy breaks. See HIGH-R below.

### HIGH — must fix (blocks correctness, security, or a clean deploy)

**Security (defeats the formula-protection thesis — the platform's raison d'être):**
- **H-S1 · Privilege escalation.** Any `admin` holds `iam:user_role_mapping:write` and `createUserRole` is an unguarded insert with no subset check — admin assigns itself `owner`, gaining `formula:actual:read`. The seed invariant only restricts *who* may grant, never *which* role (`security.service.ts:215-231`, `db-seed.ts:72-75`, `app.js:1600-1606`). **Fix:** enforce granted-role ⊆ granter-perms, or hard-block granting `owner`/`Super Admin`. **~1 day.**
- **H-S2 · Password-reset escalation.** Admin holds `iam:user_master:write`; `setPassword` has no rank guard, so admin overwrites the owner's hash and logs in as owner (`auth.controller.ts:44-51`). **Fix:** forbid resetting a higher-privileged user. **~0.5 day.**
- **H-S3 · SEARCH broken function-level auth.** `GET /v1/search?resource=/v1/vendors` returns `select * from procurement.vendor_details` (bank_account_number, ifsc, gstin, pan) to *any* authenticated user, bypassing `procurement:vendor_details:read` (`search.service.ts:58-62`, self-admitted follow-up at `search.controller.ts:4`). **Fix:** gate each search resource by its list-route read perm. **~1 day.**
- **H-R (reproducibility) · Schema-as-code holes → fresh deploy 500s.** (1) Five procurement objects (`vendor_negotiation`, `po_advance_payment`, `vendor_dispatch`, `purchase_order.replacement_of_po_id`, `iam.approval_matrix`) exist only via manual DDL — and `listPurchaseOrders` selects `replacement_of_po_id`, so even **the core PO list 500s** on fresh infra. (2) `sales.dispatch_document` has no Drizzle model / create script. (3) `notification_log`, `document_registry`, `finished_good_reservation`, `packaging_qc`, relay tables ship as `scripts/*.cjs`, outside `db:push`. **Fix:** author real migrations for all of the above. **~1.5–2 days.** **This is the single biggest blocker to standing up the offline console.**

**Write-side correctness (the "runs" side of the ledger):**
- **H-C1 · Stock transfer is record-only.** `createStockTransfer` inserts a row but never decrements source, moves location, or creates a destination balance (`stock.service.ts:290-310`). Transfers "succeed" but stock doesn't move. **~1 day.**
- **H-C2 · Inventory-transaction sign from free-text regex.** Direction is `/ISSUE|OUT|.../i` on `eventType`, ignoring the type master — TRANSFER/RETURN/ADJUSTMENT/blank all **add** to on-hand (`inventory.service.ts:238`). **~0.5 day.**
- **H-C3 · Production consumption never decrements RM on-hand.** Only 3 on-hand write-sites exist; none in production; material-issue records a boolean, not a quantity (`picking.service.ts:216`). Consumed RM still shows available. **~1–2 days** (also needs H-C6).
- **H-C4 · `releaseRmBatch` non-idempotent + never flips status → double-count** on re-run (`batch.service.ts:202-288`; UI guard keys off a status that never changes). **~0.5 day.**
- **H-C5 · `production_order` stuck `PENDING` forever** — no flow advances it and it's absent from the edit registry, so the "Generate pick list" action (gated on `INPROGRESS/PLANNING`) is a **dead-end for every new order** (`planning.service.ts:183`, `app.js:721`). **~1 day** (add status transitions).
- **H-C6 · Oil-batch lifecycle not domain-modeled** — maturation/release/hold/rework/fail are raw `status`-only PATCHes via the generic editor with **client-side-only** guards; an API caller can go `FAILED→RELEASED`, leaving no event-history and emitting nothing (`edit.service.ts:71-74`, `app.js:741-745`). **~1–2 days** (state machine + event-history + events).

**Integration (QC has no teeth):**
- **H-I1 · RM QC verdict has zero inventory effect.** `dispose()` never touches `rm_batch_master` and no inventory consumer subscribes to `quality.qc.*` — a FAILED batch stays available (`CODEBASE_MAP.md:82`). **~1–2 days.**
- **H-I2 · Packaging QC non-functional** — a FAIL never flips `finished_good_batch_master.status`, and ATP/dispatch ignore QC, so a leaking batch is fully sellable (`packaging-qc.service.ts:30-44`, `fg-stock.service.ts:27-66`). **~1 day.**
- **H-I3 · REWORK disposition is a dead-end** — no event, no email, no rework order; UI button posts into a void (`inspections.service.ts:215-240`). **~0.5 day.**

**Architecture (blocks the entire two-console value prop):**
- **H-A1 · Relay `importPackage` never applies.** It verifies (Ed25519 + hash-chain) and dedupes into `relay_inbox`, but **no consumer republishes** to the local bus / destination outbox — grep shows `relay_inbox` has zero readers. A paid order or a stock grant never materializes on the other side. Contradicts `TARGET_ARCHITECTURE.md:41,47`. **~2–4 days.** **Step 3 is pointless until this exists.**

### MED — fix before GA (governance, guards, lifecycle)

- **RBAC is append-only** — no revoke of role/permission anywhere (no `@Delete`; mappings not in edit registry); role/permission masters have no edit/deactivate. A wrong grant is permanent (`edit.service.ts:24-131`). **~1–2 days.**
- **No create-user UI**; API create demands a raw Argon2id `passwordHash` a browser can't produce — human users are seed-only (`security.dtos.ts:9-17`). **~1 day.**
- **Procurement flow endpoints have no server-side state-machine guard** — direct API can issue an unapproved PO or approve a never-submitted PR (`po.service.ts:347-378`). The ₹25k threshold is enforced only by the delayed notifier. **~1–2 days.**
- **Approval "matrix" is display-only reference data**, not an enforcement engine, and isn't reproducibly seeded (`procanalytics.service.ts:86-96`). **~2–3 days** if real routing is wanted.
- **Inventory:** stock-audit records counts but never reconciles variance into on-hand; no outbox on any ledger mutation; no negative-stock/over-issue/over-reserve guard; no QC gate on release; no edit for rm/inventory batches (`stock.service.ts`, `inventory.service.ts`). **~2–3 days as a batch.**
- **Formula access-control is inert:** `FORMULA_ACCESS_POLICY` grants can't reach any non-owner (edge perm is owner-only), role-scoped grants are ignored, and there is **no revoke**; role-isolation wall (separate `ra_vault` DB role) is not provisioned — app role reads the formula schema live; audit chain has no runtime verification / DB append-only enforcement (`formulas.service.ts:363-388`, `formula.tokens.ts:25`, `audit.ts:14-15`). **~2–4 days** (design-dependent).
- **CAPA has no lifecycle** (create-only, no update/close/verify, no UI); `dispose()` has no idempotency guard (double-dispose possible); no spec-based auto-grading against `material_qc_specifications` (`capa.service.ts`, `inspections.service.ts:94-106`). **~2–3 days.**
- **Production:** material-issue captures no qty/stock movement; production-QC no spec eval; no correction/cancel path for orders/docs. **~2 days.**
- **Packaging/Sales:** `package_order` frozen `DRAFT`; `packaging_material_master` is a dead table; `product_category` has no create UI; **two divergent ATP formulas** (BFF subtracts `consumed`, dispatch guard doesn't); dispatch guard bypassable via `POST /v1/dispatch-items`, non-aggregating for same-batch lines, and TOCTOU-non-atomic; no cancel path for sales orders. **~2–3 days as a batch.**
- **Notify has no delivery assurance** — no retry / dead-letter / failure alert; a bad `RESEND_API_KEY` silently degrades every urgent mail to `LOGGED` (`email-notifier.service.ts:112-123`). **~1 day.**
- **Two-console guards:** dispatch guard omits `consumed`, is non-atomic, and negative-qty passes; relay **export is not transactional** (cursor advances then package insert — a crash between them silently loses events); relay accepts a non-genesis first import. **~2 days.**

### LOW — polish / hardening

- 12 unseeded masters (trivial seed — see above); no login rate-limiting/lockout; stateless refresh with no reuse-detection/logout-invalidation; several reference masters (currencies/brands/product-categories/vendor-credit-reasons) have no correction path and are unseeded; orphaned backend reads (oil-batch-consumption/events, mixing-step-logs, qc-dispositions/attachments/capas) with no UI; spoofable `disposedBy`/`retainedBy` (body-supplied); masking coupled to the literal `materialId` key; GEO `updateRegion` can't null a parent; auto `soNumber` collision risk (last-5 of epoch-ms). **Batchable, ~2–3 days total, non-blocking.**

## 5. Two-console track — remaining (steps 3–5)

| Step | Scope | % | Note |
|---|---|---:|---|
| Step 1 — FG stock/ATP + reservations | read-model + reserve/release lifecycle | **~85%** | Read side real and live; only guard-formula/atomicity dents |
| Step 2 — Relay (export/import/status, Ed25519, boundary) | signed store-and-forward courier | **~55%** | Export/sign/chain/dedup real; **import never applies** (H-A1); inert in live deploy (keys unset) |
| **Steps 1–2 combined (audited)** | | **62%** | Code-complete courier that logs the mail but never delivers it |
| Step 3 — Offline console | FileKmsAdapter key ceremony (~60-line swap at `formula.module.ts:50`), CONSOLE=factory/online role+login split, Resend→local SMTP | **~0%** | Not started; **depends on H-A1 relay-apply + H-R migrations** |
| Step 4 — Storefront | public shop/cart/checkout/payments (+ channel-allocation ledger w/ atomic decrement) | **~5%** | Only the FG ATP read-model exists; the "overselling impossible by construction" allocation decrement is absent |
| Step 5 — AI layer | online forecasting + factory local inference | **0%** | Not started |
| **Full track (steps 1–5, weighted)** | | **~25%** | ~40% weight on the partially-done 1–2, ~20% each on 3/4/5 |

## 6. Recommendation

**Do not jump straight to Step 3 (offline console) today.** Step 3 is literally standing up a *second* deployment and having the two consoles exchange state — and three things guarantee that fails or is pointless right now:

1. **A fresh deploy doesn't boot cleanly (H-R).** The offline console runs `db:push` + `db:seed`; that pipeline does **not** create `dispatch_document`, the 5 procurement objects (breaking even the PO list), or the 5 `.cjs`-provisioned tables. The offline console would 500 on day one.
2. **The relay is a courier that never delivers (H-A1).** Without the import-apply consumer, the two consoles can verify and log each other's packages but no order, stock grant, or dispatch ever lands on the other side. The entire "grant, don't replicate" value proposition is not wired.
3. **The formula-protection thesis — the whole reason this is a two-console, air-gapped design — is defeatable today (H-S1/H-S2).** Shipping a second console before closing the admin→owner escalation multiplies the attack surface on the recipe.

**Recommended sequence — a ~1.5–2 week "make-it-reproducible-and-safe" hardening batch, then proceed:**

- **Batch A (reproducibility, ~2 days):** author real migrations for all out-of-band tables/columns (H-R). This is the literal prerequisite for a clean second deploy.
- **Batch B (formula-thesis security, ~2 days):** close H-S1 (role-grant subset check / block owner grant), H-S2 (rank-guarded password reset), H-S3 (search read-auth). Cheap, high-leverage, directly protects the recipe.
- **Batch C (relay apply, ~2–4 days):** implement the `relay_inbox → local bus/outbox` republish consumer (H-A1) and make relay export transactional. This unlocks Step 3 having any point.

**Then Step 3 is sound to start.** One caveat to carry forward: the offline "stock-grant" flow inherits M04's ledger unreliability (transfer record-only, sign regex, no production deduction, double-release — H-C1–C4). If offline inventory accuracy matters at cutover, fold the M04 correctness batch (~2–3 days) into the pre-Step-3 work; otherwise it can follow.

**Bottom line:** The factory ERP is a real, running ~70% — a legitimately strong foundation, not a demo. The gap to "shippable two-console product" is not a long tail of missing features; it is **~2 focused weeks of reproducibility + security + relay-apply work**, after which Step 3 rests on solid ground. Proceeding *before* that work is the one path that compounds risk.
