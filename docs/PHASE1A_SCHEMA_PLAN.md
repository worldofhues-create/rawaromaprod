# RAW AROMACHEM — Phase-1A Schema Realignment Plan

**The `RAW AROMACHEM Phase-1A Data Dictionary` is now the AUTHORITATIVE Phase-1 data model.**
The freeze doc = scope; the business flow = sequence; this dictionary = the exact tables/columns/relationships. The architecture stays (modular monolith, edge/BFF, transactional outbox, vault crypto, workflow); the **data + service layer is realigned to this dictionary, table-for-table.**

## Honest divergence (what changes from the current build)
My in-progress build *approximated* the schema. The dictionary differs and wins:
- **Explicit master tables** (COUNTRY_MASTER, CURRENCY_MASTER, UOM_MASTER, MATERIAL_TYPE_MASTER, …) instead of the generic `master_types/master_items` engine.
- **Explicit warehouse hierarchy** (WAREHOUSE→FLOOR→ZONE→RACK→SHELF→BIN + STORAGE_LOCATION_MASTER) instead of the generic self-tree.
- **Dictionary base columns** on every table: `<Entity>ID` (uuidv7 PK), `Status VARCHAR(30)`, `CreatedDT`, `UpdatedDT`, `CreatedBy VARCHAR(255)`, `UpdatedBy VARCHAR(255)` — replacing my `baseColumns()`/`softDelete()`.
- **Masking model** = `RM_ALIAS` (MaterialID→AliasName) + `FORMULA_VAULT` (EncryptionKeyRef, VaultLocation) + `FORMULA_ACCESS_POLICY`, not encrypted ingredient columns alone.
- **Dictionary event-history tables** (FORMULA_EVENT_HIST, INVENTORY_EVENT_HISTORY, OIL_BATCH_EVENT_HISTORY, BATCH_GENEALOGY_HISTORY, WORKFLOW_TRANSACTION_MASTER) are the domain audit trail.

## Conventions (decided — physical Postgres mapping of the logical dictionary)
- **snake_case** physical names mapping the dictionary 1:1 (`AddressID`→`address_id`, `CreatedDT`→`created_dt`). Table `ADDRESS_MASTER`→`address_master`.
- **Base columns helper `meta()`**: `status varchar(30)`, `created_dt timestamptz default now()`, `updated_dt timestamptz default now()`, `created_by varchar(255)`, `updated_by varchar(255)`. PK declared per table as `<entity>_id uuid primary key default uuidv7()`. (No `deleted_at` — lifecycle is `status`.)
- **Relationships:** in-cluster references = real FKs; cross-cluster references = id-only soft refs (integrity via events + the dictionary's *_EVENT_HISTORY/genealogy tables) — preserves the dictionary's relationships while keeping clusters extraction-safe (the modular-monolith guarantee the owner asked for).
- **Infra retained alongside the dictionary:** per-cluster `outbox` (cross-cluster integration events) + the edge layer. The dictionary's `*_EVENT_HISTORY` tables are the domain audit; the outbox is the integration bus. Both kept.

## Table → cluster/schema map (~150 tables)

**`iam` schema** — org + users + security
ORG_GROUP_MASTER, ORG_MASTER, ORG_TYPE_MASTER, ORG_RELATIONSHIP, BUSINESS_UNIT_MASTER, USER_MASTER, ROLE_MASTER, PERMISSION_MASTER, ROLE_PERMISSION_MAPPING, USER_ROLE_MAPPING, LOCATION_AUTHORITY_MASTER, APPROVAL_MATRIX (Phase-1B revision, §87 — per-organisation approval policy: PO-approval second-level threshold + RFQ-award separation of duties; see docs/PHASE1B_SCHEMA_PROPOSAL.md §0)

**`platform` schema** — reference masters + geo + docs + contacts + uom
COUNTRY_MASTER, CURRENCY_MASTER, LANGUAGE_MASTER, TIMEZONE_MASTER, ADDRESS_MASTER, GEO_LOCATION_MASTER, CONTACT_MASTER, DOCUMENT_MASTER, DOCUMENT_TYPE_MASTER, UOM_MASTER, UOM_TYPE_MASTER, UOM_CONVERSION_MASTER, BRAND_MASTER

**`location` schema** — sites + warehouse hierarchy
LOCATION_MASTER, LOCATION_TYPE_MASTER, WAREHOUSE_MASTER, WAREHOUSE_TYPE_MASTER, FLOOR_MASTER, ZONE_MASTER, ZONE_TYPE_MASTER, RACK_MASTER, SHELF_MASTER, BIN_MASTER, STORAGE_LOCATION_MASTER, STORAGE_LOCATION_STATUS_MASTER, STORAGE_LOCATION_TYPE_MASTER

**`masterdata` schema** — material
MATERIAL, MATERIAL_TYPE_MASTER, MATERIAL_CATEGORY_MASTER, MATERIAL_SUBCATEGORY_MASTER, MATERIAL_GROUP, MATERIAL_QC_SPECIFICATIONS, MATERIAL_STORAGE_RULES, MATERIAL_AGEING, RM_ALIAS

**`procurement` schema** — vendor + PR/RFQ/quotation/PO + credit
VENDOR_DETAILS, VENDOR_CONTACT, VENDOR_RM_MAPPING, VENDOR_PO_ACK, VENDOR_CREDIT_NOTE, VENDOR_CREDIT_NOTES_ALLOCATION, VENDOR_CREDIT_REASON_MASTER, STOCK_REQUIREMENT, STOCK_REQ_ITEMS, PURCHASE_REQUEST, PURCHASE_REQUEST_ITEMS, PURCHASE_REQUEST_APPROVAL, RFQ_MASTER, RFQ_ITEMS, RFQ_VENDOR_MAPPINGS, QUOTATIONS, QUOTATION_ITEMS, PURCHASE_ORDER, PURCHASE_ORDER_ITEMS, PO_APPROVAL_ORDER

**`inventory` schema** — gate/GRN/batch + stock
GATE_ENTRY_MASTER, GATE_ENTRY_DOCUMENTS, GRN_MASTER, GRN_ITEMS, GRN_CONTAINER, RM_BATCH_MASTER, BATCH_CONTAINER_MAPPINGS, BATCH_GENEALOGY_HISTORY, INVENTORY_BATCH, INVENTORY_STATUS_MASTER, INVENTORY_TRANSACTION, INVENTORY_TRANSACTION_TYPE_MASTER, INVENTORY_EVENT_HISTORY, STOCK_ADJUSTMENT, STOCK_AUDIT, STOCK_AUDIT_DETAILS, STOCK_RESERVATION, STOCK_TRANSFER, EXPIRY_TRACKER

**`quality` schema** — QC
QC_INSPECTIONS, QC_PARAMETER_MASTER, QC_RESULT_DETAILS, QC_ATTACHMENTS, QC_CAPA, QC_DISPOSITION, QC_SAMPLE_RETENTION

**`formula` schema (ENCRYPTED, own role)** — vault
FORMULA_MASTER, FORMULA_TYPE_MASTER, FORMULA_VERSION, FORMULA_INGREDIENTS, FORMULA_STAGE_MASTER, FORMULA_STAGE_INGREDIENTS, FORMULA_VAULT, FORMULA_ACCESS_POLICY, FORMULA_APPROVAL, FORMULA_CHANGE_LOG, FORMULA_COPY_REQUEST, FORMULA_DOCUMENT_MAPPING, FORMULA_EVENT_HIST

**`production` schema**
PRODUCTION_PLAN, PRODUCTION_PLAN_ITEMS, PRODUCTION_ORDER, PRODUCTION_ORDER_INGREDIENTS, MATERIAL_PICK_LIST, MATERIAL_PICK_LIST_ITEMS, MATERIAL_ISSUE, MATERIAL_ISSUE_ITEM, SECURE_MIXING_SESSION, MIXING_STEP_LOG, OIL_BATCH_MASTER, OIL_BATCH_CONSUMPTION, OIL_BATCH_EVENT_HISTORY, OIL_BATCH_QC_HISTORY, PRODUCTION_QC

**`packaging` schema**
PRODUCT_MASTER, PRODUCT_CATEGORY_MASTER, PRODUCT_SKU, PACKAGING_MATERIAL_MASTER, PACKAGING_BOM_MASTER, PACKAGE_ORDER, PACKAGE_ORDER_ITEM, FILLING_SESSION, FILLING_SESSION_DETAILS, FINISHED_GOOD_BATCH_MASTER, FINISHED_GOODS_BATCH_CONSUMPTION, PACKAGING_QC (Phase-1B revision, lane B1 — the finished-good QC gate; see docs/PHASE1B_SCHEMA_PROPOSAL.md §3, adopted for real)

**`sales` schema**
CUSTOMER_MASTER, SALES_ORDER, SALES_ORDER_ITEMS, DISPATCH_MASTER, DISPATCH_ITEMS, TRANSPORTER_MASTER

**`workflow` schema** — generic state engine (the dictionary's own)
WORKFLOW_STATE_MASTER, WORKFLOW_TRANSACTION_MASTER

## LOCKED DECISIONS (owner-confirmed)
- **Authoritative spec = Phase-1A Manufacturing Core MVP Scope Freeze v1.0 + this Data Dictionary.** Realign the WHOLE data+service layer to it (rebuild the approximate clusters), keep the architecture.
- **IssuedQty = BOOLEAN, exactly as written** in MATERIAL_ISSUE_ITEM, PACKAGE_ORDER_ITEM, PRODUCTION_ORDER_INGREDIENTS — an "issued yes/no" flag, NOT a quantity. Build it boolean.
- **Vault = encrypt at rest, faithful to the dict.** Build FORMULA_VAULT/FORMULA_INGREDIENTS/RM_ALIAS/FORMULA_ACCESS_POLICY exactly; the sensitive ingredient values are encrypted at rest with `FORMULA_VAULT.EncryptionKeyRef` holding the key reference. Real recipe never plaintext; production sees only RM_ALIAS codes.

## Phase-1A scope (10 modules) + OUT of scope (Phase-1B — do NOT build)
Modules M01–M10: Enterprise Foundation · Material · Vendor · Procurement · GRN&QC · Inventory · Formula Vault · Production · Packaging · Sales&Dispatch.
**Out of scope (Phase-1B):** Dynamic Workflow Builder · WhatsApp · SMS · Vendor Performance Dashboards · Advanced Inventory Analytics · **Complaint Management · CAPA Workflow · Returns Management** · Mobile · AI Forecasting · ERP/Tally · Advanced BI.
→ So: no returns, no complaints, no CAPA business logic (QC_CAPA/QC_DISPOSITION tables MAY exist in the dict for schema completeness but carry no Phase-1A workflow), no vendor scorecards, no notification engine (only EXPIRY_TRACKER alerts). WORKFLOW_STATE/TRANSACTION are the lightweight state engine, NOT a dynamic builder.
- **Timeline:** 15 working days (owner's target).

## Other precision notes
- `MATERIAL_GROUP.MaterialSubCategoryID` → hierarchy Type→Category→SubCategory→Group; MATERIAL references MaterialGroupID + MaterialTypeID + MaterialCategoryID directly.

## Build order (dependency-first, matches the business flow)
1. iam + platform + location (foundation masters)  2. masterdata (material + RM_ALIAS)  3. procurement (vendor→PR→RFQ→quotation→PO)  4. inventory (gate→GRN→batch→stock)  5. quality (QC)  6. formula (vault)  7. production  8. packaging  9. sales  10. workflow + dashboards.
