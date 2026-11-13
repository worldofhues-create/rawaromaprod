# STOCK-E2E-1: raw material to sale, rehearsed with the owner's formulas

13 Nov 2026. Scratch databases only, dropped at the end. Nothing in this file is formula content: formulas
are F1 to F5, ingredients are "Fn row r", and an ingredient is named only where the finding is about its
name. The sheet was read at run time from the path the lead gave and was never copied.

## 0. What ran

| | RawProd | Alembic |
|---|---|---|
| Code | `lane/stock-e2e-rp` from `lane/floor-claims-rp` `ee14722` (production) | `lane/stock-e2e` from `origin/lane/qc-blind` `326772a9` |
| Database | private PostgreSQL 17.11 + PostGIS on 127.0.0.1:5561: `stock_e2e_rp`, `stock_e2e_rp_vault` (migrations, `db:seed`) | shared 14.17: `stock_e2e`, built by `ops/scripts/db-setup.sh` (non-superuser owner), `pnpm db:seed`, `import-rac-catalogue.mjs --apply`, `import-rac-codes.mjs --apply` |
| Processes | the real main API (worker in-process) and the real Vault API, as `e2e/harness/up.mjs` starts them | `buildServer` listening on 127.0.0.1:4371, dev-header verifier (as the API tests use) |
| Driven by | `tools/stock-e2e/*.mjs` on the RawProd branch: HTTP to the real routes, the signed Alembic assertion for sign-in | `apps/api/scripts/stock-e2e-alembic.ts`: the real routes through `app.inject`, the real bridge route over HTTP |

The bridge ran for real: RawProd's relay signed and POSTed every event to Alembic's
`/api/v1/bridge/rawprod/webhooks/:endpoint`; nothing was handed across by hand. No browser, no model call,
no external service, nothing deployed.

## 1. The sheet

- One sheet, 279 rows, five blocks. A block starts at a row whose column B reads `gram` (rows 1, 33, 107,
  179, 239) and ends at a row whose column A reads `TOTAL (g)` (rows 30, 104, 176, 237, 279).
- **Ingredient lines: F1 28, F2 70, F3 68, F4 57, F5 38 (261).** Totals by column B: **F1 1,000 g; F2 to F5
  100 g each.** The brief's 29/71/69/58/39 lines and 2,000 g / 200 g come from counting the `TOTAL (g)` row as
  an ingredient (the loader's first pass made the same mistake and created a material called `TOTAL (g)`).
- **Distinct ingredient names: 208 spellings, 196 after trimming and case.** 70 spellings carry a leading or
  trailing space; 11 names appear in two or three spellings (case and spaces only, e.g. `HEDIONE HC` in three).
  Beyond that, several pairs look like one material in two languages or two spellings (`CITRONELLAL` and
  `CITRONELAL`; Spanish and English names of the same 10 % DPG dilutions). The loader did not merge them: it
  cannot tell, and the system did not either (STK-18).
- **38 names carry a dilution** ("10% DPG", "1% DPG", "0.1% DPG", "10% DEP", "50% DEP"). They are separate
  materials to the system: a dilution is a different lot with its own code. Two solvents appear as lines in
  their own right (one of them, `IPM`, twice: F4 rows 198 and 199).
- **A line repeated inside one formula:** F3 rows 167 and 169 (same name), F4 rows 198 and 199. The Vault refuses
  a recipe with a repeated material ("line N repeats the material on line N"); the loader merged each pair by
  adding the grams, as a formulator would have to.
- **F5 row 262** is an ingredient whose name begins with "Total"; a loader that treats any "Total..." row as the
  block total silently drops it (the block then sums to 99.5 g).
- Blank rows inside blocks: 31, 32, 105, 106, 177, 178, 238, 240 (240 sits between F5's header and first line).
- **Column C** is present on F2 to F5 only (233 cells) and is **exactly 10 x column B on every row** (16 cells
  are the formula `=Bn*10`, the rest typed). Its header is also `gram`. It is the same recipe scaled to a
  1,000 g batch, not a percentage and not a code. F1 has no column C because its column B is already 1,000 g.
- Every column B value has at most 2 decimals of a gram (10 mg resolution); the smallest line is 0.02 g.

## 2. The rehearsal, step by step

| # | Step | Route or service | Worked | Evidence (counts, states, ids only) |
|---|---|---|---|---|
| 1 | 196 raw materials | `POST /v1/materials`, `POST /v1/floor/codes` (2 calls each), families `PUT /v1/floor/families/:code` | Yes | 196 created, 196 floor-coded (201), 2 s. No families existed (0); "Signal" (D-2) had to be created. Same code twice: 409. Same name twice: **201** |
| 2 | Opening stock | one PO of 226 lines (approve 201, issue 201, ack 201), gate entry, GRN of 226 lines, 226 inspections | Yes | 226 lots (196 + a second, earlier-expiring lot for F1's 28 materials + 2 probes). ACCEPT before a sample: **409** "Record the sample result first". 225 x results+sample+disposition 201/201/201. 224 lots released, 18,965 g received, 17,965 g on hand (the FAIL and the UNTESTED probe lots never reach the ledger). Supplier lot: no field |
| 3 | F1 to F5 into the Vault | `POST /v1/formulas`, `POST /v1/formula-recipes/import` (percent only), approve, lock | Yes, in percent | All five committed at 100 %, version 1. F3 and F4 refused until the repeated lines were merged. Author approves: **403** x5; second person: 201 x5; lock 201 x5. A recipe at **99.96 %** committed with a warning and was **approved (201)**. A version with **nothing sealed** was submitted and **approved (201)** (fixed, STK-6) |
| 3b | Who can read it | `GET /v1/formula-versions/:id/ingredients`, `POST .../actual` on the Vault | Yes | picker, verifier, mixer, sales, production, qc, warehouse: 403 and 403. formulator 200/201; vault_approver and owner 200 (ids and sequence only, nothing sealed shown) and 403 on `actual`. The main box has no such route (404). An Alembic person with no RawProd account: sign-in refused 401 `AUTH_UNKNOWN_USER`. Audit: 62 rows, 14 `security.permission.denied`, 1 `formula.actual.read` allow, 1 refuse. Mixer sees **no** name on any step (D-1 not built, STK-15) |
| 4 | Production order, scaled | `POST /v1/production-plans`, `/production-plan-items`, `/production-orders`, `/pick-list` | Yes in g | F1 at 5 kg (B1) and F2 at 1 kg (B2): every line exact to the mg, totals 5,000,000 and 1,000,000 mg. Ordered in kg, F1 at 5 kg totals **5,000,100 mg** (2 lines rounded up 50 mg each, STK-7). F2 at 333 g: 32 lines are part of a mg; the floor job is refused (STK-8). Reservations made by an order: **0** (STK-9) |
| 4a | Pick | `GET/POST /v1/floor/jobs/:id/pick...` | Yes | Picker sees code, colour, lot, bin, no name, no grams. Wrong material: 409 and the line stops; right lot while stopped 409; resume by the same person 403, by a supervisor 201. Off-FEFO lot without a reason 409, with one 201. A lot too small is never offered; quarantined and failed lots have no ledger row and no label, so cannot be scanned |
| 4b | Verify | `.../verify/lines/:line`, `.../verify/complete` | Yes | Picker verifies: 403. Out of tolerance: kept on file, not verified. B1: 28 lines, 9 weighed under target inside tolerance, 4,998,822 mg against 5,000,000 |
| 4c | Compound | `.../mix/steps/:seq`, `.../mix/complete` | Yes | Verifier mixes 403; out of order 409; complete early 409; batch number assigned by the floor (`B-2611-0001`) |
| 4d | QC 1, macerate, QC 2 | `POST /v1/production-qc`, `/oil-batches/:id/transition`, `/v1/maceration/settings/:formulaId`, `/runs/:id/release-early` | Yes, bypassable | Release before QC 409; macerate before QC 1 409; run opens at 45 days; release on day 1 409; early release: compounding, qc, production 403, admin **201 (one person)**; release without QC 2 409; after QC 2 201. B5: **HOLD then RELEASED on one QC PASS, maceration never ran (201)** (STK-12). B3 QC 1 FAIL: maceration refused 409, FAILED 201 |
| 4e | Pack, label, FG | `/v1/package-orders`, `/filling-sessions`, `/finished-good-batches`, `/batch-coas`, `/labels`, `/packaging-qc` | Yes, unbounded | B1 49 x 100 g, B2 19 x 50 g, B6 9 x 100 g. Label before QC release 409; packaging QC before a label 409. Lot number typed by the caller and printed (`FG-B1-TYPED`); the same number again on another batch: **201** (STK-13). B5: 14 x 50 g filled from 499.676 g of oil (accepted, STK-11) and an FG batch of **59** units accepted (STK-4, fixed). Batch without a number: 422 |
| 4f | Hand to finished goods | `POST /v1/shelf/layout/rack`, `/v1/shelf/tasks/:id/putaway` | Yes | Put-away 201 sends `fg.batch.received` in the same transaction |
| 5 | The stock equation | `tools/stock-e2e/reconcile-rp.sql`, `ops/scripts/stock-e2e/reconcile-alembic.sql` | Raw side yes; finished side no | Section 3 |
| 6 | The bridge | relay -> `/api/v1/bridge/rawprod/webhooks/:endpoint` | Partly | Every event first parked `bad_org_id` (RawProd needs `ALEMBIC_ASSERTION_TENANT_ID`, STK-26); replayed 201 x4. `qc.batch.released` for B1 then **parked on Alembic `unknown_aggregate`** (no SKU mapping, STK-1); B1's lot arrived **QUARANTINE 4,900,000 mg** and stays there. With a mapping made first (`POST /api/v1/bridge/sku-mapping` 201), B6's release applied and its lot arrived **ON_HAND 900,000 mg** |
| 6a | Stock to the customer (LD-116) | `GET /api/v1/storefront/catalogue/variants/:code` | Yes | Before the lot: `on_request`. B1 lot in quarantine: still `on_request`. B6 lot released: `in_stock`, but `price_on_request` and not addable (STK-21) |
| 6b | Bag, order | `POST /api/v1/cart/variant-lines`, `POST /api/v1/orders` | Only by the trade size | Bag 409 (price on request). Web order with the variant: 400 "'abf' is not sold in '100 g'"; web 10 ml: 409 no density (STK-22); Sales Desk 1 kg: 201, `awaiting_payment`, **held 900,000 mg from the factory lot, 100,000 mg backordered** |
| 6c | Pay, pack, invoice, ship, deliver | proforma, `/payments/statement-import`, `PATCH /orders/:n`, `/invoice`, `/shipments`, `/shipments/:id/scans` | All but the invoice | NEFT matched; packed 200 **with the 100 g still backordered** (STK-24); invoice **409 no HSN on 'abf'** (89 of 89 SKUs have none, STK-23); shipment 201; scans 200 x3; delivered 200. Lot movements: ON_HAND -> RESERVED -> IN_TRANSIT -> delivered, 900,000 mg each |
| 6d | Lot on the customer's document | invoice, shipment view | No | No invoice could be raised; the invoice code carries no lot field and the shipment view names none (STK-25). The lot is in the stock ledger only |
| 6e | Return | `/orders/:n/goods-returns`, decision, shipment, receipt, inspection (restock) | Yes, wrong number | 201/200/200/200/200; refundable 650,770 paise. **The lot got back 1,000,000 mg though 900,000 left it** (STK-3, fixed) |

## 3. The stock equation

RawProd, `reconcile-rp.sql` (integer mg, read only), after all batches:

| | Lots | Received | Issued | On hand | Issued = weighed | Lots not balancing |
|---|---|---|---|---|---|---|
| R1 raw lots | 224 (107 drawn from) | 17,965,000 | 8,496,951 | 9,468,049 | 8,496,951 = 8,496,951 | **0** |

| Job | Batch | Oil status | Formula target | Weighed | Debited | Ledger issue | Oil made | Genealogy | Packed | Not recorded anywhere |
|---|---|---|---|---|---|---|---|---|---|---|
| J-0001 (B1, F1 5 kg) | B-2611-0001 | RELEASED | 5,000,000 | 4,998,822 | 4,998,822 | 4,998,822 | 4,998,822 | 4,998,822 | 49 x 100 g = 4,900,000 | 98,822 left in the oil; 1,178 under target |
| J-0002 (B2, F2 1 kg) | B-2611-0002 | RELEASED | 1,000,000 | 999,345 | 999,345 | 999,345 | 999,345 | 999,345 | 19 x 50 g = 950,000 | 49,345 |
| J-0003 (B3, QC fail) | B-2611-0003 | FAILED | 1,000,000 | 999,345 | 999,345 | 999,345 | 999,345 | 999,345 | none | **999,345 consumed, no write-off** |
| J-0004 (B4, shortfall) | none | job at PICK | 1,000,000 | none | none | none | none | none | none | line 1 has half its need; queue `waitingOn` its code; job open, nothing reserved |
| J-0005 (B5, probe) | B-2611-0005 | RELEASED (no rest) | 500,000 | 499,676 | 499,676 | 499,676 | 499,676 | 499,676 | 14 x 50 g = 700,000 | **200,324 more packed than made**; FG batch 59 units before the fix |
| J-0009 (B6, F1 1 kg) | B-2611-0009 | RELEASED | 1,000,000 | 999,763 | 999,763 | 999,763 | 999,763 | 999,763 | 9 x 100 g = 900,000 | 99,763 |

- **The raw side balances to the milligram**: per lot, received - issued = on hand on all 224 lots; on every
  floor line the debit is the scale reading (R3: 0 lines where debit differs from weight), never the formula's
  grams. The order total equals the formula target total for every order made in grams (R4: 0); the one order made in kg (F1, 5 kg) carries 5,000,100 mg of targets against 5,000,000 ordered (R4: -100, STK-7). Jobs J-0006 to J-0008 are the scaling probes, left at PICK.
- **The finished side does not balance, because nothing records the difference.** Oil made is the sum of the
  weighed lines by construction (`floor-station.service.ts:693` `const producedMg`), so compounding loss is
  always 0. Packing does not draw the oil down: `oil_batch_master.produced_qty` is unchanged after every fill,
  there are 0 `finished_goods_batch_consumption` rows, and no table in `production`, `packaging` or
  `inventory` has a yield, loss, scrap or remnant column (R6: only GRN variance and stock audit). A failed
  batch's consumption is not written off.
- **Across the bridge the finished side does balance where it ran:** B1 49 units x "100 g" = 4,900,000 mg sent,
  4,900,000 mg received by Alembic; B6 900,000 sent, 900,000 received, held, shipped and delivered.
- Alembic, `reconcile-alembic.sql` A1/A2, before the STK-3 fix was deployed to this scratch run:
  `FG-B1-TYPED` received 4,900,000, all QUARANTINE, 0 QC releases on file. `FG-B6-TYPED` received 900,000,
  delivered out 900,000, returned **1,000,000**, balance **1,000,000**: the lot holds 100,000 mg it never
  received (A2 `returned_beyond_delivered_mg` = 100,000). The fix and its test are on this branch.

## 4. Defects (STK-n)

Severity: **G** blocks go-live, **N** wrong number, **M** missing step, **A** awkward.

| # | Sev | What | Where | Smallest fix | Status |
|---|---|---|---|---|---|
| STK-1 | G | A QC release for a factory SKU made on RawProd (not by Alembic's factory-catalogue sync) parks on Alembic `unknown_aggregate`: `product_ref` carries only `factory_sku`, which needs a `bridge_sku_mapping`, while `fg.batch.received` finds the same SKU by its code. The lot is received QUARANTINE and never released | Alembic `apps/api/src/compliance/service.ts:1061` `skuByFactorySku`; RawProd `qc.batch.released` payload (`cluster-production/src/coa/coa.service.ts`) | RawProd sends `product_ref.sku` (its sku code IS the commercial code, `factory-setup/catalogue.contract.ts:17`); or Alembic falls back to `skuByCode`. One release, both repos | No RawProd wire change: Alembic resolves `factory_sku` like `fg.batch.received` (`stock-bridge-contract.md` section 1, STOCK-FIX-A) |
| STK-2 | G | A fact Alembic parked can never be applied: RawProd received 200 and marked it delivered, Alembic has only a read of unprocessed events | Alembic `apps/api/src/server.ts:12769` `unprocessed-events` (GET only) | An admin "re-apply" that runs the same handler on the stored envelope | WO-STK-2 |
| STK-3 | N | A return restocked the ORDERED mass onto the lot, not what left it (1,000,000 mg back from a 900,000 mg shipment) | `apps/api/src/services/goods-return.ts:114` `returnQtyMg(line.qtyMg` | Cap the inspection's movement at the line's confirmed holds less earlier returns | **Fixed** `e0b7ac8a` (test first) |
| STK-4 | N | An FG batch could hold more than its package order filled (59 accepted on 14 filled) | `backend/cluster-packaging/src/batch/batch.service.ts` `produceFinishedGoodBatch` | Bound by filled, less rejected, less batches already made, in the same unit | **Fixed** RawProd `6f0e355`; re-proved through the API: 409 on 10 of 2, 201 on 2 |
| STK-5 | N | The Vault accepts and approves a recipe that does not total 100 % (99.96 % committed with a warning, approved). VAULT.md rule 2 says the wizard refuses it | `backend/cluster-formula/src/setup/formula-setup.service.ts:415` (warning); `approvals.service.ts` `approveVersion` (no total) | Error at import; at approve, the Vault sums the sealed lines inside its own decrypt. Fixtures approve 12.5 % recipes (`vault-sod.test.ts`), so the Vault lane changes them with the decision | **Fixed** STOCK-FIX-RP `d766fd6`: refused at commit and at approval unless exactly 100 % |
| STK-6 | N | A version with nothing sealed on it was approved | `approvals.service.ts` `approveVersion` | Refuse when no ingredient and no stage ingredient is sealed | **Fixed** RawProd `f57efcc`; re-proved: 409 |
| STK-7 | N | The pick list rounds each line to 4 decimals of the ORDER's unit: F1 at 5 kg ordered in kg totals 5,000,100 mg; in g it is exact | `backend/cluster-formula/src/pick-quantity.ts:45` `pickLineRequiredQty` | Compute lines in mg, or refuse an order whose lines do not total its quantity | **Fixed** `46f3cc8`: the Vault splits the order in integer mg (largest remainder); re-run R4/R8: 0 mg off on every order |
| STK-8 | A | A batch size off the mg grid (F2 at 333 g) is refused only at the floor job, with "Correct the pick list", which nobody can | `backend/api/src/floor/floor-station.service.ts:205` | Refuse at order creation and name the nearest sizes that work | **Fixed** `46f3cc8`: refused at order creation with the sizes that work; 333 g now plans (333,000 mg) |
| STK-9 | M | Nothing is reserved at planning (LD-19, WO-STOCK-1): 0 reservations for every order; a shortfall order (B4) is created and its floor job opened; the queue then shows `waitingOn` | `backend/cluster-production/src/planning/planning.service.ts:172` | Reserve formula grams x batch size per lot (FEFO) at order creation, in one transaction | **Fixed** `46f3cc8`: reserved at planning (FEFO lot per line), short known at planning, cancel releases, issue consumes |
| STK-10 | M | No loss, yield, remnant or write-off is recorded: compounding loss is 0 by construction, packing never draws the oil down, a FAILED batch writes nothing off (WO-STOCK-3) | `floor-station.service.ts:693`; `packaging` schema | Batch close: formula vs weighed per line, oil made vs packed, the remnant and the loss each a recorded movement | **Fixed** `c0cabdd`: the oil ledger (made, packed, rejected, loss, write-off, remnant); R7 balances every batch |
| STK-11 | N | A package order and its fill are not bounded by the oil batch: 700,000 mg packed from 499,676 mg | `backend/cluster-packaging/src/orders/orders.service.ts:69` | Refuse packs whose mass exceeds the oil remaining (needs STK-10's oil balance) | **Fixed** `c0cabdd`: re-run: 14 x 50 g on 499,676 mg refused 409 |
| STK-12 | G | Maceration skipped: HOLD then RELEASED on one QC PASS on a formula with a 45-day rest (LD-85, LD-99) | `cluster-production/src/batch/batch.service.ts:42`; `backend-kernel/src/events/maceration-gate.ts:144` | as built on `lane/promises-rp` | Fixed on `lane/promises-rp` (PROM-2), not in production |
| STK-13 | G | The FG lot number is typed and can repeat another lot's (`FG-B1-TYPED` accepted twice) | `cluster-packaging/src/batch/batch.service.ts:94` `batchNumber: body.batchNumber` | as built on `lane/promises-rp` | Fixed on `lane/promises-rp` (PROM-4: minted at fill) |
| STK-14 | A | Early release of a resting batch is one person (admin) with a reason | `backend/api/src/floor-ops/maceration.service.ts:128` | as built on `lane/promises-rp` | Fixed on `lane/promises-rp` (PROM-2) |
| STK-15 | M | D-1 (LD-35) is not built: the mixer sees "Add line N: CODE" only; no scoped reveal on the current step, no reveal log | `floor-station.service.ts:215` | WO-FLOOR-6 | **Fixed** `4cd8035`: assigned mixer, current step, logged; hostile cases refused |
| STK-16 | M | No supplier lot at goods receipt, so a raw lot cannot be traced to the supplier's batch | `backend/cluster-inventory/src/*.dtos.ts:71` `grnItemInput` | A `supplierLotRef` on the GRN line, carried to the RM batch | **Fixed** `f1b7392` |
| STK-17 | A | No bulk import for raw materials: 196 materials are 392 calls (create, then floor code) | no route (grep for an import under `cluster-masterdata`) | A CSV import with a dry run, as the recipe import has | **Fixed** `f1b7392`: `POST /v1/materials/import`, 196 materials in 2 calls |
| STK-18 | A | The master takes a second material with the same name (201), has no hazard class field, and a sheet's total row becomes a material | `backend/cluster-masterdata/src/*.dtos.ts:53` `createMaterial` | Refuse a duplicate normalised name; the import (STK-17) flags total rows and spelling variants | **Fixed** `f1b7392` |
| STK-19 | A | No floor-code families are seeded, not even Signal (D-2); each of 196 materials needs a family a person chooses; numbers are drawn at random 1 to 9999 | `backend/api/src/floor/floor-code.service.ts:72` | Seed the owner's families; the import takes a family column | **Fixed** `f1b7392`: nine D-2 families seeded; numbers in order |
| STK-20 | N | The FG label's "net quantity" is the lot's total (49 for 49 x 100 g), with the unit `pcs`, not the pack's net content | `backend/api/src/packaging-qc/fg-label.service.ts:150` | Print the pack size as net content; the lot total is a carton/lot field | **Fixed** `9cec9ec` |
| STK-21 | G | Three pack vocabularies do not meet: RawProd `pack_size` is free text ("100 g"), the RAC register's packs are g/kg/ml with `net_qty_mg` empty on all 21,650 variants, Alembic's fragrance-oil ladders sell 10/25/50 ml retail and 1/5/25 kg trade. The sale link accepted RAC 100 g -> `abf` (201) and that variant is "price on request" for ever | `apps/api/src/storefront/sf-link-routes.ts:517` `linkVariantToSku`; refusal at order `packages/domain/src/pricing/authority.ts:596` | Refuse a link whose size the SKU's ladder does not sell; one pack list shared by RawProd SKUs, the register and the ladders | RawProd side done `a91f565` + LD-145: `pack_count`/`pack_net_mg` for filled lots (contract section 2); the pack list itself is Alembic and the owner |
| STK-22 | G | No density on any of the 45 fragrance-oil SKUs, so a millilitre retail order of a mass lot is refused (correctly, fail closed) | `packages/domain/src/inventory/shopify-stock.ts:27` | Owner data: sourced densities | Owner (LD-49) |
| STK-23 | G | No HSN code on 89 of 89 SKUs, so no tax invoice can be raised (correctly refused) | `apps/api/src/sales-docs/store.ts:147` and the invoice path | Owner data: HSN per SKU | Owner (LD-49) |
| STK-24 | N | A 1 kg trade line held 900 g from a lot of 100 g bottles was paid in full, packed and delivered with 100 g still backordered, with no part-shipment record. Alembic stock is mass per SKU; the bottle is not modelled | `PATCH /api/v1/orders/:n` status `packed` (no backorder check) | Refuse packed while a line's holds are under its mass, unless a person records a part-shipment | WO-STK-24 |
| STK-25 | M | The lot is not on the customer's documents: the invoice code has no lot field, the shipment view names none | `apps/api/src/services/raise-invoice.ts` (no lot or batch field) | The documents lane prints the lot per line (PROM-7) | PROM-7 |
| STK-26 | A | RawProd parks every fact not tied to a requirement (QC release, GRN, PO) as `bad_org_id` unless `ALEMBIC_ASSERTION_TENANT_ID` is set. Production sets it (`infra/aws/env/render-env.sh:78`); the e2e stand-up does not, so no local stack rehearses make-to-stock | `backend/api/src/bridge/relay.service.ts:67` `fallbackOrgId` | Set it in `e2e/harness/up.mjs` | **Fixed** `a91f565` (e2e stand-up) |
| STK-27 | A | A verifier's weight may be typed (`source` defaults to typed) with no signature; FACTORY.md says readings are never typed and the typed check is a signed fallback | `floor-station.service.ts:502` | Accept a typed weight only with a signed typed-check id | **Fixed** `9cec9ec`: typed needs a signed check; no source refused |
| STK-28 | A | Material names are readable by warehouse, QC and RawProd sales (`GET /v1/materials`, and a warehouse lot scan); floor roles are refused. Not the formula, but tied to a job's lots it names the ingredients | `scripts/ra-roles.ts` (role grants) | Decide per FACTORY.md "who sees what" | Owner's decision: options in section 9.2; nothing changed |
| STK-29 | A | `GET /v1/inventory-availability` stops at 200 rows with no cursor (224 lots: 24 never shown) | `backend/api/src/inventory-view/inventory-view.service.ts:21` | Cursor pagination | **Fixed** `9cec9ec`: keyset cursor |

Counts: **G 7** (STK-1, 2, 12, 13, 21, 22, 23), **N 8** (STK-3, 4, 5, 6, 7, 11, 20, 24), **M 5** (STK-9, 10, 15, 16,
25), **A 9** (STK-8, 14, 17, 18, 19, 26, 27, 28, 29). Fixed here: STK-3, STK-4, STK-6. Fixed on `lane/promises-rp`
and not in production: STK-12, STK-13, STK-14. Owner data: STK-22, STK-23.

## 5. What the 196 ingredients need that the sheet does not give

| Field | Why the system needs it | In the sheet |
|---|---|---|
| Material code | `materialCode` is required and unique; the loader minted `REH-RM-nnn` | No |
| Floor family (colour) | no floor code, no floor job ("File its material under a family first") | No |
| Unit of the lot | the floor weighs in mg; a lot kept in kg cannot hold a 2-decimal-gram line at 5 kg exactly. Received in g | Implied (grams) |
| Supplier, supplier lot | supplier via `vendor-rm-mappings`; supplier lot has no field (STK-16) | No |
| Shelf life / expiry, manufacture date | GRN lines; FEFO; expired lots refused at pick | No |
| QC parameters and spec | incoming inspection results are required before ACCEPT | No |
| Dilution identity | which base material and which solvent a "10% DPG" line is, so a dilution can be made and traced | Only in the name |
| CAS, density, hazard / DG class | optional in the master; without them labels print "Classification pending", compliance cannot calculate, and no volume pack can be priced | No |
| One spelling per material | 208 spellings for 196 names, and several cross-language pairs | No |

## 6. What the consoles need that the APIs do not provide

- **Factory**: one batch route read per job (station, lines with code, bin, lot, target and weighed mg, who and
  when, QC rounds, the rest run, packs, put-away): today it is five separate station reads and no join. The
  reservation per line (none exists, STK-9). Yield and loss at batch close, oil remaining after packing, the
  remnant and the write-off (none, STK-10). The FG units against filled against oil (STK-4, STK-11).
- **Vault**: the total per version and its difference from 100 % / 1,000 g per kg (STK-5); grams per kg view
  (only percent is stored, the console converts); the station route preview for a chosen batch size (the
  pick list is resolved only inside planning, no read route); the mixer's scoped reveal and its log (STK-15).
- **Platform**: the bridge's tenant id state (STK-26); parked outbound events (exists,
  `GET /v1/bridge/outbox/parked`); whether each factory SKU has a mapping on Alembic (none, STK-1).
- **Admin (Alembic)**: re-apply a parked inbound fact (missing, STK-2); the SKU mapping queue (exists:
  `GET /api/v1/bridge/sku-mapping-queue`, `POST /api/v1/bridge/sku-mapping`); a factory lot's QC state and why
  it is held (`lot_available`, `qc_batch_release`: data exists, no single read for a lot from the bridge);
  a sale-link check that the size is on the SKU's ladder (STK-21); part-shipment on a backordered line (STK-24).

## 7. `lane/promises-rp`

Read, not rehearsed: 13 commits on top of production (PROM-2 to PROM-9), 92 files. It closes STK-12 (every batch
rests, HOLD/REWORK to RELEASED refused with no run), STK-13 (the FG lot minted at fill, a typed one refused) and
STK-14 (early release by a second person); adds the retained reference (PROM-3) and the continuity record
(PROM-5). It does not touch STK-4, STK-5, STK-6, STK-7, STK-9, STK-10, STK-11 or STK-15 (checked by `git diff`
of the files involved: no change to `cluster-formula`'s approve or totals, to the FG produced quantity, or to
the mix steps' names).

## 8. Running it again

RawProd branch, `tools/stock-e2e/rehearse.sh <sheet.xlsx> <run dir outside both repositories> <alembic worktree>`.
It reads the sheet with Python's standard library, prints counts, row numbers and statuses only, and refuses a
run directory inside either repository (the state it keeps there is formula-derived). The two reconciliation
queries are `tools/stock-e2e/reconcile-rp.sql` (RawProd) and `ops/scripts/stock-e2e/reconcile-alembic.sql`
(Alembic). Afterwards: stop the PIDs in the run directory, delete the run directory, drop `stock_e2e*`.

## 9. STOCK-FIX-RP (13 Nov 2026): what was fixed, and the rehearsal again

Branch `lane/stock-e2e-rp`, commits `c0cabdd` (STK-10/11), `46f3cc8` (STK-7/8/9), `d766fd6` (STK-5),
`4cd8035` (STK-15), `f1b7392` (STK-16/17/18/19), `9cec9ec` (STK-20/27/29), `a91f565` (STK-21/26), and the
LD-145 bulk rule with this section. Migrations `2026-11-20-stk-oil-ledger`, `2026-11-21-stk-reserve-at-planning`,
`2026-11-22-stk-mixer-reveal`, `2026-11-23-stk-materials`, each with a rollback; grants in
`docs/releases/stock-fix-rp-2026-11-13-permission-grants.sql` (5 codes, 21 grants).

### 9.1 The RawProd leg again (`tools/stock-e2e/rehearse-rp.sh`, scratch PostgreSQL 17, every migration from empty)

The chain now runs from raw material to a labelled, released, QC-passed finished lot on every batch it is
meant to, and stops only where it is told to: B4 is kept off the floor because it is short (and cancelled,
releasing 66 holds), B5's over-order is refused at the package order, B3 failed QC and is written off. The
bridge leg (`rehearse.sh`, which needs an Alembic scratch database) was not re-run in this unit.

| Batch | Status | Formula target | Weighed = made | Packed | Rejected | Loss | Written off | Remaining (remnant) | Yield |
|---|---|---|---|---|---|---|---|---|---|
| B1 (F1 5 kg) | RELEASED | 5,000,000 | 4,998,822 | 4,900,000 (49 x 100 g) | 0 | 0 | 0 | 98,822 (KEEP) | 98.02 % |
| B2 (F2 1 kg) | RELEASED | 1,000,000 | 999,345 | 950,000 (19 x 50 g) | 0 | 345 | 49,000 | 0 (WRITE_OFF) | 95.06 % |
| B3 (F2, QC 1 fail) | FAILED | 1,000,000 | 999,335 | 0 | 0 | 0 | 999,335 | 0 (WRITE_OFF) | 0 |
| B4 (F3, short) | not made | 1,000,000 | | | | | | refused at the floor: one line 16,000 mg on one lot, best lot 8,000 | |
| B5 (F2 500 g) | RELEASED | 500,000 | 499,676 | 0 (14 x 50 g refused) | 0 | 0 | 0 | 499,676 (HOLD) | 0 |
| B6 (F1 1 kg) | RELEASED | 1,000,000 | 999,784 | 900,000 (9 x 100 g) | 0 | 0 | 0 | 99,784 (KEEP) | 90.02 % |

R1: 224 raw lots, received 17,965,000, issued 8,496,962 = weighed 8,496,962, on hand 9,468,038, 0 lots not
balancing. R7: `chk_equation` 0 and `open_item` ok on all five oil batches; packed equals the filling records
x net content on every batch. R4/R8: every order's lines total the order, 0 mg (F1 at 5 kg in kg: 5,000,000).

### 9.2 STK-28: who may read a material name (the owner's decision; nothing changed)

Today `masterdata:material:read` (and so `GET /v1/materials` with names) is held by owner, procurement,
receiving, qc, warehouse, packaging, sales and showcase; the warehouse lot scan names the material for
warehouse. Floor roles see codes only; since D-1 the mixer sees one name, on its current step only.

| Role | What it needs the name for | Option A: keep (today) | Option B: codes, name on request | Option C: codes only |
|---|---|---|---|---|
| procurement | buying from a supplier who knows the material by name | keep | keep (it buys) | cannot buy |
| receiving | matching the supplier's label and CoA at the gate | keep | name on the GRN line only | matches by supplier code and lot only |
| qc | incoming QC against the supplier's CoA and spec | keep | keep | tests against a coded spec |
| warehouse | putting away and finding a drum labelled by the supplier | keep | lot scan names it, the list does not | finds by floor code and bin |
| packaging | the product name on the label (not a raw material) | product only, raw names not needed | codes | codes |
| sales | none for raw materials (it sells finished products) | drop raw names | codes | codes |
| showcase | the demo only | demo data only | codes | codes |

The risk the rehearsal named: a role that reads the names AND a job's lots can rebuild which materials a
formula uses (never the amounts). Option B removes that from sales and packaging and keeps the people who
must handle a supplier's drum able to.

