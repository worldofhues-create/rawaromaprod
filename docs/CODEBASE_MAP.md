# Raw Aroma — Codebase Map

End-to-end navigation map for the Raw Aroma Phase-1A platform (formula-protected perfume manufacturing). Written for a developer or AI session that needs to navigate and safely extend the code. Paths are relative to `app/` unless absolute.

---

## 1. System shape

Raw Aroma is a **pnpm monorepo, single-Postgres modular monolith**. Layout: `packages/data-*` (one Drizzle package per PG schema) + `packages/data-kernel` (`@core/data-kernel`, column/table factories) define the data layer; `backend/backend-kernel` (`@core/backend-kernel`) is the domain-free reusable NestJS core (config, DB clients, edge guards/interceptors/filter, event bus, outbox, flags, health); `backend/cluster-*` are 13 self-contained NestJS feature modules (one per business domain, each bound to its own PG schema); `backend/api` is the composition root — a **Fastify** HTTP app that imports the kernel + all clusters + ~15 cross-cutting BFF modules; `web/` is a single-file vanilla-JS PWA. Two processes: **api** (HTTP, optionally boots the worker in-process on a free single dyno) and **worker** (no HTTP; drains outboxes onto the event bus). A request flows **request-id → CORS → JWT verify+portal-audience → RBAC AND-check → flag kill-switch → per-arg Zod pipe → handler → material-mask → `{data,meta,error}` envelope**; any throw exits through one `AllExceptionsFilter`. Cross-cluster communication is exclusively **(a) public-api read ports** (a TS interface + `Symbol` DI token per cluster) and **(b) a transactional outbox** — `recordOutbox(tx, schema.outbox, event, payload)` inserts an event row inside the domain transaction; the worker's `OutboxPublisher` polls `published_at IS NULL` every 2s and fans out on an in-proc `EventBus` (at-least-once → subscribers must be idempotent). Clusters never cross schema boundaries directly: each is handed only its own schema-bound Drizzle client, and all cross-schema references are **id-only "soft refs"** (plain uuid, no FK).

---

## 2. Layer by layer

### 2.1 Kernel + edge (`backend/backend-kernel/src`, `@core/backend-kernel`)

`BackendKernelModule.forRoot(options)` assembles Config, Drizzle, Jwt, Flags, Outbox, Health. Both `api` and `worker` import it; only the **worker** passes `outbox.withPublisher: true` + `enableScheduling` (adds `ScheduleModule`).

| Concern | File | Notes |
|---|---|---|
| Config contract | `config/config.schema.ts` | Single zod env schema. `DATABASE_URL`, `REDIS_URL?`, `JWT_SECRET`(min32)/TTLs/ISSUER, `OUTBOX_POLL_MS`(2000)/`OUTBOX_BATCH`(100), `RUN_WORKER_IN_PROCESS`, `CORS_ORIGINS`, `FORMULA_DATABASE_URL`, `FORMULA_KEK`. Add an env var HERE before reading it anywhere. |
| Config service | `config/config.service.ts` | Parses `process.env` once at construction; throws readable aggregate on bad env; `get/all/isProd`. |
| DB clients | `db/drizzle.module.ts` + `db/drizzle.tokens.ts` | `@Global`. One postgres-js pool (max 10) as `PG_CLIENT`; kernel provides ONLY `IAM_DB` + `PLATFORM_DB`. Each `@ra` cluster provides its own `<CLUSTER>_DB` token in its module. |
| Guards (global, ordered) | `edge/jwt-auth.guard.ts` → `edge/permissions.guard.ts` → `edge/flag.guard.ts` | See §4 RBAC. Registered via `APP_GUARD` in `api/src/app.module.ts` in exactly this order. |
| JWT | `edge/jwt.service.ts` | jose HS256. Access claims `sub`/`portal`(aud)/`roles`/`perms`/`pv`/`sid`; refresh `sub`/`sid`/`typ`. Maps `JWTExpired`→`AUTH_TOKEN_EXPIRED`. |
| Envelope | `edge/response-envelope.interceptor.ts` | Wraps output in `{data,meta,error}`; hoists `{items,nextCursor}` → `meta.cursor` + `data=items`; stamps `meta.requestId`. |
| Error exit | `edge/all-exceptions.filter.ts` | `DomainError`→own code/status; `ZodError`→`VALIDATION_FAILED` 422; `HttpException`→mapped; else `INTERNAL_ERROR` 500 (message hidden). |
| Validation | `edge/zod-validation.pipe.ts` | Per-arg `new ZodValidationPipe(schema)`; NOT a global class-validator pipe. |
| Errors | `edge/domain-error.ts` | The one error type services throw. Static helpers `unauthorized/forbidden/notFound/conflict/featureDisabled`. |
| Request id | `edge/request-id.middleware.ts` | Reuses/mints `x-request-id`; applied to `'*'`. |
| Principal | `edge/principal.ts` | `AuthPrincipal{userId,portal,roles,permissions,permVersion,sessionId}`. |
| Rate limit | `edge/rate-limit.guard.ts` | PLACEHOLDER in-memory limiter, NOT registered globally. Redis is the Stage-1 swap. |
| Flags | `flags/flags.service.ts` | In-memory `FlagSnapshot`; `load()` on boot, `set()` on `platform.flag.changed`; `isEnabled = state !== 'off'` (fail-open on unknown). |
| Events | `events/event-bus.ts`, `events/outbox.recorder.ts`, `events/outbox.publisher.ts`, `events/outbox.registry.ts` | See §4 outbox. |
| Health | `health/health.controller.ts` | `@Public GET /health` → `SELECT 1`. |
| Metadata keys | `decorators/metadata.keys.ts` | `META_PUBLIC/PERMISSIONS/PORTALS/FLAG`. |

**Boot:** `api/src/main.ts` — `NestFactory` on `FastifyAdapter(trustProxy)`, CORS fail-closed in prod, shutdown hooks; if `RUN_WORKER_IN_PROCESS` it also boots `WorkerModule` as an application context in the same process. `api/src/worker.ts` — `createApplicationContext(WorkerModule)`, no HTTP. `api/src/worker.module.ts` — `provideOutboxSources` lists 10 clusters (iam, platform, masterdata, procurement, inventory, quality, formula, production, packaging, sales) + `NotifyModule`.

### 2.2 Data schemas (`packages/data-*`, `@core/data-kernel`)

**One package = one PG schema.** `_schema.ts` exports `pgSchema('<name>')`; `index.ts` is the drizzle.config barrel; `crosscutting.ts` exports `outbox` + `auditEvents` from the kernel factories. **Two column conventions — do not mix per table:** DICTIONARY tables use `dictPk('<entity>_id')` + `metaColumns()` (`status` varchar30 IS the lifecycle, `created_dt/updated_dt`, `created_by/updated_by` are VARCHAR(255) **usernames**), NO soft-delete; APP-NATIVE tables (`data-iam`, `data-platform` only) use `baseColumns()` (uuidv7 id, `created_at/updated_at`, `created_by/updated_by` uuid) + optional `softDelete()`.

Kernel factories (`packages/data-kernel/src`): `columns.ts` (`baseColumns`, `softDelete`, `money`, `dictPk`, `metaColumns`), `outbox.ts` (`outboxTable(schema)` → `{id,type,payload jsonb,aggregate_id,occurred_at,published_at,attempts,seq bigint-identity}` + partial index `WHERE published_at IS NULL`), `audit.ts` (`auditTable(schema,{hashChain})`), `uuid.ts` (`uuidv7()` + `UUIDV7_SQL`).

**Dual-ownership warning:** `data-iam`+`data-org` BOTH target `pgSchema('iam')`; `data-platform`+`data-reference` BOTH target `pgSchema('platform')` — different table sets in one PG schema. Verify a new table name isn't taken by the sibling package.

Per-schema inventory (12 PG schemas + kernel):

| Schema (package) | Key tables |
|---|---|
| **iam** (`data-org` dict / `data-iam` app-native) | dict: org_group/type_master, org_master, org_relationship, business_unit_master, user_master, role_master, permission_master, role_permission_mapping, user_role_mapping, location_authority_master, login_history. app-native: users, credentials, otps, sessions, roles, permissions, user_roles, consents |
| **platform** (`data-reference` dict / `data-platform` app-native) | dict: country/currency/language/timezone/address/geo_location/contact_master, document_type/document_master, uom_type/uom/uom_conversion, brand_master. app-native: master_types, master_items, geo_regions, themes, config, checklist_templates, flags, flag_states, flag_audit, notification_log |
| **location** (`data-location`) | location_type/location_master; warehouse_type/warehouse/floor/zone_type/zone/rack/shelf/bin_master; storage_location_type/status/storage_location_master (full warehouse→bin FK hierarchy) |
| **masterdata** (`data-masterdata`) | material_type/category/subcategory_master, material_group, **material**, rm_alias, material_qc_specifications, material_storage_rules, **material_ageing** (has `inventory_batch_id`+`quantity_on_hand`+ageing buckets — the existing stock-snapshot pattern to mirror) |
| **procurement** (`data-procurement`) | vendor_details/contact/rm_mapping, stock_requirement(+items), purchase_request(+items+approval), rfq_master(+items+vendor_mappings), quotations(+items), purchase_order(+items), po_approval_order, vendor_po_ack, vendor_credit_* |
| **inventory** (`data-inventory`, 19 tbls) | gate_entry_master(+documents), grn_master(+items+container), rm_batch_master, batch_container_mappings, batch_genealogy_history, inventory_status_master, **inventory_batch** (RM on-hand ledger; `quantity_on_hand`), inventory_transaction_type_master, **inventory_transaction** (movement ledger), inventory_event_history, stock_adjustment, stock_audit(+details), **stock_reservation** (keyed to `inventory_batch_id` FK — RM-only), stock_transfer, expiry_tracker |
| **quality** (`data-quality`, 7) | qc_parameter_master, qc_inspections, qc_result_details, qc_attachments, qc_disposition, qc_sample_retention, qc_capa |
| **production** (`data-production`) | production_plan(+items), production_order(+ingredients), material_pick_list(+items), material_issue(+item; `issued_qty` BOOLEAN), secure_mixing_session, mixing_step_log, oil_batch_master(+consumption+event_history), production_qc, oil_batch_qc_history |
| **packaging** (`data-packaging`) | product_category/product_master, **product_sku** (FG identity), packaging_material_master, packaging_bom_master, package_order(+item; `issued_qty` BOOLEAN), filling_session(+details), **finished_good_batch_master** (`produced_qty`, `product_sku_id`, mfg/expiry), **finished_goods_batch_consumption** |
| **sales** (`data-sales`) | customer_master, transporter_master, sales_order(+items), **dispatch_master**, **dispatch_items** (`finished_good_batch_id` soft ref, `dispatched_qty`; index `dispatch_items_fg_batch_idx`). Audit is hash-chained |
| **formula** (`data-formula`, vault) | formula_type/master, formula_version, **formula_ingredients** (enc_payload/enc_iv/enc_tag), formula_stage(+ingredients, encrypted), formula_vault, formula_access_policy, formula_approval, formula_change_log, formula_copy_request, formula_document_mapping, formula_event_hist. Audit is hash-chained. Lives on its OWN connection (`FORMULA_DATABASE_URL`, `ra_vault` role) |
| **workflow** (`data-workflow-state`) | workflow_state_master, workflow_transaction_master |

**Quantities** are `numeric(18,4)` (coerce to string on insert); **money** uses `money()` (bigint minor units + char(3)); **UOM** is always a soft `uom_id` → `platform.uom`. **Locked oddities:** `package_order_item.issued_qty`, `production_order_ingredients.issued_qty`, `material_issue_item.issued_qty` are **BOOLEAN** (dictionary-locked, not a quantity).

### 2.3 The 13 clusters (`backend/cluster-*`)

Uniform shape: `@Global()` module mints its own `<CLUSTER>_DB` (`drizzle(sql,{schema})` over `PG_CLIENT`), wires services+controllers, provides+exports ONE `<CLUSTER>_LOOKUP` port from `public-api.ts` (interface + `Symbol` token + `useExisting` impl). Controllers: `@Permissions('<schema>:<table>:read|write')` + `@Body(new ZodValidationPipe(dto))` + `@CurrentUser() principal`. Cursor pagination everywhere (`order by pk desc, limit+1` → `{items,nextCursor}`).

**Foundation / config plane:**
- **cluster-org** (`@ra/cluster-org`, iam) — **the production auth path**. `auth.service.ts`: login/refresh/setPassword/me against `iam.user_master`; Argon2id verify; flattens roles+perms via mapping joins; mints JWT `portal='owner'`; `recordSession` → `iam.login_history` (sha256 of refresh). **Refresh is stateless** (re-mint, no reuse-detection). Controllers: Auth (`POST /auth/login`,`/auth/refresh` public; `POST /auth/users/:id/password`; `GET /me`), Org CRUD, Security CRUD (users/roles/permissions/role-permissions/user-roles/location-authorities). Port `ORG_LOOKUP`.
- **cluster-identity** (`@core/cluster-identity`) — **RETIRED/dead code**, not imported anywhere. RA auth moved to cluster-org.
- **cluster-platform** (`@core/cluster-platform`, platform) — flags/geo/masters. `GET /v1/flags/snapshot` (public), `PUT /v1/admin/flags/:key`. Port `PLATFORM_LOOKUP`; exports `PlatformFlagsService` (kill-switches).
- **cluster-reference** (`@ra/cluster-reference`, platform) — 13 masters (uom/brand/country/currency/language/timezone/address/geo/contact/document). **Perm prefix is `platform:` not `reference:`.** Port `REFERENCE_LOOKUP`.
- **cluster-location** (`@ra/cluster-location`, location) — full warehouse→bin hierarchy + storage locations. Perm `location:`. Port `LOCATION_LOOKUP` (`findStorageLocation`). **Emits NO outbox events** (config-only) — consumers need a startup snapshot or the cold LOOKUP.
- **cluster-masterdata** (`@ra/cluster-masterdata`, masterdata, `@Global`) — classification + material + rm_alias. Perm `masterdata:`. Emits the ONLY foundation events: `masterdata.material.created`, `masterdata.alias.created`. Port `MASTERDATA_LOOKUP` (`findAliasesForMaterials` — used by the masking interceptor). Capability perm `masterdata:material:reveal` (unguarded; masking exemption).

**Inbound supply chain:**
- **cluster-procurement** (procurement) — PR→RFQ→quotation→PO lifecycle. `po.service.ts` (DRAFT→APPROVED→ISSUED→ACKNOWLEDGED, SoD: creator≠approver), `requirement.service.ts`, `rfq.service.ts`. Event `procurement.po.issued`. Port `PROCUREMENT_LOOKUP`.
- **cluster-inventory** (inventory) — **the reference ledger.** `inventory.service.ts::createInventoryTransaction()` writes `inventory_transaction` + `inventory_event_history` + applies a signed delta to `inventory_batch.quantity_on_hand` in ONE tx (`isOut` regex `ISSUE|OUT|CONSUME|PICK|DISPATCH|REMOVE`). `stock.service.ts` (reservation/adjustment/audit/transfer/expiry — reservation just inserts a row, does NOT touch on-hand, NO ATP). `batch.service.ts::releaseRmBatch()` (manual projection of an rm_batch into the live ledger). `grn.service.ts` (GRN + rm_batch spawn + Step-18 variance). Events `inventory.grn.created`, `inventory.batch.created`. Port `INVENTORY_LOOKUP`.
- **cluster-quality** (quality) — QC inspections/results/disposition. `inspections.service.ts::dispose()` emits `quality.qc.passed/failed/hold` (REWORK emits nothing). NO automatic inventory mutation. Port `QUALITY_LOOKUP`.

**Make-to-ship chain:**
- **cluster-formula** (formula, vault) — **the crown jewel.** `vault.service.ts::decryptVersion()` (APPROVED-only else Forbidden) + `writeAudit()` (advisory-lock-serialized, hash-chained). `crypto/kms.port.ts` (`KMS_PORT` — `wrapDek/unwrapDek`; `EnvKmsAdapter` reads `FORMULA_KEK`). Events `formula.version.approved`, `formula.copy.approved`. Port `FORMULA_LOOKUP` (`getFloorView` alias-masked; `resolveManufacturingInstruction` floor code + quantity; `resolvePickList` / `resolveManufacturingLines` keyed material reference (`material-ref.ts`) + quantity — never material_id). The main app box reaches the Vault only through `VaultApiClient` (`vault-port.ts`, signed internal HTTP to vault-api; `VAULT_PORT` = cluster-production's `ProductionVaultPort`, which resolves the keyed references against the main DB's masterdata) and never composes `FormulaModule` or opens a formula-DB connection.
- **cluster-production** (production) — `planning.service.ts::createOrder()` reads the order's pick list over `VAULT_PORT.resolvePickList` (`vault/production-vault-port.ts`: Vault's keyed material references -> this DB's material ids; 403 if version not approved), expands BOM. Events `production.order.created`, `production.materials.issued`, `production.oil_batch.created`, `production.qc.recorded`. Port `PRODUCTION_LOOKUP`.
- **cluster-packaging** (packaging) — catalog + package-order + filling + `batch.service.ts::produceFinishedGoodBatch()` (inserts `finished_good_batch_master`, emits `packaging.fg_batch.created` — **creates no stock row**). Events `packaging.order.created`, `packaging.filling.done`, `packaging.fg_batch.created`. Port `PACKAGING_LOOKUP` (`getFinishedGoodBatch` → returns `producedQty`+`productSkuId`+`status`).
- **cluster-sales** (sales) — sales_order → confirm → dispatch. `dispatch/dispatch.service.ts::createDispatch()` inserts header+lines, emits `sales.dispatch.created` **payload `{dispatchId, salesOrderId}` only** (no lines/qty). **No qty validation, no FG-batch check, no decrement.** Events `sales.order.created/confirmed`, `sales.dispatch.created`. Port `SALES_LOOKUP`.

**EventBus subscribers today:** only `FlagsService` (flag cache) + the notify/engagement wildcard sink. **NOTHING subscribes to `packaging.fg_batch.created` or `sales.dispatch.created`** — these fan out to nothing that touches stock.

### 2.4 BFF / app modules (`backend/api/src/*`)

Cross-cutting modules that compute what cluster CRUD lacks. Each is a thin Controller+Service injecting `@Inject(PG_CLIENT)` and running **raw cross-schema SQL** (deliberately bypasses Drizzle to join across the schema-per-cluster single Postgres). Wiring a new one = one import line in `app.module.ts`.

| Module | Route(s) | Purpose |
|---|---|---|
| `inventory-view` | `GET /v1/inventory-availability` (`inventory:inventory_batch:read`) | **THE ATP template.** Per-batch RM `available = on_hand − open reservations`, FEFO-ordered (expiry asc nulls last). |
| `planning` | `GET /v1/reorder-suggestions` (`procurement:stock_requirement:read`) | Per-material `available` vs reorder level. Aggregate netting pattern. |
| `edit` | `PATCH /v1/masters/:resource/:id` | Guarded whitelist REGISTRY (~55 resources incl. `reservations`, `dispatches`). Only whitelisted camel→snake cols patchable; per-resource perm checked in-service. `finished_good_batch` is NOT in the registry. |
| `search` | `GET /v1/search?resource=&q=` | Whitelist of ~24 list endpoints; `t::text ilike`. |
| `dashboard` | `GET /v1/dashboard`,`/v1/alerts`,`/v1/notifications`,`/v1/trace/finished-good/:id` | Big cross-cluster read; already sums `finished_good_batch_master.produced_qty` (fgAgg) + joins `dispatch_master`; self-masks. Best FG-side join reference. |
| `procanalytics` | `/v1/vendor-*`, `/v1/approval-matrix`, ... | Procurement analytics. |
| `geo`/`orgunits` | `/v1/geo-regions`, `/v1/organizations` | Raw-SQL CRUD for tables that don't fit the edit registry. |
| `dispatchdocs` | `GET/POST /v1/dispatch-documents` (`sales:dispatch_master:write`) | Challan/invoice/e-way/POD chain. Dispatch-side write pattern. |
| `documents` | `/v1/document-registry` | Versioning via `supersedes_id`. |
| `packaging-qc` | `/v1/packaging-qc` (`packaging:finished_good_batch_master:read/write`) | |
| `audit` | `/v1/formula-access-audit`, `/v1/login-history` | |
| `crypto` | `POST /crypto/handshake`, `POST /rpc` (both `@Public`) | The encrypted tunnel (§4). |
| `notify` | no routes (worker) | `EmailNotifierService.drain()`+`scan()` — the ONLY outbox consumer; writes `platform.notification_log`. No stock mutation. |
| `masking` | global interceptor | `MaterialMaskingInterceptor` (§4). |

Read-model conventions: response is always `{items,nextCursor}` (nextCursor always null so far); `SELECT ... as "camelCase"`; limit clamp `Math.min(Math.max(1,limit),CAP)`; return `materialId` (never a real material name) so the global interceptor masks it.

### 2.5 Frontend PWA (`web/`)

Single ~2000-line IIFE at `web/app.js` (no build, no framework, ES5-style vanilla JS, inline styles keyed to CSS variables). `index.html` (33-line shell) loads `/qrcode.js` then `/app.js`. `sw.js` is offline-first (cache `ra-shell-v67`; network-first for navigations + app.js; **never caches the API** — `:3000`/`/v1/`/`/auth/`). All backend traffic goes through **one function** `tunnel(path,opts)` (window.RA.tunnel) — ECDH handshake then AES-GCM-sealed POST to `/rpc`; auto-retry 3× + silent `/auth/refresh` on 401.

The UI is **data-driven by config maps keyed by the exact REST endpoint path string**: `ROLES` (10 role portals, `nav=[[navKey,label,icon,endpoint,masked?]]`), `COLS` (column lists), `DETAIL` (drill-downs), `EDIT` (PATCH-able resources), `ACTIONS` (per-row buttons), `CREATE`/`CREATE_DOC` (modals), `PRINTABLE`. `loadView()`→`paintResults()` render a generic table; `openCreate/openEdit` build modals from `{n,l,t,req,fk,fv,fl,en,...}` field descriptors validated by `validateField()`. Role comes from the JWT (`enterPortal` decodes `roles[0]`), never self-picked. **Bump `sw.js` CACHE on any shell change** or clients stay on old app.js. Modals append to `document.body` so you MUST call `setTheme()` after building one.

---

## 3. Conventions cheat-sheet

**New table + migration.** Add the table to the matching `packages/data-*/src/schema/*.ts` (DICTIONARY convention: `dictPk('<x>_id')` + `...metaColumns()`; qty `numeric(18,4)`; UOM soft `uom_id`; cross-schema refs = plain uuid + `// soft ref → <schema>.<table>` comment + index; in-schema parent→child gets a real `.references()`). Export from the package `index.ts` barrel. Run `pnpm db:push` (`scripts/db-push.ts`). **GOTCHA (§4): `db:push` SKIPS any schema that already has ≥1 table** — so a new table in an already-populated schema (e.g. `packaging`) will NOT be created; write a one-off `CREATE TABLE` script (see `scripts/create-*-table.cjs` for the pattern) or drop/recreate in dev.

**Cluster CRUD endpoint.** Add feature dir (svc+controller) under `backend/cluster-<x>/src/`, register in the cluster module, add zod DTOs to `cluster-*.dtos.ts`. Controller: `@Permissions('<schema>:<table>:read'|':write')`, `@Body(new ZodValidationPipe(dto))`, `@CurrentUser() principal`. Stamp `createdBy/updatedBy=principal.userId`, `status:'ACTIVE'`. Coerce numerics to string (`num()`/`String(n)`), timestamps `new Date(iso)`, date columns as ISO strings, PKs `uuidv7()`. Cursor-paginate.

**BFF read-model.** New `<name>.module.ts` (Controller+Service, inject `PG_CLIENT`), raw tagged-template SQL crossing schemas, return `{items,nextCursor}`, `SELECT ... as "camelCase"`, clamp limit. **One import line in `api/src/app.module.ts`.** Reuse an existing cluster permission rather than seeding a new one.

**Frontend feature.** Add entries keyed by the endpoint path: `ROLES[role].nav` (nav item), `COLS[endpoint]` (columns — generic table works without it), `CREATE[endpoint]` or `CREATE_DOC[endpoint]` (form), `EDIT[endpoint]` (PATCH), `ACTIONS[endpoint]` (row button `{label,perm,tone,when(r),run(r)|path(r)+body}`), `DETAIL[endpoint]`, `PRINTABLE[endpoint]`. Never call `fetch()` — always `tunnel(path,{method,body})`, read `res.json.data`. Gate with `can('module:resource:action')`. After a mutation call `loadView()` + `toast()`. Bump `sw.js` CACHE.

**DTO coercion.** Zod schemas from `@core/contracts`; `z.infer` aliases; per-arg pipe. Numerics stored as strings.

**Auth / permissions.** Throw `DomainError` (with a `@core/contracts` ErrorCode), not raw `HttpException`. `@Permissions('domain:resource:action', …)` requires ALL (AND). `@Public` bypasses JWT; `@Portal(...)` narrows audience. **Permission strings must match `scripts/ra-permissions.ts` EXACTLY** (263-entry grep-generated catalog seeded into `iam.permission_master`) — regenerate + re-run `scripts/db-seed.ts` (RBAC seed) after adding a guarded route, else it's grantable to no role but `owner`. Role→perm matrix in `scripts/ra-roles.ts` (10 roles). **All-access role is `owner`** (holds every perm explicitly); the `super_admin` short-circuit in `permissions.guard.ts` is latent.

**Masking.** Return `materialId` (literal field name) → the global interceptor nulls it + attaches the RM alias for non-reveal callers. To show material identity, gate the whole route behind `masterdata:material:reveal` / `formula:actual:read` and self-mask in the service.

**Outbox events.** NEVER call `EventBus.publish()` from a request path. Inside `db.transaction`, after the domain writes, call `recordOutbox(tx, <schema>Schema.outbox, defineEvent('<schema>.<entity>.<verb>', zod), payload, aggregateId)`. Payload carries **ids/soft-refs only** (never row bodies/qty/material lists) — consumers re-read child rows by aggregate id. Validate payload against the event zod BEFORE calling. Register a new cluster in the drain loop = one `{cluster,dbToken,table}` spec in `worker.module.ts::provideOutboxSources([...])`.

**Cross-cluster ports.** Consume another cluster ONLY via its `public-api.ts` interface + `Symbol` token, injected by `@Inject(TOKEN)`. Deep imports into a cluster's service/schema are forbidden (dependency-cruiser enforced). Adding a cross-cluster read = add a method to the Lookup interface + implement in the `XxxLookupService`.

---

## 4. Cross-cutting mechanisms

**Material masking.** `api/src/masking/material-masking.interceptor.ts` runs on every HTTP response, registered AFTER `ResponseEnvelopeInterceptor` so it executes FIRST on the response path (Nest reverses interceptors on the way out). Bypass only if principal holds `masterdata:material:reveal`; else `mask.ts::maskMaterialIds` recursively nulls every field literally named `materialId` and attaches `rmAliasId`/`aliasName` via `MASTERDATA_LOOKUP.findAliasesForMaterials`. **Fail-closed** (missing/bad principal still masks). Only recurses plain objects+arrays (Date/Buffer untouched). Floor-facing endpoints must key on `materialId` (not `matId`) for masking to catch them.

**Encrypted tunnel.** `api/src/crypto/`: `POST /crypto/handshake` (ECDH P-256 → HKDF-SHA256 → AES-256-GCM channel key, 8h TTL, in-memory under a random keyId) then `POST /rpc` decrypts an opaque blob to `{method,path,body,token}` and **replays it internally via `fastify.inject()`** so the real route's guards/masking/envelope all run, then seals the reply. The network tab sees only ciphertext; JWT travels sealed inside. All `/v1` routes are reachable through `/rpc` with no extra wiring. Frontend `tunnel()` is the client half.

**RBAC.** JWT-carried, **DB-free at request time**: cluster-org mints an HS256 access token (15m) with flattened `roles`+`perms`; edge guards enforce it in order — `JwtAuthGuard` (Bearer verify, portal audience must be a known PORTAL, `@Portal` narrowing, attaches `AuthPrincipal`) → `PermissionsGuard` (`@Permissions` AND-check; `owner` holds all) → `FlagGuard` (`@RequiredFlag` → 503 if flag `off`). Perms ride in the token; no per-request DB hit. Seeded from `scripts/ra-permissions.ts` (263) × `scripts/ra-roles.ts` (10 roles). Invariants asserted by `db-seed.ts`: only `owner` holds `formula:actual:read`; only owner+admin hold `iam:user_role_mapping:write`; no operational role gets any `iam:*`.

**Vault / KmsPort seam.** `cluster-formula/src/vault.service.ts` is the single decrypt chokepoint. Ingredients are AES-GCM sealed under a per-formula DEK wrapped by the KEK via `KMS_PORT` (`crypto/kms.port.ts`; Phase-1 `EnvKmsAdapter` from `FORMULA_KEK`; swap-in point for real KMS/HSM). Every decrypt is APPROVED-only and writes a hash-chained audit row (advisory-lock-serialized) in the SAME tx — rolls back if the audit insert fails. Real `material_id` NEVER leaves the vault except via the owner/policy-gated `getActualFormula`; production reads (pick list, manufacturing instruction) cross the wire as keyed material references and quantities only.

**Migrations.** `scripts/db-push.ts` applies all 12 PG schemas using drizzle-kit's PROGRAMMATIC api (empty-snapshot → target-snapshot diff = pure CREATE DDL, executed directly; the CLI introspector is broken under this drizzle version). Prereqs (`uuidv7()`, `pg_trgm`, `postgis`) installed per connection first. `formula` pushes to `FORMULA_DATABASE_URL` (vault role) when set. **THE GOTCHA:** `pushGroup` checks `information_schema.tables` and **skips any schema that already has tables** (idempotency at schema granularity) — re-runs are safe but a NEW table added to an already-populated schema is silently ignored. Ship such tables via a standalone `CREATE TABLE IF NOT EXISTS` script (pattern: `scripts/create-document-registry-table.cjs`, `create-packaging-qc-table.cjs`). Refuses data-loss statements unless `ALLOW_DATA_LOSS=1`. `SCHEMA_GROUPS` in `scripts/db-schema-groups.ts`.

---

## 5. Finished-goods stock — build plan

**Goal:** ATP `available = produced − dispatched − reserved` for finished goods. **Grounding:** produced & dispatched already exist as data; **reserved does not exist for FG, no ATP view exists, and dispatch neither validates nor decrements.** `inventory.stock_reservation` is bound to `inventory_batch_id` (RM-only FK) and cannot hold an FG batch. `inventory_batch` is RM-oriented (no `product_sku_id`/`finished_good_batch_id`), so **do NOT try to represent FG in the RM inventory ledger.** FG lives in `packaging` (produced) + `sales` (dispatched); model FG stock as a **derived/projected balance**, not a new on-hand ledger.

**5.1 New table `packaging.finished_good_reservation`** — mirror `stock_reservation` exactly but key to FG.
- File: `packages/data-packaging/src/schema/batch.ts` (or a new `reservation.ts` in the same package), exported from `packages/data-packaging/src/index.ts`.
- Shape (DICTIONARY convention): `dictPk('finished_good_reservation_id')`, `finished_good_batch_id` **in-schema FK** → `finished_good_batch_master`, `reserved_qty numeric(18,4)`, `reserved_for_document_id` (soft ref → `sales.sales_order`/`sales_order_item`), `reserved_dt`, `released_dt`, `...metaColumns()` (`status`). Active reservation = `released_dt IS NULL`.
- **Migration:** the `packaging` schema is already populated, so `db:push` will SKIP it — ship this via a standalone `scripts/create-finished-good-reservation-table.cjs` (`CREATE TABLE IF NOT EXISTS`, follow `scripts/create-packaging-qc-table.cjs`).
- CRUD service+controller in `cluster-packaging` (or `cluster-sales`); gate reads with existing `packaging:finished_good_batch_master:read`, writes with a new/existing packaging perm — if new, add to `scripts/ra-permissions.ts` + grant in `scripts/ra-roles.ts` (sales+packaging+warehouse) + re-run RBAC seed. Add a `Release` action (PATCH `released_dt`/`status`) via the `edit` REGISTRY (`api/src/edit/edit.service.ts`).

**5.2 BFF fg-stock read-model** — the ATP endpoint. Copy `api/src/inventory-view/inventory-view.service.ts`.
- New `api/src/fg-stock/fg-stock.module.ts` + `.service.ts` (inject `PG_CLIENT`), one import line in `api/src/app.module.ts`.
- Raw SQL per FG batch: `produced = finished_good_batch_master.produced_qty`; `dispatched = coalesce(sum(sales.dispatch_items.dispatched_qty),0)` grouped by `finished_good_batch_id`; `consumed = coalesce(sum(packaging.finished_goods_batch_consumption.consumed_qty),0)`; `reserved = coalesce(sum(finished_good_reservation.reserved_qty) where released_dt is null,0)`; `available = greatest(0, produced − dispatched − consumed − reserved)`. LEFT JOIN grouped subqueries, `::float`, FEFO-order by `expiry_date asc nulls last`. Return `finishedGoodBatchId`/`productSkuId` + `producedQty`/`dispatchedQty`/`reservedQty`/`availableQty`. **Sum only within a single `uom_id`** (UOM is a soft ref, not normalized).
- `GET /v1/fg-stock` (or `/v1/fg-availability`) gated `packaging:finished_good_batch_master:read`. FG batches carry no `materialId`, so masking is a no-op.

**5.3 Over-dispatch guard + decrement** — `backend/cluster-sales/src/dispatch/dispatch.service.ts::createDispatch()` (verified: currently inserts header+lines + emits event, NO validation/decrement).
- Inside the existing tx, before insert, for each line resolve the FG batch's available qty. Because FG stock is derived across schemas, either (a) inject `PACKAGING_LOOKUP` (`getFinishedGoodBatch` → `producedQty`,`status`) — but that returns only produced, not net available; or (b) expose a new method on `PACKAGING_LOOKUP` / a fg-stock lookup port returning net-available per batch, and reject with `DomainError.conflict` if `dispatchedQty > available`. Ports are the sanctioned cross-cluster call — do NOT raw-join `sales`→`packaging` inside the cluster.
- Decrement: FG is a derived balance, so a "decrement" is implicit once `dispatch_items` rows exist (the read-model nets them). No FG on-hand column to update. If a materialized on-hand is later desired, follow the ledger-in-one-tx convention (`inventory.service.ts::createInventoryTransaction`).

**5.4 Dispatch event payload enrichment** — `backend/cluster-sales/src/sales.events.ts`.
- `salesEvents.dispatchCreated` payload is `{dispatchId, salesOrderId}` (verified — no lines). If an async FG projector/subscriber is added, either enrich the payload with line summaries (`[{finishedGoodBatchId, dispatchedQty}]`) OR have the subscriber re-read `dispatch_items` by `dispatchId`. Keep to the convention (ids/soft-refs) unless line qty is genuinely needed downstream. **No consumer subscribes to `sales.dispatch.created` today** — one must be added if you want event-driven FG behavior; otherwise the read-model computing on the fly needs no subscriber.

**5.5 Frontend** — `web/app.js`, four touch-points.
- **FG list columns:** extend `COLS['/v1/finished-good-batches']` (currently `['batchNumber','producedQty','manufacturingDate','status']`) to include `dispatchedQty`/`reservedQty`/`availableQty`; `fmt()` already colours `available`. Or add a new nav item + `COLS` for the `/v1/fg-stock` view (reuse the `/v1/inventory-availability` column convention).
- **Fix the dispatch placeholder:** the sales-orders `Dispatch` action currently does `tunnel('/v1/finished-good-batches?limit=1')`, hardcodes `items:[{finishedGoodBatchId:b.finishedGoodBatchId, dispatchedQty:1}]` and `vehicleNumber:'TN-22-0001'`. Replace with a `CREATE_DOC`-style modal: pick FG batch(es) with `available>0`, enter real `dispatchedQty` per line.
- **FG reservations UI:** mirror the RM `stock-reservations` pattern (`CREATE['/v1/stock-reservations']` + Release `ACTIONS`) for `/v1/fg-reservations` (fk to `/v1/finished-good-batches`, `reservedQty` field, Release action). Belongs in sales/packaging nav.
- Bump `sw.js` CACHE. All ATP math is server-side; the client shows row fields verbatim.

**Placement decision to make first:** which cluster owns FG reservation (packaging vs sales). Packaging owns the FG batch (in-schema FK is cleanest there); sales owns dispatch + the `Dispatch` action. Recommended: reservation table + CRUD in **packaging**; ATP read-model + dispatch guard in the **BFF/sales** side reading via `PACKAGING_LOOKUP`.

---

## 6. State: DONE vs PENDING

**DONE (exists in code, verified):**
- Full kernel + edge pipeline, encrypted tunnel, RBAC (263 perms × 10 roles), material masking, vault/KmsPort, transactional outbox + worker drain, `db:push` migration path.
- All 13 clusters with CRUD, the make-to-ship chain (formula→production→packaging→sales), all 12 data schemas.
- FG **produced** side: `packaging.finished_good_batch_master.produced_qty` + `produceFinishedGoodBatch` + `packaging.fg_batch.created` event + `PACKAGING_LOOKUP.getFinishedGoodBatch`.
- FG **dispatched** side: `sales.dispatch_items.dispatched_qty` + `createDispatch` + `sales.dispatch.created` event (+ `dispatch_items_fg_batch_idx`).
- RM ATP template `inventory-view` + `planning`; dashboard already sums FG produced & joins dispatch.

**PENDING (the FG-stock task):**
- No `finished_good_reservation` table anywhere (greenfield — grep confirms).
- No FG ATP endpoint/view; `available = produced − dispatched − reserved` is not computed for FG.
- `createDispatch` does NOT validate available qty and does NOT decrement; nothing subscribes to `sales.dispatch.created` or `packaging.fg_batch.created`.
- Frontend `Dispatch` action is a placeholder (`dispatchedQty:1`, first-batch pick, hardcoded vehicle); no FG-stock view; no FG-reservation UI.
- `finished_good_batch` not in the `edit` REGISTRY.

**Broader project state (per `docs/PHASE1_GAP_CHECKLIST.md`):** aligned but "shows ≠ runs" — themes: notify routing, missing edit/delete on many masters, planning, orphaned screens, reports. Razorpay/payments deferred. `cluster-identity` is retired dead code.
