# ALEMBIC ↔ RawProd bridge — compliance facts (v1)

DOCS-001, owner rulings 2026-09-28. Two **RawProd → ALEMBIC** event types that
carry *facts* rather than steps of a production requirement. They ride the
existing signed bridge unchanged: same envelope, same endpoint
(`POST /api/v1/bridge/rawprod/webhooks/:endpoint`), same `x-bridge-signature`
(`sha256=<hex HMAC-SHA256 of the raw body>` with the `rawprod_bridge`
connector's `hmac_secret`), same `event_id` dedupe. Mirror this file into
`rawaromaprod/docs/bridge/` alongside `EVENT_CONTRACT.md`.

What differs from the requirement events in `EVENT_CONTRACT.md`:

- `aggregate` is not a production requirement. Send
  `{ "type": "qc_batch", "id": <RawProd's batch uuid> }` for a QC release and
  `{ "type": "product", "id": <RawProd's product uuid> }` for a calculation.
  ALEMBIC does not look the id up; it must be a uuid.
- `version` must be an integer ≥ 1 but is not sequenced: a fact is applied
  whenever it arrives. The **latest wins by its own timestamp**
  (`released_at` for a QC release, `calculated_at` for a calculation), so a
  late re-delivery of an older fact never replaces a newer one.
- `correlation_id` is any uuid (a batch's facts may share one).
- `payload` field names are **snake_case**, as below. Values that are
  measurements or percentages are **strings**, exactly as they should print
  ("0.995", "116.0", "0.60") — ALEMBIC never re-rounds them.
- **Never a formula, recipe, BOM, or any `formula.*` field.** The calculation
  crosses as its result; `formula_version_ref` is an opaque label.

## Product reference (both facts)

```jsonc
"product_ref": { "sku": "ALTHAIR" }             // the ALEMBIC commercial SKU code, or
"product_ref": { "factory_sku": "FG-ALT-001" }  // RawProd's factory SKU, resolved through the
                                                // ACTIVE bridge_sku_mapping row
```

One of the two is required; `sku` wins when both are present.

## `qc.batch.released`

Sent when factory QC reaches a verdict on a finished-goods batch — **both
verdicts**. A `failed` release is how ALEMBIC learns a batch must not be
certified; a later `passed` release for the same batch (re-test) supersedes it.

```jsonc
{
  "event_id": "uuid", "version": 1, "type": "qc.batch.released",
  "org_id": "uuid", "correlation_id": "uuid", "causation_id": null,
  "occurred_at": "2026-02-15T09:00:00.000Z", "source": "rawprod",
  "aggregate": { "type": "qc_batch", "id": "uuid" },
  "payload": {
    "batch_no": "A140226",                 // == the lot code ALEMBIC holds for this batch (lot.code)
    "product_ref": { "sku": "ALTHAIR" },
    "status": "passed",                    // "passed" | "failed"
    "results": [                           // at least one
      { "key": "odour", "label": "Odour description",
        "value": "Warm Spicy Vanilla Fragrance", "pass": true },
      { "key": "colour_appearance", "label": "Colour and appearance",
        "value": "Deep Brown", "pass": true },
      { "key": "specific_gravity", "label": "Specific Gravity at 20/4°C",
        "value": "0.995", "unit": null, "method": null,
        "spec": { "min": "0.950", "max": "1.500" }, "pass": true },
      { "key": "flash_point", "label": "Zero Reference Flash Point",
        "value": "116.0", "unit": "°C", "method": "Pensky-Martens, closed cup",
        "spec": { "min": "110.0", "max": "120.0" }, "pass": true }
    ],
    "photos": [                            // optional, at most 8
      { "url": "https://…/qc/A140226/sg.jpg",   // https, fetchable WITHOUT auth for ≥ 1 hour
        "asset_ref": null,                      // or RawProd's asset id (kept as a reference only)
        "caption": null,
        "result_key": "specific_gravity" }      // which result the photo belongs beside; null = general
    ],
    "production_date": "2026-02-14",       // yyyy-mm-dd
    "best_before": "2028-02-14",           // yyyy-mm-dd, after production_date
    "released_at": "2026-02-15T09:00:00.000Z",
    "qc_record_ref": "QC-2026-0412"        // RawProd's own id for the QC record (audit trail)
  }
}
```

Field rules:

| Field | Rule |
|---|---|
| `results[].key` | Stable machine key. `odour` and `colour_appearance` print in the COA's header block (descriptive); every other key prints as a row of the measurement table. |
| `results[].label` | Printed as is. |
| `results[].value` | Printed as is; if it is a number, it is **checked against `spec`**. |
| `results[].spec` | `{ min, max }` numeric strings (either may be null) or `{ "text": "…" }` for a descriptive specification. |
| `results[].pass` | RawProd's verdict for the line. |
| `photos[].url` | ALEMBIC copies the bytes **once, on receipt** (JPEG or PNG, ≤ 3 MB, 8 s timeout). A presigned URL is fine; it does not need to outlive the copy. A photo that cannot be fetched is recorded with the reason; the release still applies. |

**What ALEMBIC does with it.** Stores the release (`qc_batch_release`) and its
photos (`qc_batch_photo`). When an order line ships from that batch, the COA is
generated from the **latest** release for `batch_no`, and **refused** — the
dispatch desk sees the reason — when there is no release, the release is
`failed`, any line is `pass: false`, or any numeric `value` lies outside its own
`spec` (a COA must not contradict itself, whatever the verdict says). The COA
prints order number, product, batch, supplied quantity (from the shipment),
the descriptive results, the measurement table with specifications, the photos,
production date and best-before.

## `compliance.certificate.calculated`

Sent when the RawProd Vault calculates a product's IFRA limits or allergen
content from its formula. **Supersedes** any values compliance entered by hand
for that product and kind; the issued document carries the visible source line
**"Calculated from formula v{formula_version}"**.

```jsonc
{
  "event_id": "uuid", "version": 1, "type": "compliance.certificate.calculated",
  "org_id": "uuid", "correlation_id": "uuid", "causation_id": null,
  "occurred_at": "2026-09-01T00:00:00.000Z", "source": "rawprod",
  "aggregate": { "type": "product", "id": "uuid" },
  "payload": {
    "product_ref": { "factory_sku": "FG-ALT-001" },
    "kind": "ifra",                                  // "ifra" | "allergen"
    "amendment": "51st",                             // REQUIRED for ifra; omit/null for allergen
    "formula_version": 3,                            // integer ≥ 1, printed as "v3"
    "formula_version_ref": "rawprod:formula/9f2c:v3",// opaque, ≤ 200 chars, NO formula content
    "calculated_at": "2026-09-01T00:00:00.000Z",     // also the IFRA "Date Prepared"
    "values": { /* by kind, below */ }
  }
}
```

`values` for `kind: "ifra"` — a level/limit for **all 18** categories, as
percentage strings 0–100 (up to 4 decimals, no `%` sign needed):

```jsonc
"values": { "limits": {
  "1": "0.00", "2": "2.00", "3": "1.50", "4": "25.00",
  "5A": "12.00", "5B": "12.00", "5C": "8.60", "5D": "0.60",
  "6": "0.00", "7A": "10.10", "7B": "10.01", "8": "3.00", "9": "12.75",
  "10A": "30.75", "10B": "30.00", "11A": "1.00", "11B": "0.80", "12": "100"
} }
```

`values` for `kind: "allergen"` — **all 26** EU allergens by CAS number, each
cell a percentage string or `"A"` (absent):

```jsonc
"values": { "rows": [
  { "cas": "127-51-5", "natural": "A", "synthetic": "A", "total": "A" },
  { "cas": "104-55-2", "natural": "0.02", "synthetic": "A", "total": "0.02" }
  // … one row for each of the 26 CAS numbers in EU_ALLERGENS_26
] }
```

The 26 CAS numbers, in order: 127-51-5, 122-40-7, 101-85-9, 105-13-5,
100-51-6, 120-51-4, 103-41-3, 118-58-1, 80-54-6, 104-55-2, 104-54-1, 106-26-3,
106-22-9, 91-64-5, 97-53-0, 90028-67-4, 90028-68-5, 4602-84-0, 106-24-1,
101-86-0, 107-75-5, 31906-04-4, 97-54-1, 138-86-3, 126-90-9, 111-12-6.

**What ALEMBIC does with it.** Stores the result (`compliance_certificate_calc`,
append-only) and flags the product's issued document for re-issue in the
Control Room ("A formula calculation (v3) supersedes the issued values").
Compliance re-issues; the new version is drawn from the calculation. Versions
already issued stay exactly as they were.

## `qc.gcms.attached` (FACTORY-DOCS)

Contract: ALEMBIC `docs/plan/program/documents-automation.md` > "What RawProd must send", fact 3
(confirmed by the lead 14 Nov 2026; ALEMBIC side `handleGcmsFact`, st4/docs-auto). Sent when QC attaches a
lab's GC-MS PDF to a batch on the batch certificates screen (row action **Attach GC-MS**,
`POST /v1/batch-coas/:id/gcms`, permission `production:batch_coa:write`; not on a rejected batch).
The upload is the PDF itself (`content-type: application/pdf`, the lab's details in the query string) on
that route directly, OUTSIDE the console's `/rpc` tunnel, with the session's bearer token. The token is
verified before any of the body is read (api `upload-body-limits.ts`); only then may the body exceed 1 MiB
(8 MiB, so a 6 MB file reaches the service and is refused in plain words). `/rpc` keeps 1 MiB.

```jsonc
"aggregate": { "type": "qc_batch", "id": "<RawProd batch COA uuid>" },   // same aggregate as the batch's QC verdict
"payload": {
  "batch_no": "A140226",                       // == the batch number qc.batch.released carries
  "product_ref": { "factory_sku": "FG-ALT-001" },
  "file": { "url": "https://rawfactory.huecycle.in/v1/bridge/files/gcms/<report uuid>?sha=..&exp=..&sig=.." },
  "sha256": "<hex SHA-256 of the PDF bytes>",
  "lab_name": "Indore Analytical Lab",
  "report_ref": "IAL/26/0412",
  "analysed_on": "2026-02-15",
  "attached_at": "2026-02-15T10:00:00.000Z"
}
```

- **The file.** RawProd had no binary store, so the PDF (at most 5 MB, `%PDF-` checked) is kept in
  `production.batch_gcms_report` (migration `2026-11-27-batch-gcms-report.sql`) and served only through
  `file.url`: a link signed with a key derived from the bridge connector secret, naming the report and its
  exact bytes, valid for **60 minutes**. The relay mints a fresh link at **every delivery attempt** (the
  stored outbox row has no `file`), so a retry after backoff never carries a dead link. ALEMBIC fetches on
  receipt; a failed fetch is its 502, which the relay retries; an unknown batch is parked there with the
  bytes kept, so the link need not outlive the first successful fetch.
- **Idempotency.** `event_id`; and here (batch, sha256) is unique: attaching the same file to the same
  batch again records nothing and sends nothing. A different file is a new report; ALEMBIC keeps the one
  with the latest `attached_at`.
- **Configuration.** `BRIDGE_FILE_BASE_URL` (the https origin ALEMBIC reaches this API at). Unset: the
  fact is not sent; it backs off and parks with the reason, replayable once it is set.
- **Order.** Until ALEMBIC's release accepts the type, a sent fact is refused as unknown and parks in
  `bridge.outbox`, replayable under the same event id.

## Responses

| Status | `outcome` | Meaning for the sender |
|---|---|---|
| 200 | `applied` | Stored. |
| 200 | `already_seen` | This `event_id` was applied before. Stop retrying. |
| 200 | `parked_unknown_product` | Neither `sku` nor an active mapping for `factory_sku` exists. Recorded (`bridge_inbound_event.parked_reason = 'unknown_aggregate'`) for reconciliation; do not retry. |
| 400 | `bad_payload`, `permanent: true`, `code: BRIDGE_PERMANENT_INVALID_PAYLOAD` | The payload broke a rule above; `detail` lists every problem. **Nothing was recorded** — fix and resend under the same `event_id`. |
| 400 | `bad_envelope` / `bad_json` | As `EVENT_CONTRACT.md`. |
| 401 | `signature_invalid` | As `EVENT_CONTRACT.md`. |

The validation is `parseQcBatchReleased` and `parseCertificateCalculated` in
`packages/domain/src/compliance/documents.ts`; the handler is
`handleComplianceFact` in `apps/api/src/services/bridge-webhook.ts`; the tests
are `apps/api/test/compliance-documents.test.ts` (signed deliveries through
`handleRawProdEvent`) and `packages/domain/test/compliance-documents.test.ts`.
