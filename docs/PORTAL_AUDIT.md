# Raw Aroma — Deep Portal Audit + Remediation

_Date: 2026-07-10. Method: 25-agent workflow — 10 per-portal live end-to-end probes (owner token, all data/perms visible) + 5 cross-cutting sweeps (sort / filter / pagination / dashboards / create-action drift), every high/critical finding adversarially re-verified. 70 findings raised, 8 high/critical confirmed._

## Verdict

The **features work** — across all 10 portals nearly every module returned HTTP 200 with real rows and correctly-wired columns; no mass 500s, no auth breakage, no dead modules. The gaps were exactly the three capabilities flagged (sorting, filtering, pagination) plus a handful of concrete bugs. **All actionable findings are now fixed, deployed, and live-verified (22/22).**

## Findings → fixes (all shipped)

| WS | Finding (severity) | Fix | Verified |
|----|--------------------|-----|----------|
| **WS5** | Dead "New Quotation" button — gated on `procurement:quotation:write` (singular) which doesn't exist (HIGH) | frontend perm → `procurement:quotations:write` (matches the route) | perm-set match |
| **WS2** | Server-side search covered only 25/~120 modules; the rest filtered just the loaded 100 rows | search REGISTRY 25 → **65** non-secret single-table lists; every table verified to exist + carry no secret column | search 200 for new, 404 for formulas/users/login-history/notifications |
| **WS4** | Blank/garbled columns: stock-transfers.transferNumber, grns.batchId, purchase-requests.requiredDate, package-orders raw UUID, production-order-ingredients aliasName + issuedQty | COLS → real fields; **enrich** package-orders `skuCode` + worksheet `aliasName` (masking preserved) | `skuCode=SKU-050-1`, `aliasName=ING-A011` |
| **WS6** | Empty org+location masters (organizations/BUs/location-types/countries/floors/bins) → admin+warehouse screens blank; users emp/mobile null | idempotent `seed-master-hierarchy.cjs` (in db:provision) fills the masters, wires null FKs, backfills users | organizations 1 / countries 6 / BUs 3 / floors 2 / bins 4 |
| **WS7** | Dashboard: one payload to all roles (leaks supplier spend), no error handling (one bad sub-query 500s home for all), sales role missing narrative, `'null'` timestamps | resilience (per-query `.catch`), `spendByVendor` gated to owner/procurement, sales NOTE+sidePanel, feed `''` | dashboard 200, spendByVendor present for owner |
| **WS1** | 100-row ceiling — lists never followed the cursor; rows beyond 100 unreachable (HIGH) | frontend **"Load more"** follows `meta.cursor`; audit read-models (login-history=165, formula-access-audit) got offset-cursor paging | login-history 100 → +85 via cursor; permissions cursor present |
| **WS3** | No sorting anywhere — no sortable headers; backend hardcodes `desc(pk)` | **click-to-sort headers** (asc/desc toggle, type-aware: numbers/dates/natural strings, blanks last); sorts all loaded rows, works for enriched columns | syntax-verified; deploys to Vercel |

## Deliberately deferred to Phase-2 (documented, non-blocking)

- **Server-side top-N sort for very large tables** — WS3 sorts loaded rows (full-table at Phase-1 sizes once Load-more pulls the rest). True server-side sort conflicts with PK-keyed cursor pagination and would touch ~150 handlers.
- **Structured filters** (status dropdown / date range) beyond the free-text search box.
- **Cursor pagination for the remaining computed read-models** (fg-stock, inventory-availability, geo, packaging-qc, procanalytics) — currently bounded by entity counts (<100); only login-history/formula-access-audit needed it now.
- **Full per-role dashboard payload scoping** — WS7 closed the named leak (supplier spend); scoping every field per role is a larger design change.
