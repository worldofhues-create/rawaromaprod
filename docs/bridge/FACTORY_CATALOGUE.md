# ALEMBIC ↔ RawProd — factory catalogue and setup proposals (v1)

Mirrored verbatim in both repos: `docs/bridge/FACTORY_CATALOGUE.md`. If the two ever disagree,
that is a bug — diff them before trusting either. Owner decisions 2026-10-05: "we already have
inventory — build the factory data and let Ruh/ARIA predict and apply it"; products are mostly
blended in-house; **Ruh drafts, one person approves**. Derived data applies by itself; anything
estimated is a proposal; nothing unapproved reaches a COA, a label or the floor.

## Granularity: one factory SKU per commercial SKU, same code

The factory SKU code **is** the ALEMBIC SKU code. Read off the two ends of the round trip:

- ALEMBIC holds **one active mapping per commercial SKU** (`bridge_sku_mapping`), and a
  requirement carries the pack (`pack_size`) and the kilograms (`qty_kg`) separately. RawProd sizes
  the run from `qty_kg` alone.
- `fg.batch.received` comes back naming the factory SKU, and ALEMBIC finds its SKU by
  `upper(sku.code) = upper(<that code>)`.

So the factory makes and stocks the **bulk product by weight**; ALEMBIC receives it as lots in mg
and packs the ladder sizes at dispatch. `product_sku.pack_size` is left empty (record finished
goods in a mass unit). A per-pack factory SKU would be unmappable and would land on no ALEMBIC SKU.

## Transport

The `rawprod_bridge` connector's existing shared secret; no new trust relationship. Every request
below is signed like the Facts API:

```
x-bridge-timestamp: <unix seconds>      refused when > 300 s old or > 5 s in the future
x-bridge-nonce:     <random, single use> spent only after the signature verified
x-bridge-signature: sha256=<hex HMAC-SHA256 of `${timestamp}.${nonce}.${rawBody}`>
```

RawProd checks with `backend/api/src/bridge/signed-request.ts` (nonce store `bridge.facts_nonce`);
ALEMBIC with `verifyRawProdBridgeRequest` (nonce store `bridge_request_nonce`).

## ALEMBIC → RawProd: `POST /v1/bridge/catalogue/sync`

Address: the connector's `factsApiUrl` with its last two segments replaced
(`…/v1/bridge/facts/query` → `…/v1/bridge/catalogue/sync`). Sent by Admin → Produce & dispatch →
Factory setup → "Set up factory catalogue", and by a background sync every 10 minutes
(`ALEMBIC_FACTORY_SYNC_MS`, 0 = off) that sends only SKUs whose item changed.

```jsonc
{
  "tenantId": "uuid",          // ALEMBIC tenant; RawProd refuses 403 unless it equals ALEMBIC_ASSERTION_TENANT_ID
  "subject":  "uuid|null",     // ALEMBIC staff_user.id who pressed the button (audit only, never authority)
  "op":       "upsert",        // or "status" (items: [])
  "items": [ {                 // 1..200 per call
    "alembic_sku_id": "uuid",                   // the key: RawProd upserts on it
    "sku_code": "ALTHAIR",                      // == factory SKU code == product_code == material_code (≤ 50 chars)
    "name": "Althair",
    "category": "fo",
    "classification": "single_chemical",        // or "blend"
    "classification_basis": "CAS number 24851-98-7 on file",  // plain words: why
    "grade": null,                              // Identical | Klone | Economy | Inspired | Agarbatti | null
    "cas_number": "24851-98-7",                 // only as ALEMBIC holds it
    "cas_source": "ALEMBIC catalogue (product record)",       // required whenever cas_number is set
    "density_mg_per_ml": null,                  // integer, or null = not measured
    "density_source": null,                     // e.g. "document (approved Ruh draft): supplier SDS \"x.pdf\" …"
    "hazmat": { "is_hazmat": false, "un_number": null, "hazard_class": null, "packing_group": null,
                "flash_point_c": null, "source": null, "verified_at": null },   // held values + their source only
    "pack_sizes": [ { "label": "100 g", "dimension": "MASS", "kg": 0.1, "status": "ok" },
                    { "label": "30 ml", "dimension": "VOLUME", "kg": null, "status": "needs_density" } ],
                                                // status: ok | needs_density | counted | unreadable
    "on_hand_kg": 12.5                          // ALEMBIC ON_HAND, sizes the rack proposal
  } ]
}
```

No field is a formula, recipe, ingredient or composition; RawProd refuses any item key that looks
like one. Kits, discovery sets and packaging (categories priced from an explicit list) are not sent.

Response (inside RawProd's `{data}` envelope):

```jsonc
{ "ok": true, "results": [ { "sku_code": "ALTHAIR",
    "outcome": "created",      // created | updated | unchanged | linked (an existing product/material with that code) | refused
    "reason": "…",             // refused only
    "material_id": "uuid", "rm_alias_id": "uuid", "floor_code": "RM-7QK2MX",
    "product_id": "uuid", "product_sku_id": "uuid" } ] }
```

`op: "status"` answers `{ "ok": true, "status": <the checklist counts below> }`.

Errors: 401 `unauthenticated` (bad/missing signature, stale, replayed, connector off), 400
`bad_request` + `problems`, 403 `wrong_tenant`.

What RawProd writes per item, in one transaction: `masterdata.material` (code = sku_code, CAS and
density only as held) + `masterdata.rm_alias` floor code (`RM-` + 6 Crockford-base32 characters of
SHA-256 of the upper-cased code; opaque on purpose) with the `masterdata.material.created` /
`masterdata.alias.created` outbox events; `packaging.product_master` with **no formula**;
`packaging.product_sku` (sku_code = the code); and `bridge.catalogue_item`. A product or material
made by hand under the same code is linked, never rewritten, and `product_master.formula_id` is
never touched. When nobody has set a pick-to-light mode, the first sync sets `simulator`.

After a successful result ALEMBIC writes the active `bridge_sku_mapping` (created_by
`factory_catalogue_sync:<actor>`) and resolves the SKU's open mapping-queue items; a mapping a
person authored is kept and reported.

## For the Vault lane: `GET /v1/factory-setup/catalogue` (RawProd main box)

Permission `formula:formula_version:read` (the Vault console's `mainApi`, like
`/v1/produce/formula-needs`). One row per catalogue item:

```jsonc
{ "alembicSkuId": "uuid", "skuCode": "ALTHAIR", "name": "Althair",
  "classification": "single_chemical",   // draft a 100 % repack of materialId
  "classificationBasis": "…", "grade": null, "casNumber": "…", "casSource": "…",
  "materialId": "uuid",                  // masked to the floor code for a role without material reveal
  "floorCode": "RM-7QK2MX", "productId": "uuid", "productSkuId": "uuid",
  "formulaLinked": false, "syncedAt": "…" }
```

`blend` rows need a recipe: a "recipe needed" shell. Linking a formula sets
`packaging.product_master.formula_id` for `productId` — the Vault lane's work, never this sync's.

## RawProd → ALEMBIC: `POST /api/v1/internal/rawprod/factory-setup/qc-drafts`

Address: the origin of RawProd's configured bridge webhook URL. Body:
`{ "tenantId": "uuid", "subject": "uuid|null", "skuCodes": ["ALTHAIR", …] }` (1..50). A named
subject must be an active ALEMBIC colleague in that tenant (else 403). Answer:

```jsonc
{ "ok": true, "ai": "used|off|ceiling|failed|not_needed",
  "items": [ { "sku_code": "ALTHAIR", "source": "estimate", "missing": [], "reason": null,
    "draft": { "sg_min": { "value": 0.95, "source": "document", "evidence": "supplier SDS \"x.pdf\" …" },
               "sg_max": {…}, "flash_point_min_c": {…}, "flash_point_max_c": {…},
               "shelf_life_months": {…}, "colour_appearance": {…}, "odour": {…} } } ] }
```

Order per field: an uploaded supplier SDS / lab COA (PDF text) or the transcribed SDS → a held
catalogue fact with its source → a model estimate through ALEMBIC's AI gateway, charged against
`ai.monthly_budget_inr` before the call. A single printed value becomes a range with Ruh's
tolerance (SG ± 0.01, flash point ± 3 °C) and the evidence says so. `draft: null` with `missing`
and `reason` when a required field has no value from any source.

## Proposals and approval

| Draft | Stored | Approved by | Approval writes |
|---|---|---|---|
| Density (ml-sold SKUs, none on file) | ALEMBIC `factory_setup_proposal` | ALEMBIC admin (`factory.setup`) | `sku.density_mg_per_ml` + `density_source` + `density_approved_by/at` |
| QC spec per factory product | RawProd `production.setup_proposal` | `production:product_qc_spec:write` (qc, owner) | `production.product_qc_spec` via `CoaService.upsertSpec`, as the approver |
| Rack layout | RawProd `production.setup_proposal` | rack + shelf + bin write (warehouse, owner) | bins via `ShelfLayoutService.importCsv` (counts editable first) |

Every proposal: `source` (`document` | `catalogue fact` | `estimate`), `evidence`, proposer `Ruh`,
status `proposed → approved | rejected` (once), or `superseded` when a person entered the value
while the draft waited. Bulk approve/reject per screen. Audited (ALEMBIC `audit_log`
`factory.density_*`; RawProd `bridge.audit_events` `factory_setup.*`).

## Checklist counts (RawProd `GET /v1/factory-setup/checklist`, and `op: "status"`)

```jsonc
{ "catalogue": { "products", "singleChemicals", "blends", "lastSyncedAt" },
  "packs": { "ok", "needsDensity", "counted", "unreadable", "productsNeedingDensity" },
  "qcSpecs": { "products", "approved", "proposed", "missing" },
  "racks": { "zones", "racks", "bins", "proposed" },
  "pickLight": { "mode": "off|simulator|http|unset" },
  "formulas": { "linked", "products" },
  "blocked": { "unknownSku", "noFormulaLink", "noApprovedFormula", "qtyNotInKg" } }
```
