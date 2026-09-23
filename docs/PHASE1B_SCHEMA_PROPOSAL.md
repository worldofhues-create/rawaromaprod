# Phase-1B Schema Proposal — missing tables found by lane F5 (RP-DEADTABLES)

**Status: PROPOSED dictionary revision**, except `iam.approval_matrix` which is **ADOPTED** (see
§0). Written by lane F8 (rp-policy), §87 "AUTONOMOUS DECISION DEFAULTS" item 4, of
`ALEMBIC_RAWPROD_FULL_SYSTEM_PRODUCT_OWNER_MASTER_V3.md`: *"For each required missing capability:
produce exact additive schema proposal; keep route honest/fail-closed until authoritative schema
approval."*

Lane F5 found eleven tables referenced by real backend code (raw SQL joins, inserts, or
`edit.service.ts` field maps) that exist in **NEITHER** `docs/PHASE1A_SCHEMA_PLAN.md`'s table list
**NOR** any `packages/data-<cluster>/src/schema/*.ts` file — i.e. `pnpm db:push`'s only source for
what actually exists in a real/dev database. Every call site was converted to an honest
`NotImplementedException` / refusal (lane F5) rather than crashing with "relation does not exist"
or fabricating rows; `backend/test-support/schema-guard.test.ts`'s `KNOWN_DEBT` allowlist tracks
the five of these still referenced by **raw SQL** (the schema-guard's regex only catches
`from|join|into|update <schema>.<table>` text, not string-literal error messages or
`NotImplementedException` stubs — see that file's own comment for why the other six don't show up
there even though they're the same defect).

This document is the "exact additive schema proposal" §87 requires for **all eleven** — table
shape, `docs/PHASE1A_SCHEMA_PLAN.md`'s table-map delta, and the drizzle + raw SQL each needs. It
does **not** itself adopt ten of the eleven into `packages/data-*` (per this lane's scope: "Do NOT
add them to packages/data-* yet"); a follow-up lane applies each entry here (add to the dictionary
+ the matching `packages/data-<cluster>/src/schema` file, `pnpm db:push`, delete the
`NotImplementedException` guard at each call site, and — for the two currently in `KNOWN_DEBT`
that this covers — delete that entry once the fix lands).

Every table below follows the Phase-1A dictionary conventions (`docs/PHASE1A_SCHEMA_PLAN.md`
"Conventions" + `docs/PHASE1A_DATA_DICTIONARY.md`'s header): `<entity>_id UUID DEFAULT uuidv7()`
PK (`dictPk()`), snake_case columns, and the meta tail `status varchar(30), created_dt, updated_dt,
created_by varchar(255), updated_by varchar(255)` (`metaColumns()`) — with two explicit,
documented exceptions (`inventory.material_issue_applied`, `platform.relay_inbox`) that are
single-applier claim/dedupe ledgers, not dictionary entities, and intentionally do not carry the
full meta tail (documented at each).

---

## §0 — ADOPTED this lane: `iam.approval_matrix`

Unlike the other ten, this table is **adopted into the real schema source by this lane**
(`packages/data-org/src/schema/policy.ts`, re-exported from
`packages/data-org/src/schema/index.ts`), because §87 items 1–2 (configurable PO-approval
threshold, configurable RFQ-award separation of duties) have nowhere else to live — there is no
existing org/tenant policy table anywhere in the codebase. This is the "current owner directive
supersedes the old dictionary lock… P0 may adopt the additive schema proposals into a new
canonical dictionary revision, but must record the revision and migration" case in §87's last
paragraph.

**Dictionary revision record:**
- **Revision**: Phase-1A → Phase-1B, `iam` schema gains `APPROVAL_MATRIX` (minimal policy slice —
  see the file-header comment in `policy.ts` for how it relates to the richer "who
  creates/submits/approves/final authority/auto-approval per transaction type" governance table
  `ProcAnalyticsService.approvalMatrix()`'s comment already envisioned; this is additive and
  compatible with growing into that shape later).
- **Migration**: additive only — a brand-new table, no column changes to any existing table.
  Applied via `pnpm db:push` (drizzle-kit diffs an empty snapshot against the target schema
  sources, so a new table is pure `CREATE TABLE`, no data loss risk). The lane's real-Postgres
  test harness (`backend/test-support/schema.sql`) gained matching `iam.org_master`,
  `iam.user_master` (minimal slices — real dictionary shape lives in `@ra/data-org`), and
  `iam.approval_matrix` tables so `pnpm test` exercises the real table shape end to end.
- **schema-guard KNOWN_DEBT**: `iam.approval_matrix` was never in `KNOWN_DEBT` (the guard's regex
  only matches raw-SQL `from/join/into/update` references; `ProcAnalyticsService.approvalMatrix()`
  throws `NotImplementedException` without ever issuing SQL against it, so it never tripped the
  guard). No entry to add or remove there. `ProcAnalyticsService.approvalMatrix()` is deliberately
  LEFT throwing `NotImplementedException` by this lane — building the richer read view described
  in its own doc comment is out of §87's scope (which only needs the table to exist and be
  READABLE by `PoService`/`RfqService`, not a governance UI).

```ts
// packages/data-org/src/schema/policy.ts (already added — see file for full comment)
import { index, numeric, uniqueIndex, uuid, varchar, boolean } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { iam } from "./_schema.js";
import { orgMaster } from "./org.js";

export const approvalMatrix = iam.table(
  "approval_matrix",
  {
    approvalMatrixId: dictPk("approval_matrix_id"),
    organizationId: uuid("organization_id").notNull().references(() => orgMaster.organizationId),
    policyType: varchar("policy_type", { length: 50 }).notNull(), // 'PO_APPROVAL_THRESHOLD' | 'RFQ_AWARD_SEPARATION'
    thresholdAmount: numeric("threshold_amount", { precision: 18, scale: 4 }),
    isEnabled: boolean("is_enabled"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("approval_matrix_org_policy_uq").on(t.organizationId, t.policyType),
    index("approval_matrix_org_idx").on(t.organizationId),
  ],
);
```

```sql
-- equivalent DDL (what `pnpm db:push` generates)
create table iam.approval_matrix (
  approval_matrix_id uuid primary key default uuidv7(),
  organization_id uuid not null references iam.org_master(organization_id),
  policy_type varchar(50) not null,
  threshold_amount numeric(18,4),
  is_enabled boolean,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index approval_matrix_org_policy_uq on iam.approval_matrix (organization_id, policy_type);
create index approval_matrix_org_idx on iam.approval_matrix (organization_id);
```

`docs/PHASE1A_SCHEMA_PLAN.md` table-map delta: `iam` schema gains `APPROVAL_MATRIX` after
`LOCATION_AUTHORITY_MASTER`.

---

## §1 — PROPOSED: `iam.login_history`

**Referenced by**: `backend/cluster-org/src/auth/auth.service.ts#recordSession` (best-effort
insert on every login, try/caught — never blocks login). The READ side
(`AuditService.loginHistory`, if/when restored) currently throws `NotImplementedException`
(lane F5). **`KNOWN_DEBT`** entry (raw SQL insert).

**Why not adopted now**: not needed by §87 items 1–3; adding it is a clean, isolated follow-up
that doesn't block this lane's actual scope.

```ts
// packages/data-org/src/schema/audit.ts (proposed)
import { index, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { iam } from "./_schema.js";
import { userMaster } from "./users.js";

export const loginHistory = iam.table(
  "login_history",
  {
    loginHistoryId: dictPk("login_history_id"),
    userId: uuid("user_id").references(() => userMaster.userId),
    portalAudience: varchar("portal_audience", { length: 30 }),
    refreshTokenHash: varchar("refresh_token_hash", { length: 128 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [index("login_history_user_idx").on(t.userId)],
);
```

```sql
create table iam.login_history (
  login_history_id uuid primary key default uuidv7(),
  user_id uuid references iam.user_master(user_id),
  portal_audience varchar(30),
  refresh_token_hash varchar(128),
  expires_at timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create index login_history_user_idx on iam.login_history (user_id);
```

**Adoption note**: `auth.service.ts#recordSession` currently inserts into columns
`(id, user_id, portal_audience, refresh_token_hash, expires_at)` — its `id` column becomes
`login_history_id` under this proposal (a one-line rename at that call site when adopted).

`docs/PHASE1A_SCHEMA_PLAN.md` delta: `iam` schema gains `LOGIN_HISTORY`.

---

## §2 — PROPOSED: `inventory.material_issue_applied`

**Load-bearing** — flagged explicitly by lane F5's own `KNOWN_DEBT` comment and by this lane's
brief: it is the single-applier concurrency CLAIM shared between
`ConsumptionService.applyIssue` (backend/api/src/consumption, the outbox poller that actually
decrements RM on-hand) and `MixingService.abortSession` (backend/cluster-production), which races
the same `INSERT ... ON CONFLICT (material_issue_id) DO NOTHING` to cancel an issue before it's
ever debited. Whichever side's transaction commits the claim row first wins — this is a real,
working concurrency primitive TODAY, but only against `backend/test-support/schema.sql`'s
hand-maintained table, never against a real/dev database via `pnpm db:push` (the table does not
exist in `packages/data-inventory`). **`KNOWN_DEBT`** entry.

**Why not adopted now**: per this lane's explicit scope ("Do NOT add them to packages/data-* yet,
EXCEPT where items 1–2 genuinely need a policy table") — this table is not needed by §87 items
1–3, so it stays a proposal here despite being load-bearing. Converting it to a stub would be
actively worse than the current honest gap (it would silently corrupt the abort-vs-debit race
instead of just refusing), so lane F5 correctly left the real logic in place against the test
harness only; adopting it for real needs a dedicated lane that can prove the concurrency behaviour
against `pnpm db:push`'s actual schema, not a drive-by add here.

```ts
// packages/data-inventory/src/schema/consumption.ts (proposed)
// NOTE: intentionally does NOT use dictPk()/full metaColumns() — this is a single-applier CLAIM
// row keyed by the FOREIGN material_issue_id (not its own generated id), matching the exact
// shape ConsumptionService.applyIssue / MixingService.abortSession already insert/read against
// in backend/test-support/schema.sql. A dict-shaped surrogate key would not serve the claim's
// purpose (the PK must BE the issue id, so ON CONFLICT DO NOTHING dedupes on it).
import { integer, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { inventory } from "./_schema.js";

export const materialIssueApplied = inventory.table(
  "material_issue_applied",
  {
    materialIssueId: uuid("material_issue_id").primaryKey(),
    itemCount: integer("item_count"),
    appliedDt: timestamp("applied_dt", { withTimezone: true }).notNull().defaultNow(),
  },
);
```

```sql
create table inventory.material_issue_applied (
  material_issue_id uuid primary key,
  item_count integer,
  applied_dt timestamptz not null default now()
);
```

`docs/PHASE1A_SCHEMA_PLAN.md` delta: `inventory` schema gains `MATERIAL_ISSUE_APPLIED` (documented
as a concurrency-claim ledger, not a queryable business entity — no dictionary meta tail).

---

## §3 — PROPOSED: `packaging.packaging_qc`

**Referenced by**: `backend/api/src/packaging-qc/packaging-qc.service.ts` (dedicated CRUD route,
real column list below) + read-only joins in `cluster-packaging/src/packaging-lookup.service.ts`,
`cluster-packaging/src/reservation/reservation.service.ts`, `cluster-sales/src/dispatch/
dispatch.service.ts`, `api/src/fg-stock/fg-stock.service.ts`, `api/src/dashboard/
dashboard.service.ts` — six call sites across four clusters. **`KNOWN_DEBT`** entry.

```ts
// packages/data-packaging/src/schema/qc.ts (proposed)
import { index, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { packaging } from "./_schema.js";

export const packagingQc = packaging.table(
  "packaging_qc",
  {
    packagingQcId: dictPk("packaging_qc_id"),
    finishedGoodBatchId: uuid("finished_good_batch_id"), // soft ref (in-schema; add real FK once finished_good_batch_master's exact column is confirmed)
    leakageCheck: varchar("leakage_check", { length: 30 }),
    labelCheck: varchar("label_check", { length: 30 }),
    cartonCheck: varchar("carton_check", { length: 30 }),
    overallResult: varchar("overall_result", { length: 30 }),
    inspectedBy: uuid("inspected_by"),
    inspectionDt: timestamp("inspection_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [index("packaging_qc_batch_idx").on(t.finishedGoodBatchId)],
);
```

```sql
create table packaging.packaging_qc (
  packaging_qc_id uuid primary key default uuidv7(),
  finished_good_batch_id uuid,
  leakage_check varchar(30),
  label_check varchar(30),
  carton_check varchar(30),
  overall_result varchar(30),
  inspected_by uuid,
  inspection_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create index packaging_qc_batch_idx on packaging.packaging_qc (finished_good_batch_id);
```

`docs/PHASE1A_SCHEMA_PLAN.md` delta: `packaging` schema gains `PACKAGING_QC`.

---

## §4 — PROPOSED: `platform.document_registry`

**Referenced by**: `backend/api/src/documents/documents.service.ts` (full CRUD, now
`NotImplementedException`), `api/src/edit/edit.service.ts`'s `documents` field map (exact column
list below, taken from that map), `api/src/notify/email-notifier.service.ts`'s document-expiry
digest (isolated try/catch, lane F5). **`KNOWN_DEBT`** entry.

```ts
// packages/data-reference/src/schema/documents.ts (proposed)
import { date, index, text, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { platform } from "./_schema.js"; // or @core/data-platform's own platform schema handle

export const documentRegistry = platform.table(
  "document_registry",
  {
    documentRegistryId: dictPk("document_registry_id"),
    title: varchar("title", { length: 200 }),
    documentType: varchar("document_type", { length: 50 }),
    entityType: varchar("entity_type", { length: 50 }), // soft ref: which table this document is about
    entityId: uuid("entity_id"),                          // soft ref: that table's row id
    referenceNo: varchar("reference_no", { length: 100 }),
    sourceUrl: text("source_url"),
    fileName: varchar("file_name", { length: 255 }),
    version: varchar("version", { length: 20 }),
    supersedesId: uuid("supersedes_id"),
    issueDate: date("issue_date"),
    expiryDate: date("expiry_date"),
    notes: text("notes"),
    ...metaColumns(),
  },
  (t) => [
    index("document_registry_entity_idx").on(t.entityType, t.entityId),
    index("document_registry_expiry_idx").on(t.expiryDate),
  ],
);
```

```sql
create table platform.document_registry (
  document_registry_id uuid primary key default uuidv7(),
  title varchar(200),
  document_type varchar(50),
  entity_type varchar(50),
  entity_id uuid,
  reference_no varchar(100),
  source_url text,
  file_name varchar(255),
  version varchar(20),
  supersedes_id uuid,
  issue_date date,
  expiry_date date,
  notes text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create index document_registry_entity_idx on platform.document_registry (entity_type, entity_id);
create index document_registry_expiry_idx on platform.document_registry (expiry_date);
```

`docs/PHASE1A_SCHEMA_PLAN.md` delta: `platform` schema gains `DOCUMENT_REGISTRY`.

---

## §5 — PROPOSED: `platform.notification_log`

**Referenced by**: `backend/api/src/notify/email-notifier.service.ts#deliver` (the primary
event-driven notifier — this insert/upsert is what decides whether an email "sent" for real;
`ON CONFLICT (event_id)` dedupes retries), the same service's dead-letter digest, `api/src/
dashboard/dashboard.service.ts`, `cluster-inventory/src/grn/grn.service.ts`'s vendor-variance
notice. **`KNOWN_DEBT`** entry — and the highest-impact one: `drain()`'s own dedup query depends
on this table directly, so the ENTIRE event-driven notifier is dead on any real database, not just
the digest.

```ts
// packages/data-reference/src/schema/notifications.ts (proposed)
import { index, integer, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { platform } from "./_schema.js";

export const notificationLog = platform.table(
  "notification_log",
  {
    notificationLogId: dictPk("notification_log_id"),
    eventId: uuid("event_id"), // dedupe key — ON CONFLICT (event_id) target
    eventType: varchar("event_type", { length: 100 }),
    channel: varchar("channel", { length: 30 }),
    recipient: text("recipient"),
    subject: text("subject"),
    body: text("body"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("notification_log_event_uq").on(t.eventId),
    index("notification_log_status_idx").on(t.status),
  ],
);
```

```sql
create table platform.notification_log (
  notification_log_id uuid primary key default uuidv7(),
  event_id uuid,
  event_type varchar(100),
  channel varchar(30),
  recipient text,
  subject text,
  body text,
  error text,
  attempts integer not null default 0,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index notification_log_event_uq on platform.notification_log (event_id);
create index notification_log_status_idx on platform.notification_log (status);
```

**Adoption note**: `email-notifier.service.ts#deliver` currently inserts
`(notification_log_id, event_id, event_type, channel, recipient, subject, body, status, error,
attempts, updated_dt)` and its `ON CONFLICT (event_id) DO UPDATE` bumps `attempts` — matches this
shape directly, no rename needed.

`docs/PHASE1A_SCHEMA_PLAN.md` delta: `platform` schema gains `NOTIFICATION_LOG`.

---

## §6 — PROPOSED: `platform.relay_cursor`, `platform.relay_inbox`, `platform.relay_package`

**Referenced by**: `backend/api/src/relay/relay.service.ts` (the air-gap store-and-forward sync —
`exportPackage`/`importPackage`/`status` all now `NotImplementedException`, lane F5). Not in
`KNOWN_DEBT` (string-literal error messages, not raw SQL — same reason `approval_matrix`/
`vendor_negotiation`/etc. aren't there either).

The relay service's own doc comment (still present) already specifies the exact shape needed —
reproduced here as the formal proposal:

```ts
// packages/data-reference/src/schema/relay.ts (proposed)
import { bigint, index, jsonb, primaryKey, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { platform } from "./_schema.js";

/** One row per (direction, source_schema) — how far this side has drained that schema's outbox. */
export const relayCursor = platform.table(
  "relay_cursor",
  {
    direction: varchar("direction", { length: 10 }).notNull(), // 'EXPORT' | 'IMPORT'
    sourceSchema: varchar("source_schema", { length: 50 }).notNull(),
    lastSeq: bigint("last_seq", { mode: "bigint" }).notNull().default(0n),
    updatedDt: timestamp("updated_dt", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.direction, t.sourceSchema] })],
);

/** Event dedupe on import — ON CONFLICT (event_id, direction) DO NOTHING re-import safety.
 * NOTE: intentionally not dictPk()/metaColumns() — a dedupe ledger keyed by the event's own id,
 * same rationale as inventory.material_issue_applied above. */
export const relayInbox = platform.table(
  "relay_inbox",
  {
    eventId: uuid("event_id").notNull(),
    direction: varchar("direction", { length: 10 }).notNull(),
    importedDt: timestamp("imported_dt", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.direction] })],
);

/** One row per signed package that crossed the air gap (export OR import), hash-chained. */
export const relayPackage = platform.table(
  "relay_package",
  {
    packageId: dictPk("package_id"),
    direction: varchar("direction", { length: 10 }).notNull(),
    kind: varchar("kind", { length: 10 }).notNull(), // 'EXPORT' | 'IMPORT'
    packageHash: text("package_hash").notNull(),
    prevHash: text("prev_hash"),
    eventCount: bigint("event_count", { mode: "bigint" }).notNull().default(0n),
    ...metaColumns(),
  },
  (t) => [index("relay_package_direction_idx").on(t.direction, t.kind)],
);
```

```sql
create table platform.relay_cursor (
  direction varchar(10) not null,
  source_schema varchar(50) not null,
  last_seq bigint not null default 0,
  updated_dt timestamptz not null default now(),
  primary key (direction, source_schema)
);

create table platform.relay_inbox (
  event_id uuid not null,
  direction varchar(10) not null,
  imported_dt timestamptz not null default now(),
  primary key (event_id, direction)
);

create table platform.relay_package (
  package_id uuid primary key default uuidv7(),
  direction varchar(10) not null,
  kind varchar(10) not null,
  package_hash text not null,
  prev_hash text,
  event_count bigint not null default 0,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create index relay_package_direction_idx on platform.relay_package (direction, kind);
```

**Adoption note**: once these land + `pnpm db:push`, restore `relay.service.ts`'s real
implementation from `integration/fullsystem@db4815f` per its own doc comment.

`docs/PHASE1A_SCHEMA_PLAN.md` delta: `platform` schema gains `RELAY_CURSOR`, `RELAY_INBOX`,
`RELAY_PACKAGE`.

---

## §7 — PROPOSED: `procurement.vendor_negotiation`

**Referenced by**: `backend/api/src/procanalytics/procanalytics.service.ts#listNegotiations`
(now `NotImplementedException`), `api/src/edit/edit.service.ts`'s `vendor-negotiations` field map.
Not in `KNOWN_DEBT` (same string-literal reason as relay/approval_matrix/po_advance_payment).

```ts
// packages/data-procurement/src/schema/negotiation.ts (proposed)
import { index, numeric, text, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { procurement } from "./_schema.js";
import { quotationItems } from "./rfq.js"; // adjust to the actual export location

export const vendorNegotiation = procurement.table(
  "vendor_negotiation",
  {
    vendorNegotiationId: dictPk("vendor_negotiation_id"),
    quotationItemId: uuid("quotation_item_id").references(() => quotationItems.quotationItemId),
    revisedRate: numeric("revised_rate", { precision: 18, scale: 4 }),
    notes: text("notes"),
    recommendation: varchar("recommendation", { length: 30 }),
    ...metaColumns(),
  },
  (t) => [index("vendor_negotiation_quotation_item_idx").on(t.quotationItemId)],
);
```

```sql
create table procurement.vendor_negotiation (
  vendor_negotiation_id uuid primary key default uuidv7(),
  quotation_item_id uuid references procurement.quotation_items(quotation_item_id),
  revised_rate numeric(18,4),
  notes text,
  recommendation varchar(30),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create index vendor_negotiation_quotation_item_idx on procurement.vendor_negotiation (quotation_item_id);
```

`docs/PHASE1A_SCHEMA_PLAN.md` delta: `procurement` schema gains `VENDOR_NEGOTIATION`.

---

## §8 — PROPOSED: `procurement.vendor_dispatch`

**Referenced by**: `procanalytics.service.ts#listVendorDispatches`/`createVendorDispatch` (now
`NotImplementedException`), `edit.service.ts`'s `vendor-dispatches` field map.

```ts
// packages/data-procurement/src/schema/dispatch.ts (proposed)
import { date, index, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { procurement } from "./_schema.js";
import { purchaseOrder } from "./po.js"; // adjust to the actual export location

export const vendorDispatch = procurement.table(
  "vendor_dispatch",
  {
    vendorDispatchId: dictPk("vendor_dispatch_id"),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrder.purchaseOrderId),
    dispatchDate: date("dispatch_date"),
    transporter: varchar("transporter", { length: 200 }),
    docketNumber: varchar("docket_number", { length: 100 }),
    vehicleNumber: varchar("vehicle_number", { length: 30 }),
    ...metaColumns(),
  },
  (t) => [index("vendor_dispatch_po_idx").on(t.purchaseOrderId)],
);
```

```sql
create table procurement.vendor_dispatch (
  vendor_dispatch_id uuid primary key default uuidv7(),
  purchase_order_id uuid references procurement.purchase_order(purchase_order_id),
  dispatch_date date,
  transporter varchar(200),
  docket_number varchar(100),
  vehicle_number varchar(30),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create index vendor_dispatch_po_idx on procurement.vendor_dispatch (purchase_order_id);
```

`docs/PHASE1A_SCHEMA_PLAN.md` delta: `procurement` schema gains `VENDOR_DISPATCH`.

---

## §9 — PROPOSED: `procurement.po_advance_payment`

**Referenced by**: `procanalytics.service.ts#listAdvancePayments`/`createAdvancePayment` (now
`NotImplementedException`), `edit.service.ts`'s `po-advance-payments` field map.

```ts
// packages/data-procurement/src/schema/advance-payment.ts (proposed)
import { index, numeric, text, uuid } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { procurement } from "./_schema.js";
import { purchaseOrder } from "./po.js"; // adjust to the actual export location

export const poAdvancePayment = procurement.table(
  "po_advance_payment",
  {
    poAdvancePaymentId: dictPk("po_advance_payment_id"),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrder.purchaseOrderId),
    amount: numeric("amount", { precision: 18, scale: 4 }),
    reference: text("reference"),
    ...metaColumns(),
  },
  (t) => [index("po_advance_payment_po_idx").on(t.purchaseOrderId)],
);
```

```sql
create table procurement.po_advance_payment (
  po_advance_payment_id uuid primary key default uuidv7(),
  purchase_order_id uuid references procurement.purchase_order(purchase_order_id),
  amount numeric(18,4),
  reference text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create index po_advance_payment_po_idx on procurement.po_advance_payment (purchase_order_id);
```

`docs/PHASE1A_SCHEMA_PLAN.md` delta: `procurement` schema gains `PO_ADVANCE_PAYMENT`.

---

## Summary table

| Table | Schema | Status | `KNOWN_DEBT`? | Owner call sites |
|---|---|---|---|---|
| `approval_matrix` | iam | **ADOPTED** (this lane) | n/a (never listed) | PoService, RfqService (this lane) |
| `login_history` | iam | proposed | yes | auth.service.ts, AuditService |
| `material_issue_applied` | inventory | proposed (load-bearing) | yes | ConsumptionService, MixingService.abortSession |
| `packaging_qc` | packaging | proposed | yes | PackagingQcService + 5 read call sites |
| `document_registry` | platform | proposed | yes | DocumentsService, edit.service.ts, EmailNotifierService |
| `notification_log` | platform | proposed | yes | EmailNotifierService (primary notifier), dashboard, grn.service.ts |
| `relay_cursor` / `relay_inbox` / `relay_package` | platform | proposed | no (string literals) | RelayService |
| `vendor_negotiation` | procurement | proposed | no (string literals) | ProcAnalyticsService, edit.service.ts |
| `vendor_dispatch` | procurement | proposed | no (string literals) | ProcAnalyticsService, edit.service.ts |
| `po_advance_payment` | procurement | proposed | no (string literals) | ProcAnalyticsService, edit.service.ts |

Adopting any PROPOSED entry: add it to `docs/PHASE1A_SCHEMA_PLAN.md`'s table map (owner-approved),
add the drizzle file to the matching `packages/data-<cluster>/src/schema`, run `pnpm db:push`,
delete the call site's `NotImplementedException`/refusal guard and restore its real logic, and —
for the five currently in `backend/test-support/schema-guard.test.ts`'s `KNOWN_DEBT` — delete that
entry (the guard's second test asserts no stale entries remain, so this is enforced, not just a
reminder).
