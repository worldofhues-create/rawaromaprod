# ALEMBIC OS Demo Factory — seed program

`scripts/demo-seed.ts` (`pnpm demo:seed`) builds a deterministic, idempotent demo dataset for
RawProd, clearly named **"ALEMBIC OS Demo Factory"** (`iam.org_master.organization_code =
ALEMBIC-OS-DEMO-FACTORY`). It drives state through the real Nest cluster services this repo's
own tests already use (`new PoService(procurementDb())`, etc.) and through the real G3
factory-automation layer (`backend/api/src/automation/*` — the lane brief's "F2 automation
layer"), so outbox events, bridge emissions, and `automation.decision_log` rows are genuine,
not fabricated.

## Running it

```
DATABASE_URL=postgres://... [FORMULA_DATABASE_URL=...] pnpm demo:seed
```

Safe to re-run: every top-level entity is keyed by a human-readable business key, and re-running
skips a whole chain once its root already exists (see the file's own header comment for the
exact strategy). `RAWPROD_ENVIRONMENT`, `FORMULA_KEK`, `BRIDGE_HMAC_KEK`, and `JWT_SECRET` all
default to stable, non-secret, demo-only values derived from a fixed label when unset — see
`demoKey()` in the script. The script refuses to run at all when `APP_ENV=prod` /
`NODE_ENV=production`.

## ID conventions

| Entity | Key pattern | Count |
|---|---|---|
| Materials | `DEMO-MAT-0001`..`DEMO-MAT-0060` | 60, synthetic names, **no genuine CAS numbers** |
| Vendors | `DEMO-VEN-01`..`DEMO-VEN-12` | 12 |
| Purchase requisitions | `DEMO-PR-0001`..`DEMO-PR-0014` | 14 (6 DRAFT, 2 SUBMITTED, 4 → RFQ → awarded, 2 APPROVED/no RFQ) |
| RFQs / quotations | `DEMO-RFQ-####` / `DEMO-QUOT-####-<vendor code>` | 4 RFQs, one awarded quotation each |
| Purchase orders | `DEMO-PO-0001`.. | ~40, across DRAFT/APPROVED/ISSUED/PARTIAL-received/COMPLETE/CANCELLED/AMENDED |
| Gate entries / GRNs | `DEMO-GE-####` / `DEMO-GRN-####` | one pair per PO that receives goods |
| RM batches | minted by the real `GrnService` (one per GRN item) | ~55+ |
| Formulas | `DEMO-FRM-001` "Demo Signature Accord", `DEMO-FRM-002` "Demo Citrus Veil" | 2, each one APPROVED version |
| Product / SKU | `DEMO-PRD-00#` / `DEMO-SKU-00#-050`\|`100` | 2 products × 2 pack sizes = 4 SKUs — these SKU codes **are** the bridge's `mapped_sku` values |
| Oil batches | `DEMO-OIL-####` | one per production order that reaches the batch stage |
| FG batches | `DEMO-FG-####` | one per package order that completes |
| Sales orders / dispatches | `DEMO-SO-####` | one per completed production order that reaches dispatch |
| Demo users | `<role>@demo.rawprod.local` (14 personas, one per role) | see **Identity** below |

## The ALEMBIC DEMO-ORD mapping (bridge story)

Every one of this lane's 30 production requirements arrives through the **real** inbound bridge
path (`ImporterService.handleAlembicEvent`, HMAC-signed, exactly as ALEMBIC would send it) and
is keyed by `order_ref`:

```
DEMO-ORD-0003 .. DEMO-ORD-0032   (30 ids, DEMO_ORD_START = 3 in demo-seed.ts)
```

This deliberately overlaps the example range given in the lane brief ("production requirements
reference DEMO-ORD-0003..0020 etc.") and extends it to 30 so every requirement lands a real,
distinct `bridge.production_requirement` row. Downstream, each requirement's own
`alembic_requirement_id` is the row this script (and the real `PlanningService.createOrder`)
links a `production.production_order` to — **that link, not the order_ref string, is what makes
a second run of this script skip the whole chain for an already-processed requirement.**

Distribution across the 30 (by index `i`, 0-based):

- `i < 6`  — stays in `PLANNING` with a genuine, real material shortage (the demo formulas'
  ingredients were never separately stocked via GRN, so `MaterialShortageService` fires for
  real and drafts a PR — "waiting on material").
- `6 <= i < 14` — reaches mixing (`ProductionStarted` emitted for real) but no further —
  "in progress".
- `i >= 14` — the full chain: mixing → oil batch + production QC → packaging → filling → FG
  batch → packaging QC → (on PASS) FG reservation (ATP) → sales order → dispatch. Every one of
  the bridge's 7 outbound emission hooks (`ProductionScheduled`, `ProductionStarted`,
  `QcStatusChanged`, `PackagingStarted`, `FgBatchAvailable`, `AtpAllocationGranted`,
  `DispatchReady`/`Dispatched`) fires from inside these real service calls — this script never
  calls `emitBridgeOutbound` directly.

`i % 9 === 8` deliberately fails packaging QC (FG held, no reservation/dispatch for that one) —
"packaging QC" pending/pass/fail coverage.

## Identity

One organization (`ALEMBIC OS Demo Factory`) and 14 users, one per role: `owner`, `admin`,
`procurement`, `receiving`, `qc`, `warehouse`, `compounding`, `production`, `filling`,
`packaging`, `sales`, `formulator`, `vault_approver`, `showcase`.

- **Vault-authority roles** (`formulator`, `vault_approver`) are granted through the **real**
  two-person `SecurityService` flow (S2 security review item A): an `owner` bootstrap identity
  *requests* the grant, a genuinely different, independently-created `admin` bootstrap identity
  *approves* it. Neither bootstrap identity is a puppet of the other (see
  `SecurityService.isInCreatorChain`) — each is its own throwaway root actor, never one created
  by the other.
- **`showcase`** reuses LANE D1's canonical demo account
  (`demo@demo.alembic.invalid`, passwordless, role code `showcase` from
  `scripts/ra-roles.ts`/`scripts/db-seed.ts`) rather than minting a second, password-
  authenticatable showcase account — `AuthService.login` refuses password sign-in for that role
  unconditionally, so a second such account would never actually be usable anyway. This script
  sets `RAWPROD_ENVIRONMENT=demo` (if unset) since that is what lets `showcase` hold a session at
  all. **Formulator and vault_approver stay this script's own separate synthetic demo staff —
  never the showcase account** (per the lane's coordination note).
- Every demo user's `AuthPrincipal.permissions` is asserted in-memory by this script (the same
  fixture pattern this repo's own tests already use — no HTTP guard is ever in the path here).
  This script does **not** re-seed the permission catalogue (`iam.permission_master` /
  `role_permission_mapping`) — that stays owned by `scripts/ra-roles.ts` + `scripts/db-seed.ts`.
  It seeds only bare `iam.role_master` rows for the roles above (reusing an already-seeded row
  by `role_code` if `pnpm db:seed` has already run against the target database).
- `users.showcase.permissions` is asserted to never include `formula:actual:read` — the
  structural proof that "the demo showcase role never sees plaintext."

## The formula vault workflow

Two formulas, each with one `APPROVED` version, driven through the **real** vault services
(`FormulasService`, `ApprovalsService`, `VaultService`, the real `FormulaLookupService`/
`EnvKmsAdapter`): the `formulator` user creates the formula, seals ingredients (real materials,
non-uniform percentages summing to 100), finalizes, and submits for review; a **genuinely
different** `vault_approver` user approves it (`ApprovalsService.approveVersion` throws if the
approver is the version's own creator — §108 SoD). `PickingService.resolveManufacturingInstruction`
resolves the real, alias-coded manufacturing instruction for every production order that reaches
picking — the one formula-derived read the `production`/`compounding` (and, in a demo
deployment, `showcase`) roles ever get, alias-masked, never a raw `material_id`.

## Automation (G3 / "F2") demonstrations

- **Real decision log**: every quarantine-intake, incoming-QC-outcome, packaging-release, and
  material-shortage decision this script's business flow naturally triggers lands a real
  `automation.decision_log` row.
- **Real vendor credit note from a FAIL**: `IncomingQcOutcomeService`'s own FAIL path drafts a
  `procurement.vendor_credit_note` (status DRAFT) — never fabricated by this script directly.
- **One real retry, one real dead-letter**: both start from the exact same real, deterministic
  failure — a production order with a genuine shortage against a material whose one
  pre-existing `inventory.stock_reservation` is absurdly oversized (a fixture representing a
  legacy/bad row `StockService.createStockReservation` itself would correctly refuse to create
  today), which pushes `MaterialShortageService.evaluate()`'s shortfall calculation past
  `numeric(18,4)`'s range — a real Postgres overflow, caught by the real
  `backend/api/src/automation/ledger.ts`. For the retry case, a real
  `StockService.releaseStockReservation` call clears the bad reservation after the first real
  failure, and the next real attempt succeeds. For the dead-letter case, the same real failure
  is left unfixed for 5 real attempts, ending in a real `automation.dead_letter` row.
- **Alerts**: `AutomationAlertsService.scan()` is run for real after this script narrowly
  backdates a couple of rows (the *one* deliberate direct-timestamp touch in this script — see
  its own comment) past the QC-HOLD-age / PR-overdue / PO-overdue thresholds.

## Known environment gaps (reported, not fixed here — no schema migrations)

- The `location` Postgres schema (warehouse/zone/rack/bin) needs the `postgis` extension via
  `pnpm db:push`, and is intentionally absent from `backend/test-support/schema.sql` (this
  repo's lightweight test harness) to avoid that dependency on every dev/CI box. This script
  best-effort's the real `SitesService`/`WarehouseService`/`StorageService` calls when the
  schema exists, and falls back to clearly-logged synthetic storage-location ids when it
  doesn't (`storage_location_id` is a soft ref everywhere it's used — no FK, so this never
  blocks anything downstream).
- `backend/test-support/schema.sql` was missing a number of tables/columns the real Drizzle
  schemas define but no existing test happened to exercise (`platform.uom_master`,
  `masterdata.material_type_master` + several `masterdata.material` columns,
  `masterdata.outbox`, `packaging.product_category_master` + `packaging_material_master`,
  `inventory.gate_entry_master` + `stock_transfer`, `quality.qc_result_details`,
  `bridge.inbound_event` + `bridge.production_requirement.status`, and `iam.org_master`'s
  6 org-group/type/locale soft-ref columns). This lane added them — additive/nullable only,
  verified against the full pre-existing test suite on a fresh database (2580/2580 passing
  before and after).
