# ALEMBIC ↔ RawProd bridge — payables facts (v1)

BOOKS phase 2, owner 2026-10-09 (*"finish it"*): vendor bills in ALEMBIC's
Books are matched against the purchase order and what was received (the
three-way match). The orders and receipts live in RawProd; these facts carry
them across the existing signed channel (`EVENT_CONTRACT.md`: same envelope,
same HMAC signature, same `event_id` dedupe). Each is a FACT, not a
requirement step: no requirement aggregate, no version sequence.

Mirror this file into `rawaromaprod/docs/bridge/`. The RawProd side is the
patch beside this file, `rawprod-payables.patch` (applies with `git apply -p1`
at RawProd 206472bb; ALEMBIC does not commit to RawProd).

## Types (RawProd → ALEMBIC)

| type | aggregate | when |
|---|---|---|
| `procurement.po.issued` | `purchase_order` | a PO is issued (also an amendment, once re-issued) |
| `procurement.po.amended` | `purchase_order` | an amendment row is created |
| `procurement.po.cancelled` | `purchase_order` | a PO is cancelled |
| `inventory.grn.created` | `goods_receipt` | a goods receipt is recorded |
| `procurement.vendor.upserted` | `vendor` | accepted by ALEMBIC; not yet emitted (the vendor travels inside every PO and GRN fact) |

ALEMBIC: `INBOUND_EVENT_TYPES` (packages/domain/src/bridge/envelope.ts),
migration `0291_bridge_payables_facts.sql`, parsers in
`packages/domain/src/bridge/payables.ts`, handler
`apps/api/src/books/bridge-payables.ts`.

## Payloads

Money and quantities are the `numeric(18,4)` DECIMAL STRINGS the RawProd
database holds. ALEMBIC converts them ONCE: rupees to integer paise (half up at
the second decimal), quantities to thousandths of the unit (half up at the
third). A PO not in INR is not sent (ALEMBIC refuses a converted figure).
Unknown fields are refused (`BRIDGE_PERMANENT_INVALID_PAYLOAD`); `_bridge_*`
transport fields are ignored.

`vendor` (inside every PO and GRN fact):

```jsonc
{ "vendor_id": "…", "vendor_code": "ACME", "vendor_name": "Acme Chemicals",
  "gstin": "27AABCA1234B1Z5", "state_code": "27", "pan_number": "AABCA1234B",
  "bank_account_number": "001122334455", "bank_ifsc": "HDFC0001234",
  "email": "…", "phone": "…", "payment_terms_days": 30 }   // all but the first three optional
```

`procurement.po.issued` / `procurement.po.amended`:

```jsonc
{ "po_id": "<ROOT po id>", "po_number": "PO-0042", "vendor": { … }, "order_date": "2026-10-01",
  "revision": 2, "currency": "INR", "total_amount": "250000.0000",
  "lines": [{ "po_line_id": "…", "material_code": "HED", "description": "Hedione",
              "ordered_qty": "25.0000", "uom": "KGS", "rate": "10000.0000" }] }
```

An amendment in RawProd is a NEW purchase_order row linked by
`replacement_of_po_id`. ALEMBIC keys an order by ONE id, so `po_id` is always
the ROOT of that chain and `revision` the chain's depth (1 = never amended).
ALEMBIC keeps the highest revision it has seen; an older revision arriving late
is recorded and ignored (`stale_revision`).

`procurement.po.cancelled`: `{ "po_id": "<ROOT>", "po_number": "…", "revision": 1, "reason": "…" }`

`inventory.grn.created`:

```jsonc
{ "grn_id": "…", "grn_number": "GRN-0007", "po_id": "<ROOT po id>", "vendor": { … },
  "grn_date": "2026-10-03",
  "lines": [{ "grn_line_id": "…", "po_line_id": "…", "material_code": "HED",
              "received_qty": "25.0000", "accepted_qty": "25.0000", "rejected_qty": "0", "uom": "KGS" }] }
```

A receipt may arrive before its order; ALEMBIC matches the two whenever both are
there. Only `accepted_qty` counts toward the match.

## What ALEMBIC does

- creates or refreshes the vendor (a vendor entered by hand with the same code
  or GSTIN is LINKED, not duplicated; the books keep their own TDS section);
- keeps the order (latest revision, its lines) and the receipt;
- on a bill that names the order line, compares the billed quantity with what
  was accepted (and ordered) and the billed amount with the order's rate, within
  the tenant's tolerances (Books → Payables → Match exceptions). A difference
  holds the bill for a second person.

Nothing on this channel moves money or posts to ALEMBIC's ledger; a bill posts
when it is entered (or overridden), and a payment only when a person records
the bank's UTR.

## RawProd side (as applied here)

- Emitter: `backend/backend-kernel/src/events/payables-facts.ts`, called inside the PO issue /
  amend / cancel and GRN create transactions; one `bridge.outbox` row per fact, its id the
  envelope `event_id`. Relay (`backend/api/src/bridge/relay.service.ts`) signs, retries transient
  failures with backoff and parks permanent refusals for replay.
- **Bank details are never sent** (H-S3): `bank_account_number` / `bank_ifsc` stay in RawProd;
  ALEMBIC Books keeps the bank details a person enters there.
- `po_number` is the ROOT order's number on every PO fact (an amendment row's own number is
  `…-AMD-…`). A PO with no currency is the organisation's own (INR); a set currency must be INR.
- Missing `order_date` / `grn_date` fall back to the row's creation date.
