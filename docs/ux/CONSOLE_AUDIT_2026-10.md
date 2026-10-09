# Console audit, October 2026: Factory, Platform, Vault

**Owner goal (Almas, 2026-10-09):** "audit all consoles and its url path fixes so that it becomes easy to use and all features are easily understandable and no training would be required".

**Scope:**

- **Factory** (`web/`, rawfactory.huecycle.in). Workspaces: owner, admin, production, qc, warehouse, packaging, procurement, sales, compounding, filling, receiving.
- **Platform** (`web-platform/`, rawplatform.huecycle.in). Role: platform_super_admin. The owner also gets access through `platformops:console:read`.
- **Vault** (`web-vault/`, rawvault.huecycle.in). Roles: formulator and vault_approver.

**Out of scope:** Ruh voice/text actions and tutorial videos. Parallel ALEMBIC lanes own them.

**Baseline:** RawProd `17e39e6` (production `rc-rawprod-2026-10-06.1`), lane `lane/ux-audit-rp`.

## How the audit was done

1. **Code read.** Every console script was read: `shell.js`, the `ws-*.js` modules, `tutorial.js`, `platform.js` and `vault.js`. The review covered:
   - navigation and addresses
   - wording and codes on screen
   - empty states and dead ends
   - buttons, feedback and errors
   - phone layout and accessibility
2. **Headless drive.** Every workspace was driven against a local stack:
   - Main API and Vault API on their own databases, with demo seed and role catalogue.
   - Sign-in uses ALEMBIC-style assertions signed by a local key.
   - Chromium at 1440 px and 390 px, plus a WebKit pass at 390 px.
   - Screenshots are in `docs/ui/evidence/ux-audit/`. The drive results are under "Verification" below.

Severity: **H** stops someone or loses their place; **M** slows them down or confuses them; **L** is polish.

## Headline

Five problems mattered most:

1. **The Factory had no addresses.** Every screen lived at the bare site address.
   - Reload, Back, a bookmark or a link always landed on the dashboard.
   - The only deep link (`#/go/<key>[/<uuid>]`) was erased from the address bar as soon as it was followed.
   - Platform used readable hashes (`#/health`), but some did not match their labels (`#/support` opened "Login history"; `#/deploy` opened "Build").
   - Vault used `#/formula/<uuid>`, gave no way back, and showed "Formulas" as the title on every record.
2. **Jargon and codes were everywhere.**
   - The same data had different names in different workspaces: "Master runs" and "Production orders"; "Bulk lots" and "Oil batches"; "Pack orders" and "Package orders".
   - Status chips showed raw database codes: `INPROGRESS`, `PENDING_APPROVAL`, `MATERIALS_ISSUED`.
   - Column headings came from field names: "Fefo Flag", "Rera No", "Sg Min".
3. **Screens did not say what they were for.** About 25 Factory lists showed a bare "No records yet" with no next step.
4. **Browser `prompt()`/`confirm()` were used for real decisions.** Examples: weighing (three prompts in a row), amending or cancelling a PO, confirming a sales order, locking and approving a Vault version. Several actions that change a batch's fate took one tap with no confirmation: QC Accept/Reject/Hold, oil Release/Fail, Mark delivered.
5. **Errors were dead ends and showed status codes.** Examples: "Action failed (409)", "Request failed (403)", "Not available right now (403)". None offered a way on.

All five are fixed. The detailed list follows.

## The new address scheme

### Factory: `#/<workspace>/<screen>[/<record>]`

```
#/production/production-orders                   a screen
#/procurement/purchase-orders/DEMO-PO-0038       one record, by its own code
#/owner/home                                     a workspace's home
```

**Parts of the address**

- **Workspace:** one word per role. `owner` is the `superadmin` role; the others match the role name.
- **Screen:** a stable slug per data source, never the label. A label can be reworded without breaking a link. The table lives in `web/routes.js`.
- **Record:** the row's own code, if it has one. It falls back to the row's id only when there is no code (production orders have only an id). The code fields are tried in order: batch, PO, PR, GRN, SO, RFQ, quotation, gate entry, document, ALEMBIC order, SKU, material, product, supplier, customer, bin, and so on.

**Behaviour**

- Moving between screens adds a history entry, so Back and Forward work.
- Opening a record's details replaces the address. Closing them returns to the list's address.
- Reload restores the session from the cookie, then opens the same screen and the same record, with its details open.
- Nothing about the stack or the database is in the address. Hashes are never sent to the server, so nothing changes in nginx.

**Older links keep working and are rewritten in place** (no reload, no extra history entry):

| Older address | Opens | Notes |
|---|---|---|
| `#/go/<key>[\|<key>…][/<id>]` | The first listed screen this person's workspaces have, then the record is found and marked | Ruh notes and ALEMBIC links. Stored in the database, so this format is supported for good. |
| `#/<key>` | That screen | |
| `#/<workspace>/<key>` | That screen | The section key is accepted as well as the slug. |
| `#/superadmin/…` | `#/owner/…` | A role key typed by hand. |
| `#/<a workspace you don't hold>/<screen>` | The same screen in one of your workspaces that has it | So a colleague's link still lands. |
| `#assertion=…` | Not a route | Consumed by sign-in, as before. |
| `#shelf=ZONE` | Not a route | Shelf TV hand-off, as before. |

- A screen none of your workspaces has keeps you where you are, with "That screen is not part of your workspace."
- An address opened while signed out is remembered for 15 minutes in Factory and Platform (address only). It opens after the ALEMBIC sign-in, which comes back in a new tab.

### Platform: `#/<screen>`

| Before | Now | Label (before → now) |
|---|---|---|
| `#/health` | `#/health` | Health |
| `#/flags` | `#/feature-switches` | Feature flags → **Feature switches** |
| `#/tenants` | `#/organizations` | Tenants → **Organizations** |
| `#/providers` | `#/connectors` | Providers → **Connectors** |
| `#/bridge` | `#/alembic-bridge` | ALEMBIC bridge → **ALEMBIC link** |
| `#/picklight` | `#/pick-to-light` | Pick-to-light |
| `#/deploy` | `#/version` | Build → **Version** |
| `#/support` | `#/sign-in-history` | Login history → **Sign-in history** |
| `#/tutorial` | `#/tutorials` | Tutorials |
| anything else | `#/health` | Rewritten, so the address bar and the screen agree. |

- Older addresses, including the ones Ruh notes carry (`#/bridge`, `#/picklight`), resolve and are rewritten.
- The internal section ids are unchanged, so tutorial targets and tests still work.

### Vault: unchanged words, now with a trail

| Address | Screen | Change |
|---|---|---|
| `#/formulas` | Formulas | Help line |
| `#/formula/<id>` | One formula | Title is the formula code. Trail: **Formulas › CODE**. Rows open from the keyboard. |
| `#/version/<id>` | One version | Title: "Version N of <name>". Trail: **Formulas › CODE › Version N**, with a link back. The raw id is no longer printed. |
| `#/audit-access`, `#/audit-mfg`, `#/compliance`, `#/certificates`, `#/missing`, `#/needed`, `#/recipes`, `#/review` | As before | Help lines. A screen your role lacks says so and who to ask, instead of a raw server refusal. Unknown addresses settle on `#/formulas`. |

**Deliberate exception.** Vault record addresses keep the opaque id, not the formula code. The Vault's own rule is "ids only in the hash, never formula content". A code in the address would put formula names into browser history.

For the same reason the Vault still writes no browser storage, which a test enforces. So after a reload (which ends a Vault session by design) the Vault opens on Formulas, not the previous screen. Carrying the screen through sign-in needs ALEMBIC to pass a return address (see Deferred).

### Factory URL map (every screen, every workspace)

Before this lane, no Factory screen had an address. The "Older link" column is the deep-link form Ruh and ALEMBIC used; it still works and is rewritten.

### Owner — `#/owner/…` (39 screens, dock: 8)

| Screen (before → now) | Older link (still works) | Address now | Group |
|---|---|---|---|
| Dashboard | `#/go/dashboard` | `#/owner/home` | Start here |
| Factory setup | `#/go/factorysetup` | `#/owner/factory-setup` | Start here |
| Produce next | `#/go/produce` | `#/owner/produce-next` | Start here |
| Put-away & pick | `#/go/shelftasks` | `#/owner/put-away-and-pick` | Start here |
| Rack layout | `#/go/racklayout` | `#/owner/rack-layout` | Stock and storage |
| Shelf display | `#/go/shelfdisplay` | `#/owner/shelf-display` | Stock and storage |
| Production plans | `#/go/plans` | `#/owner/production-plans` | Production |
| Plan items → **Plan lines** | `#/go/planitems` | `#/owner/plan-lines` | Production |
| Master runs → **Production orders** | `#/go/runs` | `#/owner/production-orders` | Production |
| Materials | `#/go/materials` | `#/owner/materials` | Setup |
| Units | `#/go/uom` | `#/owner/units` | Setup |
| Material types | `#/go/mtypes` | `#/owner/material-types` | Setup |
| Categories → **Material categories** | `#/go/mcats` | `#/owner/material-categories` | Setup |
| Sub-categories → **Material sub-categories** | `#/go/msubcats` | `#/owner/material-subcategories` | Setup |
| Material groups | `#/go/mgroups` | `#/owner/material-groups` | Setup |
| Material QC specs → **Material test specs** | `#/go/mqcspec` | `#/owner/material-test-specs` | Quality |
| Storage rules | `#/go/mstorage` | `#/owner/storage-rules` | Setup |
| RM aliases → **Material code names** | `#/go/maliases` | `#/owner/material-code-names` | Setup |
| Split containers → **Batch containers** | `#/go/splitc` | `#/owner/batch-containers` | Receiving |
| Geo levels → **Region levels** | `#/go/geotypes` | `#/owner/region-levels` | Setup |
| Geo regions → **Regions** | `#/go/georegions` | `#/owner/regions` | Setup |
| Sales orders | `#/go/sorders` | `#/owner/sales-orders` | Packing and sales |
| Dispatches | `#/go/dispatch` | `#/owner/dispatches` | Packing and sales |
| Dispatch docs → **Dispatch documents** | `#/go/ddocs` | `#/owner/dispatch-documents` | Packing and sales |
| FG stock (ATP) → **Finished stock** | `#/go/fgstock` | `#/owner/finished-stock` | Packing and sales |
| Traceability → **Trace a batch** | `#/go/trace` | `#/owner/finished-batches` | Packing and sales |
| Notifications → **Notifications sent** | `#/go/notifs` | `#/owner/notifications` | Records |
| Documents | `#/go/docs` | `#/owner/documents` | Records |
| Users | `#/go/users` | `#/owner/users` | Setup |
| Audit log → **Formula history** | `#/go/audit` | `#/owner/formula-history` | Records |
| Write audit trail → **Change history** | `#/go/wtrail` | `#/owner/change-history` | Records |
| ALEMBIC requirements → **Orders from ALEMBIC** | `#/go/bridgereq` | `#/owner/alembic-orders` | Start here |
| Weighing | `#/go/weigh` | `#/owner/weighing` | Production |
| FG labels → **Product labels** | `#/go/labels` | `#/owner/product-labels` | Packing and sales |
| Approval matrix → **Approval rules** | `#/go/approvals` | `#/owner/approval-rules` | Setup |
| Batch COA → **Batch certificates** | `#/go/coa` | `#/owner/batch-certificates` | Quality |
| QC specs (COA) → **Product test specs** | `#/go/coaspec` | `#/owner/product-test-specs` | Quality |
| Tutorials | `#/go/tutorial` | `#/owner/tutorials` | Help |
| Formula setup | `#/go/formulasetup` | `#/owner/formula-setup` | Setup |

### Admin — `#/admin/…` (18 screens, dock: 8)

| Screen (before → now) | Older link (still works) | Address now | Group |
|---|---|---|---|
| Dashboard | `#/go/dashboard` | `#/admin/home` | Start here |
| Users | `#/go/users` | `#/admin/users` | Setup |
| Roles | `#/go/roles` | `#/admin/roles` | Setup |
| Permissions | `#/go/perms` | `#/admin/permissions` | Setup |
| Approval matrix → **Approval rules** | `#/go/approvals` | `#/admin/approval-rules` | Setup |
| Organizations | `#/go/orgs` | `#/admin/organizations` | Setup |
| Business units | `#/go/bunits` | `#/admin/business-units` | Setup |
| Location types | `#/go/loctypes` | `#/admin/location-types` | Setup |
| Locations | `#/go/locations` | `#/admin/locations` | Setup |
| Materials | `#/go/materials` | `#/admin/materials` | Setup |
| Units | `#/go/units` | `#/admin/units` | Setup |
| Contacts | `#/go/contacts` | `#/admin/contacts` | Setup |
| Countries | `#/go/countries` | `#/admin/countries` | Setup |
| Documents | `#/go/docs` | `#/admin/documents` | Records |
| Login history → **Sign-in history** | `#/go/loginhist` | `#/admin/sign-in-history` | Records |
| Write audit trail → **Change history** | `#/go/wtrail` | `#/admin/change-history` | Records |
| Tutorials | `#/go/tutorial` | `#/admin/tutorials` | Help |
| Formula setup | `#/go/formulasetup` | `#/admin/formula-setup` | Setup |

### Procurement — `#/procurement/…` (20 screens, dock: 8)

| Screen (before → now) | Older link (still works) | Address now | Group |
|---|---|---|---|
| Dashboard | `#/go/dashboard` | `#/procurement/home` | Start here |
| Stock planning | `#/go/planning` | `#/procurement/stock-planning` | Buying |
| Reorder plan | `#/go/reorder` | `#/procurement/reorder-plan` | Buying |
| Purchase requests | `#/go/prs` | `#/procurement/purchase-requests` | Buying |
| RFQs → **Quote requests** | `#/go/rfq` | `#/procurement/quote-requests` | Buying |
| Quotations → **Supplier quotes** | `#/go/quotes` | `#/procurement/supplier-quotes` | Buying |
| Quotation items → **Quote lines** | `#/go/qitems` | `#/procurement/quote-lines` | Buying |
| Negotiation → **Price negotiation** | `#/go/negotiate` | `#/procurement/negotiations` | Buying |
| Purchase orders | `#/go/pos` | `#/procurement/purchase-orders` | Buying |
| Advance payments | `#/go/advpay` | `#/procurement/advance-payments` | Buying |
| Suppliers | `#/go/vendors` | `#/procurement/suppliers` | Buying |
| Vendor contacts → **Supplier contacts** | `#/go/vcontacts` | `#/procurement/supplier-contacts` | Buying |
| Vendor materials → **Supplier materials** | `#/go/vmap` | `#/procurement/supplier-materials` | Buying |
| Rate history → **Supplier price history** | `#/go/ratehist` | `#/procurement/supplier-rates` | Buying |
| Vendor performance → **Supplier performance** | `#/go/vperf` | `#/procurement/supplier-performance` | Buying |
| Settlements → **Supplier credit notes** | `#/go/settle` | `#/procurement/supplier-credit-notes` | Buying |
| Rejected GRNs → **Rejected deliveries** | `#/go/rejgrns` | `#/procurement/rejected-receipts` | Buying |
| Vendor ledger → **Supplier ledger** | `#/go/vledger` | `#/procurement/supplier-ledger` | Buying |
| Materials | `#/go/materials` | `#/procurement/materials` | Setup |
| Tutorials | `#/go/tutorial` | `#/procurement/tutorials` | Help |

### Receiving — `#/receiving/…` (8 screens, dock: 7)

| Screen (before → now) | Older link (still works) | Address now | Group |
|---|---|---|---|
| Dashboard | `#/go/dashboard` | `#/receiving/home` | Start here |
| Vendor dispatch → **Supplier shipments** | `#/go/vdispatch` | `#/receiving/supplier-shipments` | Receiving |
| Gate entries | `#/go/gate` | `#/receiving/gate-entries` | Receiving |
| Goods receipt → **Goods receipts** | `#/go/grns` | `#/receiving/goods-receipts` | Receiving |
| Qty verification → **Received quantities** | `#/go/grnitems` | `#/receiving/received-quantities` | Receiving |
| Batches → **Raw material batches** | `#/go/batches` | `#/receiving/raw-material-batches` | Receiving |
| Containers | `#/go/containers` | `#/receiving/containers` | Receiving |
| Tutorials | `#/go/tutorial` | `#/receiving/tutorials` | Help |

### QC Laboratory — `#/qc/…` (10 screens, dock: 7)

| Screen (before → now) | Older link (still works) | Address now | Group |
|---|---|---|---|
| Dashboard | `#/go/dashboard` | `#/qc/home` | Start here |
| Factory setup | `#/go/factorysetup` | `#/qc/factory-setup` | Start here |
| Test queue | `#/go/queue` | `#/qc/test-queue` | Quality |
| Results → **Test results** | `#/go/results` | `#/qc/test-results` | Quality |
| Production QC | `#/go/prodqc` | `#/qc/production-qc` | Quality |
| Sample retention → **Retained samples** | `#/go/samples` | `#/qc/retained-samples` | Quality |
| QC parameters → **Test parameters** | `#/go/qcparams` | `#/qc/qc-parameters` | Quality |
| QC specs (COA) → **Product test specs** | `#/go/coaspec` | `#/qc/product-test-specs` | Quality |
| Batch COA → **Batch certificates** | `#/go/coa` | `#/qc/batch-certificates` | Quality |
| Tutorials | `#/go/tutorial` | `#/qc/tutorials` | Help |

### Production — `#/production/…` (22 screens, dock: 8)

| Screen (before → now) | Older link (still works) | Address now | Group |
|---|---|---|---|
| Dashboard | `#/go/dashboard` | `#/production/home` | Start here |
| Factory setup | `#/go/factorysetup` | `#/production/factory-setup` | Start here |
| Produce next | `#/go/produce` | `#/production/produce-next` | Start here |
| Put-away & pick | `#/go/shelftasks` | `#/production/put-away-and-pick` | Start here |
| Shelf display | `#/go/shelfdisplay` | `#/production/shelf-display` | Stock and storage |
| ALEMBIC requirements → **Orders from ALEMBIC** | `#/go/bridgereq` | `#/production/alembic-orders` | Start here |
| Production plans | `#/go/plans` | `#/production/production-plans` | Production |
| Plan items → **Plan lines** | `#/go/planitems` | `#/production/plan-lines` | Production |
| Production orders | `#/go/runs` | `#/production/production-orders` | Production |
| Order ingredients | `#/go/orderitems` | `#/production/order-ingredients` | Production |
| Pick lists | `#/go/picks` | `#/production/pick-lists` | Production |
| Pick list items → **Pick list lines** | `#/go/pickitems` | `#/production/pick-list-lines` | Production |
| Material issues | `#/go/issues` | `#/production/material-issues` | Production |
| Mixing sessions | `#/go/mixing` | `#/production/mixing-sessions` | Production |
| Weighing | `#/go/weigh` | `#/production/weighing` | Production |
| Oil batches | `#/go/oil` | `#/production/oil-batches` | Production |
| Production QC | `#/go/prodqc` | `#/production/production-qc` | Quality |
| CAPA → **Corrective actions** | `#/go/capas` | `#/production/corrective-actions` | Quality |
| Batch COA → **Batch certificates** | `#/go/coa` | `#/production/batch-certificates` | Quality |
| QC specs (COA) → **Product test specs** | `#/go/coaspec` | `#/production/product-test-specs` | Quality |
| Tutorials | `#/go/tutorial` | `#/production/tutorials` | Help |
| Formula setup | `#/go/formulasetup` | `#/production/formula-setup` | Setup |

### Warehouse — `#/warehouse/…` (19 screens, dock: 8)

| Screen (before → now) | Older link (still works) | Address now | Group |
|---|---|---|---|
| Floor map | `#/go/dashboard` | `#/warehouse/home` | Start here |
| Factory setup | `#/go/factorysetup` | `#/warehouse/factory-setup` | Start here |
| Put-away & pick | `#/go/shelftasks` | `#/warehouse/put-away-and-pick` | Start here |
| Rack layout | `#/go/racklayout` | `#/warehouse/rack-layout` | Stock and storage |
| Shelf display | `#/go/shelfdisplay` | `#/warehouse/shelf-display` | Stock and storage |
| Stock (FEFO) → **Stock on hand** | `#/go/stock` | `#/warehouse/stock` | Stock and storage |
| RM batches → **Raw material batches** | `#/go/rm` | `#/warehouse/raw-material-batches` | Receiving |
| Movements → **Stock movements** | `#/go/movements` | `#/warehouse/stock-movements` | Stock and storage |
| Adjustments → **Stock adjustments** | `#/go/adjust` | `#/warehouse/stock-adjustments` | Stock and storage |
| Reservations → **Stock reservations** | `#/go/reserve` | `#/warehouse/stock-reservations` | Stock and storage |
| Stock counts | `#/go/counts` | `#/warehouse/stock-counts` | Stock and storage |
| Transfers → **Stock transfers** | `#/go/transfers` | `#/warehouse/stock-transfers` | Stock and storage |
| Warehouses | `#/go/warehouses` | `#/warehouse/warehouses` | Stock and storage |
| Floors | `#/go/floors` | `#/warehouse/floors` | Stock and storage |
| Zones | `#/go/zones` | `#/warehouse/zones` | Stock and storage |
| Racks | `#/go/racks` | `#/warehouse/racks` | Stock and storage |
| Shelves | `#/go/shelves` | `#/warehouse/shelves` | Stock and storage |
| Bins | `#/go/bins` | `#/warehouse/bins` | Stock and storage |
| Tutorials | `#/go/tutorial` | `#/warehouse/tutorials` | Help |

### Compounding — `#/compounding/…` (10 screens, dock: 8)

| Screen (before → now) | Older link (still works) | Address now | Group |
|---|---|---|---|
| Dashboard | `#/go/dashboard` | `#/compounding/home` | Start here |
| Produce next | `#/go/produce` | `#/compounding/produce-next` | Start here |
| Worksheets | `#/go/work` | `#/compounding/order-ingredients` | Production |
| Production orders | `#/go/orders` | `#/compounding/production-orders` | Production |
| Pick lists | `#/go/picks` | `#/compounding/pick-lists` | Production |
| Material issues | `#/go/issues` | `#/compounding/material-issues` | Production |
| Mixing sessions | `#/go/mixing` | `#/compounding/mixing-sessions` | Production |
| Weighing | `#/go/weigh` | `#/compounding/weighing` | Production |
| Oil batches | `#/go/oil` | `#/compounding/oil-batches` | Production |
| Tutorials | `#/go/tutorial` | `#/compounding/tutorials` | Help |

### Filling — `#/filling/…` (6 screens, dock: 5)

| Screen (before → now) | Older link (still works) | Address now | Group |
|---|---|---|---|
| Dashboard | `#/go/dashboard` | `#/filling/home` | Start here |
| Shelf display | `#/go/shelfdisplay` | `#/filling/shelf-display` | Stock and storage |
| Fill tickets | `#/go/tickets` | `#/filling/fill-tickets` | Packing and sales |
| Package orders → **Packing orders** | `#/go/orders` | `#/filling/packing-orders` | Packing and sales |
| Bulk lots → **Oil batches** | `#/go/oil` | `#/filling/oil-batches` | Production |
| Tutorials | `#/go/tutorial` | `#/filling/tutorials` | Help |

### Packaging — `#/packaging/…` (14 screens, dock: 8)

| Screen (before → now) | Older link (still works) | Address now | Group |
|---|---|---|---|
| Dashboard | `#/go/dashboard` | `#/packaging/home` | Start here |
| Put-away & pick | `#/go/shelftasks` | `#/packaging/put-away-and-pick` | Start here |
| Shelf display | `#/go/shelfdisplay` | `#/packaging/shelf-display` | Stock and storage |
| Pack orders → **Packing orders** | `#/go/orders` | `#/packaging/packing-orders` | Packing and sales |
| Finished goods → **Finished batches** | `#/go/fg` | `#/packaging/finished-batches` | Packing and sales |
| FG stock (ATP) → **Finished stock** | `#/go/fgstock` | `#/packaging/finished-stock` | Packing and sales |
| FG reservations → **Reserved finished stock** | `#/go/fgreserve` | `#/packaging/reserved-finished-stock` | Packing and sales |
| FG labels → **Product labels** | `#/go/labels` | `#/packaging/product-labels` | Packing and sales |
| Packaging QC | `#/go/pkgqc` | `#/packaging/packaging-qc` | Quality |
| Products | `#/go/products` | `#/packaging/products` | Packing and sales |
| Product SKUs → **Pack sizes** | `#/go/skus` | `#/packaging/pack-sizes` | Packing and sales |
| Packaging BOM → **Packaging materials** | `#/go/pkgbom` | `#/packaging/packaging-materials` | Packing and sales |
| Tutorials | `#/go/tutorial` | `#/packaging/tutorials` | Help |
| Formula setup | `#/go/formulasetup` | `#/packaging/formula-setup` | Setup |

### Sales & Dispatch — `#/sales/…` (11 screens, dock: 8)

| Screen (before → now) | Older link (still works) | Address now | Group |
|---|---|---|---|
| Dashboard | `#/go/dashboard` | `#/sales/home` | Start here |
| Put-away & pick | `#/go/shelftasks` | `#/sales/put-away-and-pick` | Start here |
| Shelf display | `#/go/shelfdisplay` | `#/sales/shelf-display` | Stock and storage |
| Sales orders | `#/go/orders` | `#/sales/sales-orders` | Packing and sales |
| Customers | `#/go/customers` | `#/sales/customers` | Packing and sales |
| FG stock (ATP) → **Finished stock** | `#/go/fgstock` | `#/sales/finished-stock` | Packing and sales |
| FG reservations → **Reserved finished stock** | `#/go/fgreserve` | `#/sales/reserved-finished-stock` | Packing and sales |
| Transporters | `#/go/transporters` | `#/sales/transporters` | Packing and sales |
| Dispatches | `#/go/dispatch` | `#/sales/dispatches` | Packing and sales |
| Dispatch docs → **Dispatch documents** | `#/go/ddocs` | `#/sales/dispatch-documents` | Packing and sales |
| Tutorials | `#/go/tutorial` | `#/sales/tutorials` | Help |

## Findings and what was done

Status **Fixed** means it ships in this lane's commits. **Deferred** gives the reason.

### Navigation and addresses

| # | Console | Sev | Finding | Status |
|---|---|---|---|---|
| N1 | Factory | H | No addresses: reload, Back, bookmarks and links all go to the dashboard. `navTo` never touched the URL. | **Fixed:** `web/routes.js` plus the shell router. |
| N2 | Factory | H | `#/go/…` deep links were erased on arrival and could not be copied, bookmarked or reloaded. | **Fixed:** rewritten to the readable address and kept. |
| N3 | Factory | M | Owner rail had 39 items in one list. Admin had 18, production 22, warehouse 19. | **Fixed:** workspaces over 9 screens show named groups (Start here, Production, Quality, Buying, Receiving, Stock and storage, Packing and sales, Setup, Records, Help). The dock is unchanged (≤ 8 per role). |
| N4 | Factory | M | The same data had different names across workspaces. | **Fixed:** one name per data source (`screen-guide.js` LABEL), enforced by test. Compounding keeps "Worksheets" and the owner keeps "Trace a batch" on purpose. |
| N5 | Factory | M | The workspace switcher said "Super Admin" for the owner. | **Fixed:** "Owner", department "Whole factory". |
| N6 | Factory | L | The alert bell set state directly, so no history entry was made. | **Fixed:** goes through `navTo`. |
| N7 | Platform | M | Tenants, Providers and Build showed for roles that then hit a "doesn't include this" card. | **Fixed:** gated in the nav like their screens. |
| N8 | Platform | M | Route words did not match labels (`#/support`, `#/deploy`). An unknown hash showed Health but kept the bad address. | **Fixed** (table above). |
| N9 | Vault | H | Record pages had no title, no trail and no way back. The version page printed its raw id. | **Fixed.** |
| N10 | Vault | M | Ruh notes pointing at a formula or version were refused. | **Fixed:** record links open. |
| N11 | Vault | M | With every screen visible, "Approve recipes" dropped out of the dock. On phones, only audits and formulas got tabs. | **Fixed:** dock order is formulas, needed, recipes, review, then compliance, then audits. |
| N12 | Vault | M | Reload ends the session (by design) and sign-in lands on Formulas. | **Deferred:** needs an ALEMBIC "return to" parameter; the Vault may not use browser storage. |

### Words, codes and "what is this screen"

| # | Console | Sev | Finding | Status |
|---|---|---|---|---|
| W1 | Factory | H | No screen said what it was for. | **Fixed:** a trail (workspace › screen › record, each a link) and a one-line purpose on every screen. Every nav entry has a help line, enforced by test. |
| W2 | Factory | H | Raw status codes in chips and in the status counts above lists. | **Fixed:** words (In progress, Waiting for approval, Maturing …). The code stays in the data for search and sort. |
| W3 | Factory | M | Column headings came from field names ("Fefo Flag", "Rera No", "Sg Min", "Po Count", "Mapped Sku"). | **Fixed:** about 120 plain headings. |
| W4 | Factory | M | Money printed as `130200.0000`. | **Fixed:** grouped, at most two decimals. |
| W5 | Factory | M | Record details listed internal ids ("Created by 01A12008"). | **Fixed:** ids and audit fields are hidden. |
| W6 | Factory | M | Jargon labels: RM aliases, Split containers, Geo levels, FG stock (ATP), Qty verification, Write audit trail, ALEMBIC requirements, Batch COA, QC specs (COA), Stock (FEFO), RFQs, Settlements, Rejected GRNs, CAPA, Packaging BOM. | **Fixed:** plain names (URL map above). No banned label remains, enforced by test. |
| W7 | Factory | L | Developer-flavoured lines on screen: "Aliases only", "Master runs" card, "ranked by ALEMBIC …", "The Vault did not answer …", "(manual continuity)", "outside the ALEMBIC bridge (required, audited)", "this build". | **Fixed:** plain wording. |
| W8 | Platform | M | Raw dependency keys and `up/down`/`ok` on Health; "Outbox / Schema / Backlog". Raw `on/degraded/off`, `staging/prod`, `yes/no`, `Git SHA`. Bridge "Inbound parked" etc. Raw event and reason codes. An "Internal" chip with no meaning. | **Fixed:** plain words throughout. The controller protocol moved into a "For the person installing a hardware controller" fold. |
| W9 | Vault | M | Status chips showed raw enums. | **Fixed:** Draft, Finalized, In review, Approved, Locked, Replaced by newer, Rejected. |
| W10 | Vault | L | Finalize and Submit for review sat side by side with no explanation. | **Fixed:** a line under the actions plus button titles. |
| W11 | Vault | L | CSV column specs and "Ruh (automation)" wording in the recipe help. | **Deferred:** formulators need the exact CSV columns. Rewording needs the Vault-setup owner's sign-off. |

### Empty states, dead ends, feedback, errors

| # | Console | Sev | Finding | Status |
|---|---|---|---|---|
| E1 | Factory | H | "No records yet" with no next step on about 25 lists. | **Fixed:** "Nothing in <screen> yet", then either "Use + New <thing> to add the first one" with the button, or where the rows come from (`COMES_FROM`, e.g. "Batches arrive here when Receiving books goods in"). |
| E2 | Factory | M | "+ New" did not say what it made. | **Fixed:** "+ New purchase order", "+ New gate entry", and so on. |
| E3 | Factory | H | Error cards were dead ends; 403 said only "Your role doesn't have access". | **Fixed:** every card has "Go to your home screen" (and "Try again" for failures). No-access says to ask the admin. |
| E4 | All | M | Status codes in messages: "(409)", "Request failed (403)", "Not available right now (403)". 43 places in Factory. | **Fixed:** the server's own sentence, else a plain one. A test blocks the pattern. |
| E5 | Factory | H | `window.prompt`/`confirm` for weighing (three prompts), PO amend/cancel, replacement PO, confirming a sales order by hand, and dispatch. | **Fixed:** in-page sheets with labelled fields, a line saying what happens, and inline validation. Dispatch asks once inside its own sheet. |
| E6 | Factory | H | One-tap fate changes: QC Accept/Reject/Hold/Rework, oil Release/Hold/Rework/Fail, Approve, Mark delivered, End session, End fill. | **Fixed:** a confirm sheet naming the record and the consequence. Routine steps (Submit, Issue) still go straight. |
| E7 | Factory | M | Success said "Done"; toasts vanished after 1.9 s and were silent to screen readers. | **Fixed:** past-tense results ("Sent to the supplier", "Put on hold"). 3.4 s for success, 6 s for problems. `role=status`/`alert` in all three consoles. |
| E8 | Factory | M | Row buttons had no explanation ("Release" means four different things). | **Fixed:** every row button carries a one-line "what this does" title, enforced by test. |
| E9 | Vault | H | `window.confirm` for Lock; `window.prompt` for approve/reject remarks and for bulk approval. | **Fixed:** in-page sheets. Reject requires a reason. |
| E10 | Platform, Vault | M | Raw server text or "Request failed (n)" as the fallback. | **Fixed:** a plain fallback. Server sentences are kept. |
| E11 | Factory | M | Sign-in card said "Sign-in isn't set up for this build." | **Fixed** in all three consoles: "Sign-in is not switched on here yet. Ask your administrator." |
| E12 | Factory | L | Toasts like "Not a task", "No sheet" and "Import failed" in `ws-produce.js`. | **Deferred:** owned by the produce/shelf lane, and each needs its specific cause. |
| E13 | Factory | M | Material issues, CAPA and Product SKUs have no create form. The sales role cannot create a sales order (by design: orders come from ALEMBIC). | **Deferred:** new features, not usability fixes. Empty states now say where the rows come from. |

### Phone (375–390 px) and accessibility

| # | Console | Sev | Finding | Status |
|---|---|---|---|---|
| P1 | All | M | No sideways scroll at 390. | **Verified** in the drive for every workspace, Platform and Vault. |
| P2 | Factory | L | Wide tables (QC rows with 6 buttons, PO rows with 7) scroll inside their card. Action buttons do not wrap. | **Deferred:** a card layout for rows on phones is a larger design change. |
| P3 | Factory | L | The "Open RAW Factory as an app" card covers the phone tab bar on first visit until "Not now". | **Deferred:** owned by focus mode. It is dismissable for a week. |
| P4 | Vault | M | Clickable formula and version rows were mouse-only. | **Fixed:** `tabindex`, `role=link`, Enter/Space. |
| P5 | Platform, Vault | M | Dialogs did not move focus inside; Escape listeners leaked (Platform). | **Fixed.** |
| P6 | Factory | L | Sortable column headers are not keyboard-reachable; the alert bell rows are clickable divs. | **Deferred.** |
| P7 | Platform | L | The test-light bin box had only a placeholder; fixed 160 px width. | **Fixed:** labelled and flexible. |

## Per-role navigation

The dock stays at 8 or fewer per role (`DOCK_DEFAULTS`, `web/dock.js`). The rail shows the workspace's full list, grouped when it has more than 9 screens.

| Workspace | Screens | Grouped rail | Dock |
|---|---|---|---|
| owner | 39 | yes | 8 |
| admin | 18 | yes | 8 |
| procurement | 20 | yes | 8 |
| receiving | 8 | no | 7 |
| qc | 10 | yes | 7 |
| production | 22 | yes | 8 |
| warehouse | 19 | yes | 8 |
| compounding | 10 | yes | 8 |
| filling | 6 | no | 5 |
| packaging | 14 | yes | 8 |
| sales | 11 | yes | 8 |

No screen was removed from any role. Each screen there is backed by permissions the role holds, and taking features away is not a usability fix.

A few look out of place but have a reason: QC's Factory setup holds Ruh's QC-spec drafts, and sales' Put-away & pick covers finished-goods picking. The owner can trim these later through roles if wanted.

## Verification

Every check below passed on 2026-10-09 against the lane head.

**Headless drive: 424 of 424 checks passed.** The script lives in the lane scratchpad (`stack/drive.mjs`); screenshots are in `docs/ui/evidence/ux-audit/`.

- **All 11 Factory workspaces**, in Chromium at 1440 px and 390 px (mobile emulation):
  - lands on `#/<workspace>/home`, with a help line
  - dock has 8 or fewer entries
  - three journey screens open by address, each with a title, trail and help line
  - no raw status codes
  - reload keeps the screen; Back and Forward walk the screens
  - a dock tap writes a readable address
  - an older `#/go/…` link is rewritten
  - a screen the workspace lacks keeps you in place
  - at 390 px: no sideways scroll
- **WebKit pass at 390 px:** title, trail and no sideways scroll on two screens per workspace. Reload is not checked here: locally, WebKit drops the Secure session cookie over plain http, so reload and history were driven in Chromium.
- **Records** (procurement purchase orders, receiving goods receipts, sales orders): opening a row's details gives it an address with its code (`#/procurement/purchase-orders/DEMO-PO-0038`). The trail names it, and reload re-opens it with details expanded.
- **Production and QC person:** a QC link switches to the QC workspace; switching workspace writes the new home address; Back returns to the QC screen.
- **Signed out:** `#/qc/test-queue` → sign-in → the assertion arrives in a new tab → QC test queue opens.
- **Platform** (1440 and 390):
  - every screen word opens its screen with a help line
  - `#/support`, `#/picklight`, `#/bridge` and an unknown address are rewritten
  - reload keeps the screen
- **Vault** (formulator, vault approver; 1440 and 390):
  - Formulas opens; a formula opens from the keyboard with its trail
  - a version shows **Formulas › code › Version n** and no raw id
  - Back returns to the formula
  - Recipes needed, Approve recipes and Formula needed open, each with a help line or a "not part of your role" card
  - "Approve recipes" is in the approver's dock

**Tests**

- New: `backend/api/src/__tests__/console-routes.test.ts` (route table, round trips, redirects for every Ruh link in the backend, cross-workspace resolution, record codes, one name per screen, help lines and groups, status and column words, Platform and Vault routes).
- New: `backend/api/src/__tests__/console-screens.test.ts` (no prompt/confirm/alert, no status codes or "this build", plain screen-guide words, title/trail/help, empty states, confirmations, toasts announced).
- Updated for the bumped caches and the moved deep-link code: `ruh-web`, `produce-web`, `factory-setup-web`, `formula-setup-web`.
- `node backend/test-support/run-tests.mjs` on a fresh database (TEST_DATABASE_URL = FORMULA_TEST_DATABASE_URL = `ux_full`): **3479 tests, 3479 passed, 0 failed, 0 skipped**. The baseline at `17e39e6` was 3459/3459.
- `pnpm -r typecheck`: passed. `pnpm boundaries`: no violations (852 modules).
- `scripts/gen-permission-grants.ts --since rc-rawprod-2026-10-06.1`: **0 new grants**. This lane adds no permissions, so there is no grant SQL to ship.

**Release notes**

- Service-worker caches: Factory `ra-shell-v98` (new files `routes.js` and `screen-guide.js` precached); Platform `platform-shell-v16`. The Vault has no service worker.
- No backend, nginx or database change. Ruh keeps writing `#/go/…` links and they keep working.

## Deferred: owner or other lanes

1. **Vault keeps the screen through sign-in.** This needs ALEMBIC's "Open Vault" to carry a return hash back with the assertion (for example `#assertion=…&to=/version/<id>`). The Vault cannot store it itself.
2. **The produce/shelf lane's short toasts** (E12) and **the phone row layout for wide tables** (P2).
3. **Missing create forms** (E13): Material issues, CAPA and Product SKUs.
4. **Vault access grants** still take a raw user id. They need a person picker; the Vault cannot read the main user list, so this needs a design decision.
5. **Keyboard sorting and the bell list** (P6).
