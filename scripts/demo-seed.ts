/**
 * demo-seed.ts — "ALEMBIC OS Demo Factory": a deterministic, idempotent demo dataset for
 * RawProd, driven THROUGH THE REAL NEST SERVICES (the same classes the app/tests use — see
 * backend/test-support's own `new PoService(procurementDb())` idiom) and the real G3
 * automation layer (backend/api/src/automation/*), so that outbox events, decision logs, and
 * bridge events are genuinely produced by the real code paths, not fabricated rows.
 *
 * Run:  DATABASE_URL=postgres://... [FORMULA_DATABASE_URL=...] pnpm demo:seed
 *
 * IDEMPOTENCY STRATEGY — natural/business keys, "skip the whole chain if the root exists":
 *   Every top-level entity this script creates carries a human-readable, demo-recognisable
 *   business key (vendor/material code, `DEMO-PO-####` PO number, `DEMO-ORD-####` ALEMBIC
 *   order ref, formula code, user email, org code, role code). Before creating anything for a
 *   "chain" (e.g. a PO and everything that hangs off it: GRN → RM batch → QC → credit note),
 *   the script checks whether the chain's ROOT already exists by that key and, if so, skips
 *   the entire chain. Two full runs therefore produce IDENTICAL row counts — see
 *   scripts/__tests__/demo-seed.test.ts (also exercised from backend/api/src/__tests__/
 *   demo-seed.test.ts so `pnpm test` picks it up).
 *
 * ID CONVENTIONS (see scripts/demo-seed.README.md for the full ALEMBIC DEMO-ORD mapping):
 *   materials   DEMO-MAT-0001..0060      vendors     DEMO-VEN-01..12
 *   POs         DEMO-PO-0001..0040       stock reqs  DEMO-SR-.. / PRs DEMO-PR-0001..
 *   RM batches  RMB-DEMO-#### (via GrnService's own batch numbering, GRN-keyed)
 *   bridge reqs DEMO-ORD-0003..0032 (mirrors ALEMBIC lane D2's own DEMO-ORD-#### story)
 *
 * SCOPE NOTE for the reader: this script intentionally does NOT re-seed RBAC (permission
 * catalogue / role→permission grants) — that catalogue is owned by scripts/ra-roles.ts +
 * scripts/ra-permissions.ts + `pnpm db:seed`, and re-deriving it here would drift from it. It
 * seeds ONLY the small set of `iam.role_master` rows this demo's users need (as bare role rows,
 * zero permission mappings — every AuthPrincipal driving a service call below carries its
 * permissions in-memory, exactly like this repo's own tests' `principal()` fixture; no HTTP
 * guard is ever in the path here), plus one new `showcase` role for the "never sees plaintext"
 * demonstration.
 *
 * SCHEMA GAP FOUND (reported, not fixed — lane brief: report if a migration would be needed):
 * the `location` Postgres schema (warehouse/zone/rack/bin — backend/cluster-location) requires
 * the `postgis` extension via `pnpm db:push`, and is deliberately OMITTED from
 * backend/test-support/schema.sql (the harness this seed's own tests + this whole repo's
 * `pnpm test` run against) to avoid that dependency on every dev/CI box. This script therefore
 * BEST-EFFORTS the warehouse/zone/rack hierarchy through the real LocationService classes when
 * the schema exists (a full `pnpm db:push`'d dev database), and falls back to clearly-logged
 * synthetic storage-location ids when it doesn't (`inventory.rm_batch_master.storage_location_id`
 * etc. are soft refs — plain uuid, no FK — so this never blocks anything downstream). No new
 * migration is proposed; this is a pre-existing gap between the two DB-provisioning paths.
 */
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { AuthPrincipal } from '../backend/backend-kernel/src/edge/principal.js';
import { ConfigService } from '../backend/backend-kernel/src/config/config.service.js';

// ── org / identity ──────────────────────────────────────────────────────────
import { OrgService } from '../backend/cluster-org/src/org/org.service.js';
import { SecurityService } from '../backend/cluster-org/src/security/security.service.js';
import * as orgSchema from '@ra/data-org';

// ── masterdata ──────────────────────────────────────────────────────────────
import { ClassificationService } from '../backend/cluster-masterdata/src/classification/classification.service.js';
import { MaterialService } from '../backend/cluster-masterdata/src/material/material.service.js';
import { MasterdataLookupService } from '../backend/cluster-masterdata/src/masterdata-lookup.service.js';
import * as masterdataSchema from '@ra/data-masterdata';

// ── reference (uom) ─────────────────────────────────────────────────────────
import { UomService } from '../backend/cluster-reference/src/uom/uom.service.js';
import * as referenceSchema from '@ra/data-reference';

// ── location (best-effort — see schema-gap note above) ─────────────────────
import { SitesService } from '../backend/cluster-location/src/sites/sites.service.js';
import { WarehouseService } from '../backend/cluster-location/src/warehouse/warehouse.service.js';
import { StorageService } from '../backend/cluster-location/src/storage/storage.service.js';
import * as locationSchema from '@ra/data-location';

// ── procurement ──────────────────────────────────────────────────────────────
import { VendorService } from '../backend/cluster-procurement/src/vendor/vendor.service.js';
import { RequirementService } from '../backend/cluster-procurement/src/requirement/requirement.service.js';
import { RfqService } from '../backend/cluster-procurement/src/rfq/rfq.service.js';
import { PoService } from '../backend/cluster-procurement/src/po/po.service.js';
import * as procurementSchema from '@ra/data-procurement';

// ── inventory ────────────────────────────────────────────────────────────────
import { GateService } from '../backend/cluster-inventory/src/gate/gate.service.js';
import { GrnService } from '../backend/cluster-inventory/src/grn/grn.service.js';
import { StockService } from '../backend/cluster-inventory/src/stock/stock.service.js';
import { InventoryService } from '../backend/cluster-inventory/src/inventory/inventory.service.js';
import * as inventorySchema from '@ra/data-inventory';

// ── quality ──────────────────────────────────────────────────────────────────
import { InspectionsService } from '../backend/cluster-quality/src/inspections/inspections.service.js';
import * as qualitySchema from '@ra/data-quality';

// ── production ───────────────────────────────────────────────────────────────
import { PlanningService } from '../backend/cluster-production/src/planning/planning.service.js';
import { MixingService } from '../backend/cluster-production/src/mixing/mixing.service.js';
import { PickingService } from '../backend/cluster-production/src/picking/picking.service.js';
import { BatchService as ProductionBatchService } from '../backend/cluster-production/src/batch/batch.service.js';
import * as productionSchema from '@ra/data-production';

// ── packaging ────────────────────────────────────────────────────────────────
import { CatalogService as PackagingCatalogService } from '../backend/cluster-packaging/src/catalog/catalog.service.js';
import { OrdersService as PackagingOrdersService } from '../backend/cluster-packaging/src/orders/orders.service.js';
import { BatchService as PackagingBatchService } from '../backend/cluster-packaging/src/batch/batch.service.js';
import { ReservationService } from '../backend/cluster-packaging/src/reservation/reservation.service.js';
import { PackagingLookupService } from '../backend/cluster-packaging/src/packaging-lookup.service.js';
import * as packagingSchema from '@ra/data-packaging';

// ── sales ────────────────────────────────────────────────────────────────────
import { MastersService as SalesMastersService } from '../backend/cluster-sales/src/masters/masters.service.js';
import { OrdersService as SalesOrdersService } from '../backend/cluster-sales/src/orders/orders.service.js';
import { DispatchService } from '../backend/cluster-sales/src/dispatch/dispatch.service.js';
import * as salesSchema from '@ra/data-sales';

// ── formula vault ────────────────────────────────────────────────────────────
import { FormulasService } from '../backend/cluster-formula/src/formulas/formulas.service.js';
import { ApprovalsService } from '../backend/cluster-formula/src/approvals/approvals.service.js';
import { VaultService } from '../backend/cluster-formula/src/vault.service.js';
import { FormulaLookupService } from '../backend/cluster-formula/src/formula-lookup.service.js';
import { EnvKmsAdapter } from '../backend/cluster-formula/src/crypto/env-kms.adapter.js';
import * as formulaSchema from '@ra/data-formula';

// ── packaging QC + tutorial (raw-SQL BFF modules) ───────────────────────────
import { PackagingQcService } from '../backend/api/src/packaging-qc/packaging-qc.service.js';
import { TutorialService } from '../backend/api/src/tutorial/tutorial.service.js';

// ── bridge ───────────────────────────────────────────────────────────────────
import { ImporterService } from '../backend/api/src/bridge/importer.service.js';
import { ConfigAdminService } from '../backend/api/src/bridge/config-admin.service.js';
import { signBody } from '../backend/api/src/bridge/signing.js';
import * as bridgeSchema from '@ra/data-bridge';

// ── G3 automation layer ─────────────────────────────────────────────────────
import { MaterialShortageService } from '../backend/api/src/automation/material-shortage.service.js';
import { QuarantineIntakeService } from '../backend/api/src/automation/quarantine-intake.service.js';
import { IncomingQcOutcomeService } from '../backend/api/src/automation/incoming-qc-outcome.service.js';
import { PackagingReleaseService } from '../backend/api/src/automation/packaging-release.service.js';
import { AutomationAlertsService } from '../backend/api/src/automation/alerts.service.js';

/* ════════════════════════════════════════════════════════════════════════
 * Safety + config
 * ════════════════════════════════════════════════════════════════════════ */

/** This is a demo-data generator. It never runs against a production environment. */
function assertNotProd(): void {
  if (process.env.APP_ENV === 'prod' || process.env.NODE_ENV === 'production') {
    throw new Error('demo-seed.ts refuses to run when APP_ENV=prod / NODE_ENV=production.');
  }
}

/** Stable, non-secret, DEMO-ONLY 32-byte key derived from a label — reused across runs so
 * previously-sealed data (formula DEKs, the bridge HMAC secret) keeps decrypting/verifying on
 * a second run. Never used when APP_ENV=prod (assertNotProd refuses the whole script first). */
function demoKey(label: string): string {
  return createHash('sha256').update(`RAWPROD-DEMO-SEED::${label}`).digest('base64');
}

export interface DemoSeedOptions {
  databaseUrl?: string;
  formulaDatabaseUrl?: string;
  quiet?: boolean;
}

export interface DemoSeedSummary {
  org: string;
  users: number;
  roles: number;
  materials: number;
  vendors: number;
  vendorMappings: number;
  productSkus: number;
  formulas: number;
  formulaVersionsApproved: number;
  purchaseRequests: number;
  rfqs: number;
  purchaseOrders: number;
  gateEntries: number;
  grns: number;
  rmBatches: number;
  qcInspections: number;
  vendorCreditNotes: number;
  stockReservations: number;
  stockTransfers: number;
  bridgeProductionRequirements: number;
  productionOrders: number;
  mixingSessions: number;
  oilBatches: number;
  materialShortageDrafts: number;
  packageOrders: number;
  fillingSessions: number;
  finishedGoodBatches: number;
  packagingQcRecords: number;
  fgReservations: number;
  salesOrders: number;
  dispatches: number;
  automationDecisionLogRows: number;
  automationRetryDemo: 'recovered' | 'skipped';
  automationDeadLetterDemo: 'dead-lettered' | 'skipped';
  alertsRaised: number;
  tutorialProgressRows: number;
  locationSchemaAvailable: boolean;
}

let out: (msg: string) => void = (msg) => console.log(msg);

/* ════════════════════════════════════════════════════════════════════════
 * Small helpers
 * ════════════════════════════════════════════════════════════════════════ */

const DAY_MS = 86_400_000;
/** `n` days ago from "now" (the business/story date — audit created_dt/updated_dt columns
 * stay real wall-clock, since this really is when the seed ran; see README). */
const ago = (days: number): Date => new Date(Date.now() - days * DAY_MS);
const isoDate = (days: number): string => ago(days).toISOString().slice(0, 10);
const pick = <T>(arr: readonly T[], i: number): T => arr[((i % arr.length) + arr.length) % arr.length]!;

function principalFor(userId: string, roles: string[], permissions: string[] = []): AuthPrincipal {
  const now = Math.floor(Date.now() / 1000);
  return {
    userId,
    portal: 'ops' as AuthPrincipal['portal'],
    roles,
    permissions,
    permVersion: 1,
    sessionId: randomUUID(),
    iat: now,
    authTime: now,
  };
}

function dbFor<T extends Record<string, unknown>>(sql: Sql, schema: T): PostgresJsDatabase<T> {
  return drizzle(sql, { schema });
}

/** Cast to reach a service's private `applyOne`/`scan` method — the exact idiom this repo's
 * own automation tests already use (see backend/api/src/automation/__tests__/*.test.ts). */
function callPrivate<A extends unknown[], R>(obj: unknown, method: string) {
  return (obj as Record<string, (...a: A) => Promise<R>>)[method]!.bind(obj);
}

/* ════════════════════════════════════════════════════════════════════════
 * Constants — demo org, roles, counts
 * ════════════════════════════════════════════════════════════════════════ */

const ORG_CODE = 'ALEMBIC-OS-DEMO-FACTORY';
const ORG_NAME = 'ALEMBIC OS Demo Factory';
const EMAIL_DOMAIN = 'demo.rawprod.local';

/** role codes this demo needs — a SUBSET of scripts/ra-roles.ts's catalogue, plus `showcase`
 * (new, demo-only). Zero permission mappings are seeded for any of them (see file header). */
const ROLE_CODES = [
  'owner', 'admin', 'procurement', 'receiving', 'qc', 'warehouse',
  'compounding', 'production', 'filling', 'packaging', 'sales',
  'formulator', 'vault_approver', 'showcase',
] as const;
const VAULT_AUTHORITY_ROLES = new Set(['formulator', 'vault_approver']);

const MATERIAL_COUNT = 60;
const VENDOR_COUNT = 12;
const PRODUCTION_ORDER_COUNT = 30;
/** ALEMBIC's own DEMO-ORD-#### numbering (lane D2) — this lane's production requirements
 * mirror DEMO-ORD-0003..0032 (30 ids), overlapping the example range in the lane brief. */
const DEMO_ORD_START = 3;
/** A fixed, obviously-fake org id for the bridge envelope's `org_id` field (format-checked
 * only by the importer, never looked up against a real ALEMBIC tenant in this demo). */
const DEMO_ALEMBIC_ORG_ID = '00000000-0000-7000-8000-00000000a1ec';

const MATERIAL_FAMILIES = [
  'Citrus Accord', 'Floral Heart', 'Woody Base', 'Amber Blend', 'Green Note', 'Musk Base',
  'Spice Accord', 'Aquatic Note', 'Powdery Base', 'Fruity Accord',
] as const;

/* ════════════════════════════════════════════════════════════════════════
 * main
 * ════════════════════════════════════════════════════════════════════════ */

export async function runDemoSeed(opts: DemoSeedOptions = {}): Promise<DemoSeedSummary> {
  assertNotProd();
  if (opts.quiet) out = () => {};

  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL ?? 'postgres://apple@localhost:5432/rawprod_dev';
  const formulaDatabaseUrl = opts.formulaDatabaseUrl ?? process.env.FORMULA_DATABASE_URL ?? databaseUrl;
  // Non-prod-only stable demo secrets (see demoKey's doc comment) — never real credentials,
  // never a tenant integration secret (those stay admin-configured self-service, per the
  // repo's connector convention; this is this SCRIPT's own throwaway crypto material).
  process.env.FORMULA_KEK = process.env.FORMULA_KEK ?? demoKey('formula-kek');
  // ConfigService validates the WHOLE app env schema (backend/backend-kernel/src/config/
  // config.schema.ts) even though this script only ever reads FORMULA_KEK off it — JWT_SECRET
  // is that schema's one field with no default, so it needs a value to construct at all. Never
  // read for anything JWT-related here (no HTTP layer in this script).
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? demoKey('jwt-secret-unused-by-this-script');
  // BRIDGE_HMAC_KEK seals the connector's own HMAC secret at rest (backend/api/src/bridge/
  // secret-box.ts) — same demo-only, stable-across-runs posture as FORMULA_KEK above.
  process.env.BRIDGE_HMAC_KEK = process.env.BRIDGE_HMAC_KEK ?? demoKey('bridge-hmac-kek');
  // LANE D1 (coordinator note, post-merge): this deployment IS the demo showcase environment —
  // RAWPROD_ENVIRONMENT=demo is what lets AuthService ever mint/accept a session for the
  // `showcase` role at all (see backend/cluster-org/src/auth/auth.service.ts). This script's
  // own service calls never read it, but the demo account this seed binds
  // (SHOWCASE_DEMO_EMAIL) is only ever usable end-to-end when the deployment it runs against
  // also has this set.
  process.env.RAWPROD_ENVIRONMENT = process.env.RAWPROD_ENVIRONMENT ?? 'demo';
  const bridgeHmacSecret = process.env.DEMO_BRIDGE_HMAC_SECRET ?? demoKey('bridge-hmac-secret');

  const sql = postgres(databaseUrl, { max: 10, prepare: false });
  const formulaSql = formulaDatabaseUrl === databaseUrl ? sql : postgres(formulaDatabaseUrl, { max: 5, prepare: false });
  // TutorialService + AutomationAlertsService get their OWN small connection, isolated from the
  // ~10-connection pool every schema-scoped Drizzle client above shares — observed postgres.js
  // Date-handling faults (a parameter-binding fault minting a fresh tutorial_progress row; a
  // parsing fault reading timestamptz rows back for the alert scan) specifically on that shared
  // pool after the thousands of prior queries this script runs against it, neither reproducible
  // against a fresh/dedicated connection in isolation. Cheap and safe regardless of root cause.
  const tutorialSql = postgres(databaseUrl, { max: 2, prepare: false });

  try {
    out(`ALEMBIC OS Demo Factory — seeding against ${databaseUrl}`);

    // ── schema-scoped drizzle handles (mirrors backend/test-support/db.ts) ──
    const orgDb = dbFor(sql, orgSchema);
    const masterdataDb = dbFor(sql, masterdataSchema);
    const referenceDb = dbFor(sql, referenceSchema);
    const locationDb = dbFor(sql, locationSchema);
    const procurementDb = dbFor(sql, procurementSchema);
    const inventoryDb = dbFor(sql, inventorySchema);
    const qualityDb = dbFor(sql, qualitySchema);
    const productionDb = dbFor(sql, productionSchema);
    const packagingDb = dbFor(sql, packagingSchema);
    const salesDb = dbFor(sql, salesSchema);
    const bridgeDb = dbFor(sql, bridgeSchema);
    const formulaDb = dbFor(formulaSql, formulaSchema);

    // ── services (constructed directly — no Nest DI container, exactly the idiom this
    // repo's own tests already use: `new PoService(procurementDb())`) ──
    const orgService = new OrgService(orgDb);
    const securityService = new SecurityService(orgDb);
    const classificationService = new ClassificationService(masterdataDb);
    const materialService = new MaterialService(masterdataDb);
    const masterdataLookup = new MasterdataLookupService(masterdataDb);
    const uomService = new UomService(referenceDb);
    const sitesService = new SitesService(locationDb);
    const warehouseService = new WarehouseService(locationDb);
    const storageService = new StorageService(locationDb);
    const vendorService = new VendorService(procurementDb);
    const requirementService = new RequirementService(procurementDb);
    const rfqService = new RfqService(procurementDb);
    const poService = new PoService(procurementDb);
    const gateService = new GateService(inventoryDb);
    const grnService = new GrnService(inventoryDb);
    const stockService = new StockService(inventoryDb);
    const inventoryService = new InventoryService(inventoryDb);
    const inspectionsService = new InspectionsService(qualityDb);
    const kms = new EnvKmsAdapter(new ConfigService(process.env));
    const vaultService = new VaultService(formulaDb, kms);
    const formulaLookup = new FormulaLookupService(vaultService, masterdataLookup);
    const formulasService = new FormulasService(formulaDb, kms, vaultService, masterdataLookup);
    const approvalsService = new ApprovalsService(formulaDb, vaultService);
    const planningService = new PlanningService(productionDb, formulaLookup);
    const mixingService = new MixingService(productionDb);
    const pickingService = new PickingService(productionDb, formulaLookup);
    const productionBatchService = new ProductionBatchService(productionDb);
    const packagingCatalogService = new PackagingCatalogService(packagingDb);
    const packagingOrdersService = new PackagingOrdersService(packagingDb);
    const packagingBatchService = new PackagingBatchService(packagingDb);
    const packagingLookup = new PackagingLookupService(packagingDb);
    const reservationService = new ReservationService(packagingDb);
    const salesMastersService = new SalesMastersService(salesDb);
    const salesOrdersService = new SalesOrdersService(salesDb);
    const dispatchService = new DispatchService(salesDb, packagingLookup);
    const packagingQcService = new PackagingQcService(sql);
    const tutorialService = new TutorialService(tutorialSql);
    const importerService = new ImporterService(bridgeDb, sql);
    const configAdminService = new ConfigAdminService(bridgeDb);
    const materialShortageService = new MaterialShortageService(sql);
    const quarantineIntakeService = new QuarantineIntakeService(sql);
    const incomingQcOutcomeService = new IncomingQcOutcomeService(sql);
    const packagingReleaseService = new PackagingReleaseService(sql);
    // Same dedicated-connection fix as TutorialService above — AutomationAlertsService's
    // scan() read the same "not really a Date" symptom (`r.updated_dt.toISOString is not a
    // function`) off the shared, heavily-used pool.
    const alertsService = new AutomationAlertsService(tutorialSql);

    const svc = {
      orgService, securityService, classificationService, materialService, masterdataLookup,
      uomService, sitesService, warehouseService, storageService, vendorService,
      requirementService, rfqService, poService, gateService, grnService, stockService,
      inventoryService,
      inspectionsService, vaultService, formulasService, approvalsService, planningService,
      mixingService, pickingService, productionBatchService, packagingCatalogService,
      packagingOrdersService, packagingBatchService, reservationService, salesMastersService,
      salesOrdersService, dispatchService, packagingQcService, tutorialService, importerService,
      configAdminService, materialShortageService, quarantineIntakeService,
      incomingQcOutcomeService, packagingReleaseService, alertsService,
    };

    const ctx: Ctx = { sql, formulaSql, svc, bridgeHmacSecret };

    // ── phases ──
    const org = await ensureOrg(ctx);
    const roles = await ensureRoles(ctx);
    const users = await ensureUsers(ctx, org.organizationId, roles);
    const locationInfo = await ensureLocationHierarchy(ctx, users.owner);
    const uom = await ensureUom(ctx, users.owner);
    const materials = await ensureMaterials(ctx, users.owner, uom);
    const { vendors, mappings } = await ensureVendors(ctx, users.procurement, materials);
    const vault = await ensureFormulaVault(ctx, users, materials);
    const catalog = await ensureProductCatalog(ctx, users, vault, locationInfo);
    const procurementCounts = await ensureProcurement(ctx, users, materials, vendors, uom);
    const receiving = await ensureReceivingAndQc(ctx, users, procurementCounts.pos, locationInfo);
    const warehouseOps = await ensureWarehouseOps(ctx, users, receiving.rmBatchIds);
    await ensureBridgeConnector(ctx, users.owner.userId);
    const bridgeStory = await ensureBridgeProductionAndFactory(ctx, users, catalog, vault);
    const automationDemo = await ensureAutomationRetryAndDeadLetterDemo(ctx, users.owner, materials);
    const alertsRaised = await ensureAlerts(ctx);
    const tutorialRows = await ensureTutorialProgress(ctx, users);

    const decisionLogRows = (await sql`select count(*)::int as c from automation.decision_log`)[0] as { c: number };

    const summary: DemoSeedSummary = {
      org: org.organizationCode ?? ORG_CODE,
      users: users.count,
      roles: roles.size,
      materials: materials.length,
      vendors: vendors.length,
      vendorMappings: mappings,
      productSkus: catalog.skuIds.length,
      formulas: vault.formulaCount,
      formulaVersionsApproved: vault.approvedVersionCount,
      purchaseRequests: procurementCounts.purchaseRequestCount,
      rfqs: procurementCounts.rfqCount,
      purchaseOrders: procurementCounts.pos.length,
      gateEntries: receiving.gateEntryCount,
      grns: receiving.grnCount,
      rmBatches: receiving.rmBatchIds.length,
      qcInspections: receiving.qcInspectionCount,
      vendorCreditNotes: receiving.creditNoteCount,
      stockReservations: warehouseOps.reservations,
      stockTransfers: warehouseOps.transfers,
      bridgeProductionRequirements: bridgeStory.requirementCount,
      productionOrders: bridgeStory.productionOrderCount,
      mixingSessions: bridgeStory.mixingSessionCount,
      oilBatches: bridgeStory.oilBatchCount,
      materialShortageDrafts: bridgeStory.shortageDraftCount,
      packageOrders: bridgeStory.packageOrderCount,
      fillingSessions: bridgeStory.fillingSessionCount,
      finishedGoodBatches: bridgeStory.fgBatchCount,
      packagingQcRecords: bridgeStory.packagingQcCount,
      fgReservations: bridgeStory.fgReservationCount,
      salesOrders: bridgeStory.salesOrderCount,
      dispatches: bridgeStory.dispatchCount,
      automationDecisionLogRows: decisionLogRows.c,
      automationRetryDemo: automationDemo.retry,
      automationDeadLetterDemo: automationDemo.deadLetter,
      alertsRaised,
      tutorialProgressRows: tutorialRows,
      locationSchemaAvailable: locationInfo.available,
    };

    out('── ALEMBIC OS Demo Factory seed complete ──');
    out(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    await sql.end({ timeout: 5 });
    if (formulaSql !== sql) await formulaSql.end({ timeout: 5 });
    await tutorialSql.end({ timeout: 5 });
  }
}

interface Ctx {
  sql: Sql;
  formulaSql: Sql;
  bridgeHmacSecret: string;
  svc: {
    orgService: OrgService;
    securityService: SecurityService;
    classificationService: ClassificationService;
    materialService: MaterialService;
    masterdataLookup: MasterdataLookupService;
    uomService: UomService;
    sitesService: SitesService;
    warehouseService: WarehouseService;
    storageService: StorageService;
    vendorService: VendorService;
    requirementService: RequirementService;
    rfqService: RfqService;
    poService: PoService;
    gateService: GateService;
    grnService: GrnService;
    stockService: StockService;
    inventoryService: InventoryService;
    inspectionsService: InspectionsService;
    vaultService: VaultService;
    formulasService: FormulasService;
    approvalsService: ApprovalsService;
    planningService: PlanningService;
    mixingService: MixingService;
    pickingService: PickingService;
    productionBatchService: ProductionBatchService;
    packagingCatalogService: PackagingCatalogService;
    packagingOrdersService: PackagingOrdersService;
    packagingBatchService: PackagingBatchService;
    reservationService: ReservationService;
    salesMastersService: SalesMastersService;
    salesOrdersService: SalesOrdersService;
    dispatchService: DispatchService;
    packagingQcService: PackagingQcService;
    tutorialService: TutorialService;
    importerService: ImporterService;
    configAdminService: ConfigAdminService;
    materialShortageService: MaterialShortageService;
    quarantineIntakeService: QuarantineIntakeService;
    incomingQcOutcomeService: IncomingQcOutcomeService;
    packagingReleaseService: PackagingReleaseService;
    alertsService: AutomationAlertsService;
  };
}

/** Pull `key` out of a service's return value, whatever shape it wraps it in — some services
 * return the row flat (`{purchaseOrderId}`), others nest it (`{purchaseOrder:{purchaseOrderId}}`).
 * Defensive against exact-shape drift; throws loudly if truly absent (never silently undefined). */
function extractId(obj: unknown, key: string): string {
  const o = obj as Record<string, unknown>;
  if (o && typeof o[key] === 'string') return o[key] as string;
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object' && typeof (v as Record<string, unknown>)[key] === 'string') {
        return (v as Record<string, unknown>)[key] as string;
      }
    }
  }
  throw new Error(`extractId: could not find "${key}" in ${JSON.stringify(obj)}`);
}

function roleName(code: string): string {
  const names: Record<string, string> = {
    owner: 'Owner', admin: 'Admin', procurement: 'Procurement', receiving: 'Receiving',
    qc: 'Quality Control', warehouse: 'Warehouse', compounding: 'Compounding',
    production: 'Production', filling: 'Filling', packaging: 'Packaging', sales: 'Sales',
    formulator: 'Formulator', vault_approver: 'Vault Approver', showcase: 'Showcase (demo viewer)',
  };
  return names[code] ?? code;
}
function roleDescription(code: string): string {
  return `ALEMBIC OS Demo Factory — ${roleName(code)} role.`;
}
function displayName(code: string): string {
  return `Demo ${roleName(code)}`;
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: org
 * ════════════════════════════════════════════════════════════════════════ */

async function ensureOrg(ctx: Ctx): Promise<{ organizationId: string; organizationCode: string | null }> {
  const existing = (await ctx.sql`
    select organization_id as id, organization_code as code from iam.org_master
     where organization_code = ${ORG_CODE} limit 1
  `)[0] as { id: string; code: string | null } | undefined;
  if (existing) {
    out(`org: ${ORG_NAME} already exists`);
    return { organizationId: existing.id, organizationCode: existing.code };
  }
  const bootstrap = principalFor(randomUUID(), ['owner']);
  const row = await ctx.svc.orgService.createOrg({ organizationCode: ORG_CODE, organizationName: ORG_NAME }, bootstrap);
  out(`org: created ${ORG_NAME}`);
  return { organizationId: row.organizationId, organizationCode: row.organizationCode };
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: roles (bare role rows only — see file header for why no permissions)
 * ════════════════════════════════════════════════════════════════════════ */

async function ensureRoles(ctx: Ctx): Promise<Map<string, string>> {
  const bootstrap = principalFor(randomUUID(), ['owner']);
  const roleIds = new Map<string, string>();
  for (const code of ROLE_CODES) {
    const existing = (await ctx.sql`select role_id as id from iam.role_master where role_code = ${code} limit 1`)[0] as { id: string } | undefined;
    if (existing) { roleIds.set(code, existing.id); continue; }
    const row = await ctx.svc.securityService.createRole({ roleCode: code, roleName: roleName(code), description: roleDescription(code) }, bootstrap);
    roleIds.set(code, row.roleId);
    out(`role: created ${code}`);
  }
  return roleIds;
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: users — one demo persona per role, real users, real (bare) roles, and the REAL
 * two-person Vault-authority grant flow for formulator/vault_approver (SecurityService).
 * ════════════════════════════════════════════════════════════════════════ */

export interface DemoUsers {
  count: number;
  owner: AuthPrincipal;
  admin: AuthPrincipal;
  procurement: AuthPrincipal;
  receiving: AuthPrincipal;
  qc: AuthPrincipal;
  warehouse: AuthPrincipal;
  compounding: AuthPrincipal;
  production: AuthPrincipal;
  filling: AuthPrincipal;
  packaging: AuthPrincipal;
  sales: AuthPrincipal;
  formulator: AuthPrincipal;
  approver: AuthPrincipal;
  showcase: AuthPrincipal;
}

/** LANE D1's canonical demo-showcase account email (scripts/ra-roles.ts `sampleEmail` for
 * SHOWCASE_ROLE) — reused here by email so this script binds the SAME row `pnpm db:seed`
 * provisions (passwordless, RAWPROD_ENVIRONMENT=demo, ALEMBIC-assertion-only) rather than
 * minting a second, password-authenticatable "showcase" account that AuthService would refuse
 * to ever log in anyway. Formulator/vault_approver demo users stay this script's OWN separate
 * synthetic staff — never this account — per the coordinator's D1-merge note. */
const SHOWCASE_DEMO_EMAIL = 'demo@demo.alembic.invalid';

async function findOrCreateUser(
  ctx: Ctx, organizationId: string, roleCode: string, actor: AuthPrincipal,
): Promise<{ userId: string; created: boolean }> {
  const isShowcase = roleCode === 'showcase';
  const email = isShowcase ? SHOWCASE_DEMO_EMAIL : `${roleCode}@${EMAIL_DOMAIN}`;
  const existing = (await ctx.sql`select user_id as id from iam.user_master where email = ${email} limit 1`)[0] as { id: string } | undefined;
  if (existing) return { userId: existing.id, created: false };
  const row = await ctx.svc.securityService.createUser({
    organizationId,
    employeeCode: `DEMO-${roleCode.toUpperCase()}`,
    userName: isShowcase ? 'ALEMBIC Demo Showcase' : displayName(roleCode),
    email,
    // LANE D1: the showcase account is PASSWORDLESS — reachable only via an ALEMBIC demo
    // assertion (AuthService.login hard-refuses password sign-in for role=showcase regardless).
    // Every other demo persona gets an ordinary password for local/demo convenience.
    ...(isShowcase ? {} : { password: 'DemoFactory#2026!' }),
    isActive: true,
  }, actor);
  return { userId: row.userId, created: true };
}

async function ensureUserRole(
  ctx: Ctx, userId: string, roleId: string, roleCode: string, owner: AuthPrincipal, admin: AuthPrincipal,
): Promise<void> {
  const already = (await ctx.sql`select 1 from iam.user_role_mapping where user_id = ${userId} and role_id = ${roleId} limit 1`)[0];
  if (already) return;

  if (!VAULT_AUTHORITY_ROLES.has(roleCode)) {
    await ctx.svc.securityService.createUserRole({ userId, roleId }, owner);
    return;
  }

  // Vault-authority role: the REAL two-person grant (S2 security review item A) —
  // `owner` REQUESTS, a genuinely different `admin` APPROVES. See
  // backend/cluster-org/src/security/security.service.ts.
  let requestId: string;
  const pending = (await ctx.sql`
    select vault_role_grant_request_id as id from iam.vault_role_grant_request
     where user_id = ${userId} and role_id = ${roleId} and grant_status = 'PENDING' limit 1
  `)[0] as { id: string } | undefined;
  if (pending) {
    requestId = pending.id;
  } else {
    const requested = await ctx.svc.securityService.createUserRole({ userId, roleId }, owner);
    requestId = extractId(requested, 'vaultRoleGrantRequestId');
  }
  await ctx.svc.securityService.approveVaultRoleGrant(requestId, admin);
}

async function ensureUsers(ctx: Ctx, organizationId: string, roles: Map<string, string>): Promise<DemoUsers> {
  const bootstrap = principalFor(randomUUID(), ['owner']);
  let created = 0;

  const ownerU = await findOrCreateUser(ctx, organizationId, 'owner', bootstrap);
  if (ownerU.created) created++;
  const owner = principalFor(ownerU.userId, ['owner']);

  // A SEPARATE, independent bootstrap actor for `admin` — never `owner`'s own principal. This
  // matters for real: SecurityService.isInCreatorChain (S3 security review item 11) walks
  // `created_by` ancestry to refuse a vault-role approval from an approver the requester
  // created (directly or transitively) — if `admin` were created BY `owner`, `owner` could
  // never validly request AND `admin` approve a Vault-authority grant below; two genuinely
  // independent bootstrap identities is what makes that two-person control real here.
  const adminBootstrap = principalFor(randomUUID(), ['admin']);
  const adminU = await findOrCreateUser(ctx, organizationId, 'admin', adminBootstrap);
  if (adminU.created) created++;
  const admin = principalFor(adminU.userId, ['admin']);

  const OTHER_ROLES = [
    'procurement', 'receiving', 'qc', 'warehouse', 'compounding', 'production',
    'filling', 'packaging', 'sales', 'formulator', 'vault_approver', 'showcase',
  ] as const;
  const rest: Record<string, AuthPrincipal> = {};
  for (const code of OTHER_ROLES) {
    const u = await findOrCreateUser(ctx, organizationId, code, owner);
    if (u.created) created++;
    rest[code] = principalFor(u.userId, [code]);
  }

  await ensureUserRole(ctx, ownerU.userId, roles.get('owner')!, 'owner', owner, admin);
  await ensureUserRole(ctx, adminU.userId, roles.get('admin')!, 'admin', owner, admin);
  for (const code of OTHER_ROLES) {
    const p = rest[code]!;
    await ensureUserRole(ctx, p.userId, roles.get(code)!, code, owner, admin);
  }

  out(`users: ${created} created this run, ${OTHER_ROLES.length + 2} demo personas total`);
  return {
    count: OTHER_ROLES.length + 2,
    owner, admin,
    procurement: rest.procurement!, receiving: rest.receiving!, qc: rest.qc!, warehouse: rest.warehouse!,
    compounding: rest.compounding!, production: rest.production!, filling: rest.filling!,
    packaging: rest.packaging!, sales: rest.sales!, formulator: rest.formulator!,
    approver: rest.vault_approver!, showcase: rest.showcase!,
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: location hierarchy (best-effort — see file header schema-gap note)
 * ════════════════════════════════════════════════════════════════════════ */

export interface LocationInfo {
  available: boolean;
  storageLocationIds: string[];
}

async function ensureLocationHierarchy(ctx: Ctx, owner: AuthPrincipal): Promise<LocationInfo> {
  try {
    const probe = (await ctx.sql`select to_regclass('location.location_master') as t`)[0] as { t: string | null };
    if (!probe.t) {
      out('location: schema not present in this database (see file header schema-gap note) — using synthetic storage-location ids');
      return { available: false, storageLocationIds: Array.from({ length: 8 }, () => randomUUID()) };
    }

    const existingLoc = (await ctx.sql`select location_id as id from location.location_master where location_code = 'DEMO-WH-01' limit 1`)[0] as { id: string } | undefined;
    const locationId = existingLoc
      ? existingLoc.id
      : extractId(await ctx.svc.sitesService.createLocation({ locationCode: 'DEMO-WH-01', locationName: 'ALEMBIC OS Demo Factory — Warehouse' }, owner), 'locationId');

    const existingWh = (await ctx.sql`select warehouse_id as id from location.warehouse where warehouse_code = 'DEMO-WH-01' limit 1`)[0] as { id: string } | undefined;
    const warehouseId = existingWh
      ? existingWh.id
      : extractId(await ctx.svc.warehouseService.createWarehouse({ locationId, warehouseCode: 'DEMO-WH-01', warehouseName: 'Demo Factory Warehouse' }, owner), 'warehouseId');

    const zoneNames = ['Citrus', 'Amber', 'Florals', 'Flammables'];
    const storageLocationIds: string[] = [];
    for (let i = 0; i < zoneNames.length; i++) {
      const zoneCode = `DEMO-Z${i + 1}`;
      const existingZone = (await ctx.sql`select zone_id as id from location.zone where zone_code = ${zoneCode} limit 1`)[0] as { id: string } | undefined;
      const zoneId = existingZone
        ? existingZone.id
        : extractId(await ctx.svc.warehouseService.createZone({ zoneCode, zoneName: `${zoneCode} · ${zoneNames[i]}` }, owner), 'zoneId');

      for (let r = 1; r <= 2; r++) {
        const rackCode = `DEMO-R${i + 1}-${r}`;
        const existingRack = (await ctx.sql`select rack_id as id from location.rack where rack_code = ${rackCode} limit 1`)[0] as { id: string } | undefined;
        const rackId = existingRack
          ? existingRack.id
          : extractId(await ctx.svc.warehouseService.createRack({ zoneId, rackCode, rackName: `Rack ${rackCode}` }, owner), 'rackId');

        const slCode = `DEMO-SL-${rackCode}`;
        const existingSl = (await ctx.sql`select storage_location_id as id from location.storage_location_master where storage_location_code = ${slCode} limit 1`)[0] as { id: string } | undefined;
        if (existingSl) { storageLocationIds.push(existingSl.id); continue; }
        const sl = await ctx.svc.storageService.createStorageLocation(
          { warehouseId, rackId, storageLocationCode: slCode, storageLocationName: `Storage ${slCode}` }, owner,
        );
        storageLocationIds.push(extractId(sl, 'storageLocationId'));
      }
    }
    out(`location: warehouse hierarchy ready (${storageLocationIds.length} storage locations)`);
    return { available: true, storageLocationIds };
  } catch (err) {
    out(`location: best-effort hierarchy failed (${(err as Error).message}) — using synthetic storage-location ids`);
    return { available: false, storageLocationIds: Array.from({ length: 8 }, () => randomUUID()) };
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: UOM
 * ════════════════════════════════════════════════════════════════════════ */

async function ensureUom(ctx: Ctx, owner: AuthPrincipal): Promise<Record<string, string>> {
  const defs: Array<[string, string]> = [['KG', 'Kilogram'], ['L', 'Litre'], ['EA', 'Each'], ['ML', 'Millilitre']];
  const uomIds: Record<string, string> = {};
  for (const [code, name] of defs) {
    const existing = (await ctx.sql`select uom_id as id from platform.uom_master where uom_code = ${code} limit 1`)[0] as { id: string } | undefined;
    if (existing) { uomIds[code] = existing.id; continue; }
    const u = await ctx.svc.uomService.createUom({ uomCode: code, uomName: name }, owner);
    uomIds[code] = extractId(u, 'uomId');
  }
  out(`uom: ${Object.keys(uomIds).length} units ready`);
  return uomIds;
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: materials (60, synthetic — no genuine CAS numbers)
 * ════════════════════════════════════════════════════════════════════════ */

export interface DemoMaterial { id: string; code: string; name: string; }

async function ensureMaterials(ctx: Ctx, owner: AuthPrincipal, uom: Record<string, string>): Promise<DemoMaterial[]> {
  const TYPES: Array<[string, string]> = [
    ['DEMO-AC', 'Demo Aroma Chemical (synthetic)'],
    ['DEMO-EO', 'Demo Botanical Note (synthetic)'],
    ['DEMO-CO', 'Demo Carrier Base (synthetic)'],
    ['DEMO-SO', 'Demo Solvent (synthetic)'],
  ];
  const typeIds: string[] = [];
  for (const [code, name] of TYPES) {
    const existing = (await ctx.sql`select material_type_id as id from masterdata.material_type_master where type_code = ${code} limit 1`)[0] as { id: string } | undefined;
    if (existing) { typeIds.push(existing.id); continue; }
    const t = await ctx.svc.classificationService.createMaterialType({ typeCode: code, typeName: name }, owner);
    typeIds.push(extractId(t, 'materialTypeId'));
  }

  const materials: DemoMaterial[] = [];
  for (let i = 0; i < MATERIAL_COUNT; i++) {
    const code = `DEMO-MAT-${String(i + 1).padStart(4, '0')}`;
    const family = pick(MATERIAL_FAMILIES, i);
    const variant = String(Math.floor(i / MATERIAL_FAMILIES.length) + 1).padStart(2, '0');
    const name = `Demo ${family} ${variant}`;
    const existing = (await ctx.sql`select material_id as id from masterdata.material where material_code = ${code} limit 1`)[0] as { id: string } | undefined;
    if (existing) { materials.push({ id: existing.id, code, name }); continue; }
    const row = await ctx.svc.materialService.createMaterial({
      materialTypeId: pick(typeIds, i),
      materialCode: code,
      materialName: name,
      uomId: uom.KG,
      description: 'Synthetic demo material — no genuine CAS number; ALEMBIC OS Demo Factory story only.',
      reorderLevel: 20,
      minStock: 10,
      maxStock: 500,
      qcRequired: true,
    }, owner);
    const materialId = extractId(row, 'materialId');
    // lane/j2: every material gets its floor code (RM alias) — a coded manufacturing instruction
    // is now withheld (409) for any line whose material has none, and a factory whose materials
    // have no floor codes cannot compound anything.
    await ctx.svc.materialService.createRmAlias(
      { materialId, aliasName: `DX-${String(i + 1).padStart(4, '0')}`, aliasType: 'FLOOR_CODE' }, owner);
    materials.push({ id: materialId, code, name });
  }
  out(`materials: ${materials.length} ready`);
  return materials;
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: vendors (12) + vendor↔material mappings
 * ════════════════════════════════════════════════════════════════════════ */

export interface DemoVendor { id: string; code: string; name: string; }

async function ensureVendors(
  ctx: Ctx, procurement: AuthPrincipal, materials: DemoMaterial[],
): Promise<{ vendors: DemoVendor[]; mappings: number }> {
  const NAMES = [
    'Demo Aroma Supply Co.', 'Demo Botanical Traders', 'Demo Essence Partners', 'Demo Ingredients Ltd.',
    'Demo Fragrance Works', 'Demo Scent Source', 'Demo Aromatics Group', 'Demo Pure Naturals',
    'Demo Synth House', 'Demo Global Aromas', 'Demo Craft Ingredients', 'Demo Factory Supply',
  ] as const;
  const vendors: DemoVendor[] = [];
  for (let i = 0; i < VENDOR_COUNT; i++) {
    const code = `DEMO-VEN-${String(i + 1).padStart(2, '0')}`;
    const name = pick(NAMES, i);
    const existing = (await ctx.sql`select vendor_id as id from procurement.vendor_details where vendor_code = ${code} limit 1`)[0] as { id: string } | undefined;
    if (existing) { vendors.push({ id: existing.id, code, name }); continue; }
    const row = await ctx.svc.vendorService.createVendorDetails({ vendorCode: code, vendorName: name, paymentTerms: 'NET 30' }, procurement);
    vendors.push({ id: extractId(row, 'vendorId'), code, name });
  }

  let mappings = 0;
  // last 4 materials deliberately left unmapped — exercises the "unmapped" bucket in
  // MaterialShortageService's grouping (see the service's own doc comment).
  const mappedMaterials = materials.slice(0, Math.max(0, materials.length - 4));
  for (let i = 0; i < mappedMaterials.length; i++) {
    const material = mappedMaterials[i]!;
    const vendor = pick(vendors, i);
    const already = (await ctx.sql`select 1 from procurement.vendor_rm_mapping where vendor_id = ${vendor.id} and material_id = ${material.id} limit 1`)[0];
    if (already) continue;
    await ctx.svc.vendorService.createVendorRmMapping(
      { vendorId: vendor.id, materialId: material.id, isPreferred: true, leadTimeDays: 14 + (i % 10), minOrderQty: 25 }, procurement,
    );
    mappings++;
  }
  out(`vendors: ${vendors.length} ready, ${mappings} vendor↔material mappings`);
  return { vendors, mappings };
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: formula vault — ONE synthetic demo formula (2 variants) through the REAL vault
 * workflow: formulator seals, a genuinely DIFFERENT vault_approver approves (§108 SoD).
 * ════════════════════════════════════════════════════════════════════════ */

export interface VaultFormula { formulaId: string; versionId: string; code: string; name: string; }
export interface VaultResult { formulaCount: number; approvedVersionCount: number; formulas: VaultFormula[]; }

const SHARE_TABLE: Record<number, number[]> = {
  8: [30, 20, 15, 12, 10, 8, 3, 2],
  6: [35, 25, 15, 10, 10, 5],
};
function sharesFor(n: number): number[] {
  const t = SHARE_TABLE[n];
  if (t) return t;
  const base = Math.floor(100 / n);
  const arr = Array.from({ length: n }, () => base);
  arr[0] = arr[0]! + (100 - base * n);
  return arr;
}

async function ensureFormulaVault(ctx: Ctx, users: DemoUsers, materials: DemoMaterial[]): Promise<VaultResult> {
  const DEFS: Array<{ code: string; name: string; ingredientCount: number }> = [
    { code: 'DEMO-FRM-001', name: 'Demo Signature Accord', ingredientCount: 8 },
    { code: 'DEMO-FRM-002', name: 'Demo Citrus Veil', ingredientCount: 6 },
  ];
  const formulas: VaultFormula[] = [];

  for (let f = 0; f < DEFS.length; f++) {
    const def = DEFS[f]!;
    const existing = (await ctx.formulaSql`
      select formula_id as id, current_version_id as version from formula.formula_master where formula_code = ${def.code} limit 1
    `)[0] as { id: string; version: string | null } | undefined;

    if (existing?.version) {
      formulas.push({ formulaId: existing.id, versionId: existing.version, code: def.code, name: def.name });
      continue;
    }

    const formulaId = existing
      ? existing.id
      : extractId(await ctx.svc.formulasService.createFormula({ formulaCode: def.code, formulaName: def.name }, users.formulator), 'formulaId');

    const version = await ctx.svc.formulasService.createVersion({ formulaId, versionNumber: 1 }, users.formulator);
    const versionId = extractId(version, 'formulaVersionId');

    const shares = sharesFor(def.ingredientCount);
    const chosen = Array.from({ length: def.ingredientCount }, (_, i) => pick(materials, f * 17 + i * 7));
    await ctx.svc.formulasService.addIngredients(versionId, {
      ingredients: chosen.map((m, i) => ({ materialId: m.id, percentage: shares[i]!, sequenceNo: i + 1 })),
    }, users.formulator);

    await ctx.svc.formulasService.finalizeVersion(versionId, users.formulator);
    await ctx.svc.approvalsService.submitForReview(versionId, {}, users.formulator);
    // §108 SoD, for real: ApprovalsService.approveVersion THROWS if approver.userId ===
    // version.createdBy — this is a genuinely different user, not a role-only distinction.
    await ctx.svc.approvalsService.approveVersion(versionId, { remarks: 'Approved for the ALEMBIC OS Demo Factory story.' }, users.approver);

    formulas.push({ formulaId, versionId, code: def.code, name: def.name });
    out(`formula vault: "${def.name}" sealed by the formulator, approved by a different vault_approver`);
  }

  // Structural proof of "the demo showcase role never sees plaintext": showcase's permission
  // set never carries formula:actual:read — the ONE permission §107 gates the decrypted read
  // behind, held only by formulator/vault_approver (scripts/ra-roles.ts).
  if (users.showcase.permissions.includes('formula:actual:read')) {
    throw new Error('invariant violated: the showcase principal must never carry formula:actual:read');
  }

  return { formulaCount: formulas.length, approvedVersionCount: formulas.length, formulas };
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: product catalog — products/SKUs from the vault formulas (SKU codes double as the
 * bridge's `mapped_sku` — "SKU mappings" per the lane brief), + packaging materials/BOM, +
 * enough packaging-material inventory for the real issuePackagingMaterials() call downstream.
 * ════════════════════════════════════════════════════════════════════════ */

export interface CatalogResult {
  skuIds: string[];
  skuCodes: string[];
  packagingMaterialIds: string[];
}

async function ensureProductCatalog(
  ctx: Ctx, users: DemoUsers, vault: VaultResult, loc: LocationInfo,
): Promise<CatalogResult> {
  const actor = users.packaging;
  const PKG_MATS: Array<[string, string]> = [
    ['DEMO-PKG-BOT', 'Demo Bottle 100ml'], ['DEMO-PKG-CAP', 'Demo Cap — matte'],
    ['DEMO-PKG-LBL', 'Demo Label'], ['DEMO-PKG-CTN', 'Demo Carton'],
  ];
  const packagingMaterialIds: string[] = [];
  for (const [code, name] of PKG_MATS) {
    const existing = (await ctx.sql`select packaging_material_id as id from packaging.packaging_material_master where packaging_material_code = ${code} limit 1`)[0] as { id: string } | undefined;
    const pmId = existing
      ? existing.id
      : extractId(await ctx.svc.packagingCatalogService.createPackagingMaterial({ packagingMaterialCode: code, packagingMaterialName: name }, actor), 'packagingMaterialId');
    packagingMaterialIds.push(pmId);

    // Enough on-hand stock so the real PackagingOrdersService.issuePackagingMaterials() call
    // (real inventory.inventory_batch lock+allocate, see that method) can succeed for every
    // package order below, instead of every one hitting its real over-issue guard.
    const stocked = (await ctx.sql`select 1 from inventory.inventory_batch where material_id = ${pmId} limit 1`)[0];
    if (!stocked) {
      await ctx.svc.inventoryService.createInventoryBatch(
        { materialId: pmId, quantityOnHand: 1_000_000, storageLocationId: loc.storageLocationIds[0] }, actor,
      );
    }
  }

  const catCode = 'DEMO-CAT-EDP';
  const existingCat = (await ctx.sql`select product_category_id as id from packaging.product_category_master where category_code = ${catCode} limit 1`)[0] as { id: string } | undefined;
  const categoryId = existingCat
    ? existingCat.id
    : extractId(await ctx.svc.packagingCatalogService.createProductCategory({ categoryCode: catCode, categoryName: 'Demo Eau de Parfum' }, actor), 'productCategoryId');

  const skuIds: string[] = [];
  const skuCodes: string[] = [];
  for (let f = 0; f < vault.formulas.length; f++) {
    const formula = vault.formulas[f]!;
    const productCode = `DEMO-PRD-${String(f + 1).padStart(3, '0')}`;
    const existingP = (await ctx.sql`select product_id as id from packaging.product_master where product_code = ${productCode} limit 1`)[0] as { id: string } | undefined;
    const productId = existingP
      ? existingP.id
      : extractId(await ctx.svc.packagingCatalogService.createProduct({ formulaId: formula.formulaId, productCategoryId: categoryId, productCode, productName: formula.name }, actor), 'productId');

    for (const [suffix, size] of [['050', '50 ml'], ['100', '100 ml']] as const) {
      const skuCode = `DEMO-SKU-${String(f + 1).padStart(3, '0')}-${suffix}`;
      const existingS = (await ctx.sql`select product_sku_id as id from packaging.product_sku where sku_code = ${skuCode} limit 1`)[0] as { id: string } | undefined;
      const skuId = existingS
        ? existingS.id
        : extractId(await ctx.svc.packagingCatalogService.createProductSku({ productId, skuCode, packSize: size }, actor), 'productSkuId');

      for (const pmId of packagingMaterialIds) {
        const existingBom = (await ctx.sql`select 1 from packaging.packaging_bom_master where product_sku_id = ${skuId} and packaging_material_id = ${pmId} limit 1`)[0];
        if (existingBom) continue;
        await ctx.svc.packagingCatalogService.createPackagingBom({ productSkuId: skuId, packagingMaterialId: pmId, requiredQty: 1 }, actor);
      }
      skuIds.push(skuId);
      skuCodes.push(skuCode);
    }
  }
  out(`catalog: ${skuIds.length} SKUs ready across ${vault.formulas.length} demo products`);
  return { skuIds, skuCodes, packagingMaterialIds };
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: procurement — stock requirements → purchase requisitions (draft/submitted/approved)
 * → RFQs → quotations → awarded → purchase orders (draft/approved/issued/partial/complete/
 * cancelled/amended), real services throughout.
 * ════════════════════════════════════════════════════════════════════════ */

export interface PoLine { materialId: string; orderedQty: number; uomId?: string; rate: number; amount: number; }
export interface PoRecord { id: string; number: string; kind: string; vendorId: string; }

function poLinesFor(materials: DemoMaterial[], uom: Record<string, string>, seed: number, count: number): PoLine[] {
  const lines: PoLine[] = [];
  for (let i = 0; i < count; i++) {
    const m = pick(materials, seed + i);
    const qty = 50 + ((seed + i) % 8) * 25;
    const rate = 400 + ((seed + i) % 12) * 55;
    lines.push({ materialId: m.id, orderedQty: qty, uomId: uom.KG, rate, amount: qty * rate });
  }
  return lines;
}

async function findPoByNumber(ctx: Ctx, number: string): Promise<{ id: string } | null> {
  const row = (await ctx.sql`select purchase_order_id as id from procurement.purchase_order where po_number = ${number} limit 1`)[0] as { id: string } | undefined;
  return row ?? null;
}

/** 14 stock-requirement→PR chains: 6 stay DRAFT, 2 stay SUBMITTED (pending approval — also
 * feeds the PR-overdue alert demo), 4 go APPROVED→RFQ→quotations→awarded (feeding 4 of the
 * 40 POs via a real quotationId), 2 stay APPROVED with no RFQ yet. */
async function buildRequisitionsAndRfqs(
  ctx: Ctx, users: DemoUsers, materials: DemoMaterial[], vendors: DemoVendor[], uom: Record<string, string>,
) {
  const buyer = users.procurement;
  const awarder = users.owner; // real SoD: RFQ created by `buyer`, awarded by a different principal
  let purchaseRequestCount = 0;
  let rfqCount = 0;
  const quotationSeeds: Array<{ quotationId: string; vendorId: string; items: PoLine[] }> = [];

  for (let i = 0; i < 14; i++) {
    const prNumber = `DEMO-PR-${String(i + 1).padStart(4, '0')}`;
    const existingPr = (await ctx.sql`select purchase_request_id as id, status from procurement.purchase_request where pr_number = ${prNumber} limit 1`)[0] as { id: string; status: string | null } | undefined;

    let prId: string;
    let prStatus: string;
    const material = pick(materials, i * 5);
    if (existingPr) {
      prId = existingPr.id;
      prStatus = existingPr.status ?? 'DRAFT';
    } else {
      const sr = await ctx.svc.requirementService.createStockRequirement({
        materialId: material.id, requiredQty: 200 + i * 10, uomId: uom.KG,
        requiredByDate: isoDate(-(15 + i)), requirementSource: 'MANUAL_PLANNING', priority: i % 3 === 0 ? 'HIGH' : 'NORMAL',
      }, buyer);
      const stockRequirementId = extractId(sr, 'stockRequirementId');
      const pr = await ctx.svc.requirementService.createPurchaseRequest({
        prNumber, stockRequirementId, priority: i % 3 === 0 ? 'HIGH' : 'NORMAL', expectedDeliveryDate: isoDate(-(20 + i)),
      }, buyer);
      prId = extractId(pr, 'purchaseRequestId');
      await ctx.svc.requirementService.createPurchaseRequestItem({ purchaseRequestId: prId, materialId: material.id, requiredQty: 200 + i * 10, uomId: uom.KG }, buyer);
      prStatus = 'DRAFT';
    }
    purchaseRequestCount++;

    if (i < 6) continue; // 6 stay DRAFT

    if (prStatus === 'DRAFT') {
      await ctx.svc.requirementService.submitPurchaseRequest(prId, {}, buyer);
      prStatus = 'SUBMITTED';
    }
    if (i < 8) continue; // 2 stay SUBMITTED — pending approval (feeds the PR-overdue alert demo)

    if (prStatus === 'SUBMITTED') {
      await ctx.svc.requirementService.approvePurchaseRequest(prId, {}, awarder);
      prStatus = 'APPROVED';
    }
    if (i >= 12) continue; // 2 stay APPROVED, no RFQ yet

    const rfqNumber = `DEMO-RFQ-${String(i + 1).padStart(4, '0')}`;
    const existingRfq = (await ctx.sql`select rfq_id as id from procurement.rfq_master where rfq_number = ${rfqNumber} limit 1`)[0] as { id: string } | undefined;
    const rfqId = existingRfq
      ? existingRfq.id
      : extractId(await ctx.svc.rfqService.createRfqMaster({ rfqNumber, purchaseRequestId: prId, rfqDate: isoDate(-(18 + i)), submissionDeadline: isoDate(-(25 + i)) }, buyer), 'rfqId');
    if (!existingRfq) rfqCount++;

    const candidateVendors = Array.from(new Set([pick(vendors, i), pick(vendors, i + 3), pick(vendors, i + 6)].map((v) => v.id)))
      .map((id) => vendors.find((v) => v.id === id)!);

    // vi===0 is always this demo's designated awardee (deterministic given the same `vendors`
    // array and `i`) — tracked regardless of whether its quotation is new this run or already
    // existed, so `quotationSeeds` (and the PO it feeds in ensureProcurement) is populated
    // identically on every run, not just the first.
    let awardedQuotationId: string | null = null;
    let awardedVendorId: string | null = null;
    let awardedRate = 0;
    for (let vi = 0; vi < candidateVendors.length; vi++) {
      const v = candidateVendors[vi]!;
      const mapExists = (await ctx.sql`select 1 from procurement.rfq_vendor_mappings where rfq_id = ${rfqId} and vendor_id = ${v.id} limit 1`)[0];
      if (!mapExists) await ctx.svc.rfqService.createRfqVendorMapping({ rfqId, vendorId: v.id }, buyer);

      const qNumber = `DEMO-QUOT-${String(i + 1).padStart(4, '0')}-${v.code}`;
      const existingQ = (await ctx.sql`select quotation_id as id, status from procurement.quotations where quotation_number = ${qNumber} limit 1`)[0] as { id: string; status: string | null } | undefined;
      const rate = 420 + vi * 30;
      let quotationId: string;
      if (existingQ) {
        quotationId = existingQ.id;
      } else {
        quotationId = extractId(await ctx.svc.rfqService.createQuotation({ rfqId, vendorId: v.id, quotationNumber: qNumber, quotationDate: isoDate(-(16 + i)) }, buyer), 'quotationId');
        await ctx.svc.rfqService.createQuotationItem({ quotationId, materialId: material.id, quotedQty: 200 + i * 10, uomId: uom.KG, quotedRate: rate }, buyer);
      }
      if (vi === 0) {
        awardedQuotationId = quotationId;
        awardedVendorId = v.id;
        awardedRate = rate;
      }
    }

    if (awardedQuotationId && awardedVendorId) {
      const st = (await ctx.sql`select status from procurement.quotations where quotation_id = ${awardedQuotationId} limit 1`)[0] as { status: string | null } | undefined;
      if (st?.status !== 'SELECTED') {
        await ctx.svc.rfqService.selectQuotation(awardedQuotationId, { remarks: 'Best landed cost — ALEMBIC OS Demo Factory award.' }, awarder);
      }
      quotationSeeds.push({
        quotationId: awardedQuotationId,
        vendorId: awardedVendorId,
        items: [{ materialId: material.id, orderedQty: 200 + i * 10, uomId: uom.KG, rate: awardedRate, amount: (200 + i * 10) * awardedRate }],
      });
    }
  }

  return { purchaseRequestCount, rfqCount, quotationSeeds };
}

interface ProcurementResult {
  pos: PoRecord[];
  purchaseRequestCount: number;
  rfqCount: number;
}

async function ensureProcurement(
  ctx: Ctx, users: DemoUsers, materials: DemoMaterial[], vendors: DemoVendor[], uom: Record<string, string>,
): Promise<ProcurementResult> {
  const { purchaseRequestCount, rfqCount, quotationSeeds } = await buildRequisitionsAndRfqs(ctx, users, materials, vendors, uom);

  const buyer = users.procurement;
  const approver = users.owner; // real SoD: PO creator (buyer) !== approver (owner)

  type Kind = 'DRAFT' | 'APPROVED' | 'ISSUED_NO_GRN' | 'PARTIAL' | 'COMPLETE' | 'CANCELLED' | 'AMENDED';
  interface Plan { number: string; kind: Kind; vendorId?: string; items?: PoLine[]; quotationId?: string; }
  const plans: Plan[] = [];
  let n = 0;
  const add = (count: number, kind: Kind) => { for (let k = 0; k < count; k++) { n++; plans.push({ number: `DEMO-PO-${String(n).padStart(4, '0')}`, kind }); } };
  add(5, 'DRAFT');
  add(5, 'APPROVED');
  add(5, 'ISSUED_NO_GRN');
  add(8, 'PARTIAL');
  add(5, 'COMPLETE');
  add(3, 'CANCELLED');
  add(3, 'AMENDED');
  for (const seed of quotationSeeds) {
    n++;
    plans.push({ number: `DEMO-PO-${String(n).padStart(4, '0')}`, kind: 'COMPLETE', vendorId: seed.vendorId, items: seed.items, quotationId: seed.quotationId });
  }

  const pos: PoRecord[] = [];
  for (let idx = 0; idx < plans.length; idx++) {
    const plan = plans[idx]!;
    const existing = await findPoByNumber(ctx, plan.number);
    const vendor = plan.vendorId ? vendors.find((v) => v.id === plan.vendorId)! : pick(vendors, idx);
    if (existing) { pos.push({ id: existing.id, number: plan.number, kind: plan.kind, vendorId: vendor.id }); continue; }

    const items = plan.items ?? poLinesFor(materials, uom, idx * 3, plan.kind === 'PARTIAL' || plan.kind === 'COMPLETE' ? 3 + (idx % 3) : 1 + (idx % 3));

    const created = await ctx.svc.poService.createPurchaseOrder({
      poNumber: plan.number,
      vendorId: vendor.id,
      quotationId: plan.quotationId,
      orderDate: isoDate(80 - idx),
      items: items.map(({ materialId, orderedQty, uomId, rate, amount }) => ({ materialId, orderedQty, uomId, rate, amount })),
    }, buyer);
    const poId = extractId(created, 'purchaseOrderId');

    if (plan.kind !== 'DRAFT') {
      await ctx.svc.poService.approvePurchaseOrder(poId, { remarks: 'ALEMBIC OS Demo Factory — approved.' }, approver);
    }
    if (plan.kind === 'ISSUED_NO_GRN' || plan.kind === 'PARTIAL' || plan.kind === 'COMPLETE' || plan.kind === 'AMENDED') {
      await ctx.svc.poService.issuePurchaseOrder(poId, approver);
    }
    if (plan.kind === 'CANCELLED') {
      await ctx.svc.poService.cancelPurchaseOrder(poId, { reason: 'Demo: vendor could not meet the required delivery window.' }, approver);
    }
    if (plan.kind === 'AMENDED') {
      await ctx.svc.poService.amendPurchaseOrder(poId, { reason: 'Demo: quantity revised upward after a stronger sales forecast.' }, buyer);
    }

    pos.push({ id: poId, number: plan.number, kind: plan.kind, vendorId: vendor.id });
  }

  out(`procurement: ${purchaseRequestCount} PRs, ${rfqCount} RFQs, ${pos.length} POs`);
  return { pos, purchaseRequestCount, rfqCount };
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: receiving + incoming QC — gate entry → GRN → RM batch (real GrnService, which spawns
 * one rm_batch_master per item and emits `inventory.batch.created` for real) → the REAL G3
 * QuarantineIntakeService (ACTIVE→QUARANTINE + opens qc_inspections) → QC pending/pass/fail/
 * hold → the REAL G3 IncomingQcOutcomeService (PASS→RELEASED, FAIL→REJECTED + a REAL vendor
 * credit note).
 * ════════════════════════════════════════════════════════════════════════ */

export interface ReceivingResult {
  gateEntryCount: number;
  grnCount: number;
  rmBatchIds: string[];
  qcInspectionCount: number;
  creditNoteCount: number;
}

async function ensureReceivingAndQc(ctx: Ctx, users: DemoUsers, pos: PoRecord[], loc: LocationInfo): Promise<ReceivingResult> {
  const receivingActor = users.receiving;
  const qcActor = users.qc;

  let gateEntryCount = 0;
  let grnCount = 0;
  let qcInspectionCount = 0;
  const rmBatchIds: string[] = [];
  let outcomeCycle = 0;

  const eligible = pos.filter((p) => p.kind === 'PARTIAL' || p.kind === 'COMPLETE');
  for (let i = 0; i < eligible.length; i++) {
    const po = eligible[i]!;

    const geNumber = `DEMO-GE-${String(i + 1).padStart(4, '0')}`;
    const existingGe = (await ctx.sql`select gate_entry_id as id from inventory.gate_entry_master where gate_entry_number = ${geNumber} limit 1`)[0] as { id: string } | undefined;
    let gateEntryId: string;
    if (existingGe) {
      gateEntryId = existingGe.id;
    } else {
      const ge = await ctx.svc.gateService.createGateEntry({
        gateEntryNumber: geNumber, vendorId: po.vendorId, purchaseOrderId: po.id,
        vehicleNumber: `DEMO-MH-${1000 + i}`, driverName: pick(['R. Khan', 'S. Patil', 'A. Mehta', 'T. Joshi'], i),
        entryDt: ago(70 - i).toISOString(), documents: [],
      }, receivingActor);
      gateEntryId = extractId(ge, 'gateEntryId');
      gateEntryCount++;
    }

    const grnNumber = `DEMO-GRN-${String(i + 1).padStart(4, '0')}`;
    const existingGrn = (await ctx.sql`select 1 from inventory.grn_master where grn_number = ${grnNumber} limit 1`)[0];
    if (existingGrn) continue; // whole GRN→batch→QC chain for this PO already ran

    const lineRows = (await ctx.sql`
      select purchase_order_item_id as poi, material_id as mid, ordered_qty as qty, uom_id as uom
        from procurement.purchase_order_items where purchase_order_id = ${po.id}
    `) as Array<{ poi: string; mid: string | null; qty: string; uom: string | null }>;

    const items = lineRows.map((row, li) => {
      const ordered = Number(row.qty);
      const received = po.kind === 'PARTIAL' ? Math.max(1, Math.round(ordered * 0.6)) : ordered;
      return {
        purchaseOrderItemId: row.poi, materialId: row.mid ?? undefined, receivedQty: received,
        acceptedQty: received, rejectedQty: 0, uomId: row.uom ?? undefined,
        manufacturingDate: isoDate(75 - i - li), expiryDate: isoDate(-(700 - i)),
        storageLocationId: pick(loc.storageLocationIds, i + li),
        containers: [],
      };
    });

    const grn = await ctx.svc.grnService.createGrn(
      { grnNumber, gateEntryId, purchaseOrderId: po.id, vendorId: po.vendorId, grnDate: isoDate(70 - i), items }, receivingActor,
    );
    grnCount++;
    const batches = (grn as { batches: Array<{ rmBatchId: string }> }).batches;

    for (const b of batches) {
      rmBatchIds.push(b.rmBatchId);
      await callPrivate(ctx.svc.quarantineIntakeService, 'applyOne')(b.rmBatchId);

      const inspectionRow = (await ctx.sql`
        select qc_inspection_id as id from quality.qc_inspections where rm_batch_id = ${b.rmBatchId} order by created_dt desc limit 1
      `)[0] as { id: string } | undefined;
      if (!inspectionRow) continue;
      qcInspectionCount++;
      const inspectionId = inspectionRow.id;

      // Cycles PENDING/PASS/FAIL/HOLD across every batch — "incoming QC pending/pass/fail/hold".
      const outcome = pick(['PASS', 'PASS', 'PASS', 'FAIL', 'HOLD', 'PENDING'] as const, outcomeCycle++);
      if (outcome === 'PENDING') continue; // left PENDING on purpose

      await ctx.svc.inspectionsService.addResults(inspectionId, {
        results: [{
          observedValue: outcome === 'FAIL' ? 0.42 : 0.98,
          result: outcome === 'FAIL' ? 'Out of specification' : 'Within specification',
        }],
      }, qcActor);
      await ctx.svc.inspectionsService.dispose(inspectionId, {
        dispositionCode: outcome === 'PASS' ? 'ACCEPT' : outcome === 'FAIL' ? 'REJECT' : 'HOLD',
        dispositionReason: outcome === 'FAIL'
          ? 'Assay below the material specification range.'
          : outcome === 'HOLD' ? 'Borderline result — held for a second opinion.' : 'Meets specification.',
      }, qcActor);

      if (outcome === 'PASS' || outcome === 'FAIL') {
        const eventType = outcome === 'PASS' ? 'quality.qc.passed' : 'quality.qc.failed';
        const outboxRow = (await ctx.sql`
          select payload from quality.outbox where aggregate_id = ${inspectionId} and type = ${eventType} order by occurred_at desc limit 1
        `)[0] as { payload: unknown } | undefined;
        if (outboxRow) {
          await callPrivate(ctx.svc.incomingQcOutcomeService, 'applyOne')(inspectionId, eventType, outboxRow.payload);
        }
      }
    }
  }

  const creditNoteCount = Number(((await ctx.sql`select count(*)::int as c from procurement.vendor_credit_note where credit_note_number like 'CN-AUTO-%'`)[0] as { c: number }).c);

  out(`receiving: ${gateEntryCount} gate entries, ${grnCount} GRNs, ${rmBatchIds.length} RM batches, ${qcInspectionCount} QC inspections, ${creditNoteCount} automated vendor credit notes`);
  return { gateEntryCount, grnCount, rmBatchIds, qcInspectionCount, creditNoteCount };
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: warehouse ops — stock reservations + transfers over the RELEASED RM batches (real
 * StockService).
 * ════════════════════════════════════════════════════════════════════════ */

async function ensureWarehouseOps(ctx: Ctx, users: DemoUsers, rmBatchIds: string[]): Promise<{ reservations: number; transfers: number }> {
  if (rmBatchIds.length === 0) return { reservations: 0, transfers: 0 };
  const actor = users.warehouse;

  const releasedBatches = (await ctx.sql`
    select ib.inventory_batch_id as id, ib.quantity_on_hand as qty, ib.storage_location_id as loc
      from inventory.inventory_batch ib
      join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
     where rb.status = 'RELEASED' and rb.rm_batch_id = any(${rmBatchIds}::uuid[])
     order by ib.inventory_batch_id
  `) as Array<{ id: string; qty: string; loc: string | null }>;
  if (releasedBatches.length === 0) return { reservations: 0, transfers: 0 };

  const batchIds = releasedBatches.map((r) => r.id);
  const already = ((await ctx.sql`select count(*)::int as c from inventory.stock_reservation where inventory_batch_id = any(${batchIds}::uuid[])`)[0] as { c: number });
  if (already.c > 0) {
    const t = ((await ctx.sql`select count(*)::int as c from inventory.stock_transfer where inventory_batch_id = any(${batchIds}::uuid[])`)[0] as { c: number });
    return { reservations: already.c, transfers: t.c };
  }

  let reservations = 0;
  let transfers = 0;
  for (let i = 0; i < releasedBatches.length; i++) {
    const b = releasedBatches[i]!;
    const onHand = Number(b.qty);
    if (onHand <= 0) continue;
    if (i % 2 === 0) {
      await ctx.svc.stockService.createStockReservation(
        { inventoryBatchId: b.id, reservedQty: Math.max(1, Math.floor(onHand * 0.3)), reservedForDocumentId: randomUUID() }, actor,
      );
      reservations++;
    } else if (i % 5 === 1 && b.loc) {
      await ctx.svc.stockService.createStockTransfer(
        { inventoryBatchId: b.id, fromLocationId: b.loc, toLocationId: b.loc, transferQty: Math.max(1, Math.floor(onHand * 0.1)), requestedBy: actor.userId }, actor,
      );
      transfers++;
    }
  }
  out(`warehouse: ${reservations} stock reservations, ${transfers} stock transfers over released RM batches`);
  return { reservations, transfers };
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: bridge connector — self-service admin config (real ConfigAdminService); outbound
 * relay left disabled so this script never attempts a real HTTP POST (see file header).
 * ════════════════════════════════════════════════════════════════════════ */

async function ensureBridgeConnector(ctx: Ctx, actorId: string): Promise<void> {
  await ctx.svc.configAdminService.configure(
    { enabled: false, webhookUrl: 'https://alembic.example.invalid/bridge/inbound', hmacSecret: ctx.bridgeHmacSecret }, actorId,
  );
  out('bridge: connector configured (self-service admin config; outbound relay left disabled for the demo)');
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: bridge-originated production + the full factory floor — ALEMBIC → RawProd
 * ProductionRequirementCreated (real, signed, through ImporterService.handleAlembicEvent) →
 * real PlanningService.createOrder (bridge-linked, emits ProductionScheduled for real) → real
 * MaterialShortageService (drafts PRs for real when short) → mixing → oil batch → production
 * QC → packaging → filling → FG batch → packaging QC → the REAL G3 PackagingReleaseService →
 * FG reservation (ATP) → sales order → dispatch. Every one of the 7 bridge emission hooks
 * (backend-kernel's emitBridgeOutbound) fires from inside these REAL service calls, never
 * called directly by this script.
 * ════════════════════════════════════════════════════════════════════════ */

export interface BridgeStoryResult {
  requirementCount: number;
  productionOrderCount: number;
  mixingSessionCount: number;
  oilBatchCount: number;
  shortageDraftCount: number;
  packageOrderCount: number;
  fillingSessionCount: number;
  fgBatchCount: number;
  packagingQcCount: number;
  fgReservationCount: number;
  salesOrderCount: number;
  dispatchCount: number;
}

async function ensureCustomer(ctx: Ctx, actor: AuthPrincipal): Promise<string> {
  const code = 'DEMO-CUS-001';
  const existing = (await ctx.sql`select customer_id as id from sales.customer_master where customer_code = ${code} limit 1`)[0] as { id: string } | undefined;
  if (existing) return existing.id;
  const row = await ctx.svc.salesMastersService.createCustomer({ customerCode: code, customerName: 'Demo Factory Retail Partner' }, actor);
  return extractId(row, 'customerId');
}

async function ensureTransporter(ctx: Ctx, actor: AuthPrincipal): Promise<string> {
  const code = 'DEMO-TRN-001';
  const existing = (await ctx.sql`select transporter_id as id from sales.transporter_master where transporter_code = ${code} limit 1`)[0] as { id: string } | undefined;
  if (existing) return existing.id;
  const row = await ctx.svc.salesMastersService.createTransporter({ transporterCode: code, transporterName: 'Demo Logistics Partner' }, actor);
  return extractId(row, 'transporterId');
}

async function ensureBridgeProductionAndFactory(
  ctx: Ctx, users: DemoUsers, catalog: CatalogResult, vault: VaultResult,
): Promise<BridgeStoryResult> {
  let requirementCount = 0;
  let productionOrderCount = 0;
  let mixingSessionCount = 0;
  let oilBatchCount = 0;
  let shortageDraftCount = 0;
  let packageOrderCount = 0;
  let fillingSessionCount = 0;
  let fgBatchCount = 0;
  let packagingQcCount = 0;
  let fgReservationCount = 0;
  let salesOrderCount = 0;
  let dispatchCount = 0;

  const customerId = await ensureCustomer(ctx, users.sales);
  const transporterId = await ensureTransporter(ctx, users.sales);

  for (let i = 0; i < PRODUCTION_ORDER_COUNT; i++) {
    if (process.env.DEMO_SEED_DEBUG) out(`DEBUG bridge/factory loop i=${i}`);
    const ordNumber = DEMO_ORD_START + i; // 3..32
    const orderRef = `DEMO-ORD-${String(ordNumber).padStart(4, '0')}`;
    const skuIdx = i % catalog.skuIds.length;
    const skuId = catalog.skuIds[skuIdx]!;
    const skuCode = catalog.skuCodes[skuIdx]!;
    const version = vault.formulas[Math.floor(skuIdx / 2) % vault.formulas.length]!;

    let requirementRow = (await ctx.sql`
      select alembic_requirement_id as id, production_order_id as poid from bridge.production_requirement where order_ref = ${orderRef} limit 1
    `)[0] as { id: string; poid: string | null } | undefined;

    let alembicRequirementId: string;
    if (!requirementRow) {
      alembicRequirementId = randomUUID();
      const envelope = {
        event_id: randomUUID(), version: 1, type: 'ProductionRequirementCreated',
        org_id: DEMO_ALEMBIC_ORG_ID, correlation_id: randomUUID(), causation_id: null,
        occurred_at: new Date().toISOString(), source: 'alembic',
        aggregate: { type: 'production_requirement', id: alembicRequirementId },
        payload: {
          requirement_id: alembicRequirementId, order_ref: orderRef, mapped_sku: skuCode,
          qty: 200 + i * 5, uom: 'EA', pack_size: null, needed_by: isoDate(-(20 + i)),
          priority: i % 4 === 0 ? 'high' : 'normal',
        },
      };
      const body = JSON.stringify(envelope);
      const sig = signBody(body, ctx.bridgeHmacSecret);
      const result = await ctx.svc.importerService.handleAlembicEvent(body, sig);
      if (result.status !== 200) throw new Error(`bridge import failed for ${orderRef}: ${JSON.stringify(result.body)}`);
      requirementCount++;
      requirementRow = { id: alembicRequirementId, poid: null };
    } else {
      alembicRequirementId = requirementRow.id;
      requirementCount++;
    }

    if (requirementRow.poid) {
      // The whole downstream chain for this order already ran on a prior pass.
      productionOrderCount++;
      continue;
    }

    const bucket = i < 6 ? 'SHORTAGE' : i < 14 ? 'IN_PROGRESS' : 'COMPLETED';
    const orderQty = 150 + (i % 5) * 20;
    const created = await ctx.svc.planningService.createOrder(
      { formulaVersionId: version.versionId, orderQty, alembicRequirementId }, users.production,
    );
    const productionOrderId = extractId(created, 'productionOrderId');
    productionOrderCount++;

    const beforeDrafts = ((await ctx.sql`
      select count(*)::int as c from procurement.purchase_request
       where stock_requirement_id in (select stock_requirement_id from procurement.stock_requirement where requirement_source = ${'PRODUCTION_ORDER:' + productionOrderId})
    `)[0] as { c: number }).c;
    await callPrivate(ctx.svc.materialShortageService, 'applyOne')(productionOrderId);
    const afterDrafts = ((await ctx.sql`
      select count(*)::int as c from procurement.purchase_request
       where stock_requirement_id in (select stock_requirement_id from procurement.stock_requirement where requirement_source = ${'PRODUCTION_ORDER:' + productionOrderId})
    `)[0] as { c: number }).c;
    shortageDraftCount += Math.max(0, afterDrafts - beforeDrafts);

    if (bucket === 'SHORTAGE') continue; // stays PLANNING — "waiting on material"

    // Coded manufacturing instruction — real PickingService.resolveManufacturingInstruction,
    // itself funnelled through the REAL FormulaLookupService → VaultService.decryptVersion
    // (APPROVED-only, mandatory audit). Alias-coded only (never a raw material_id) — this is
    // the "coded manufacturing instructions via the normal Vault workflow" the lane asks for.
    await ctx.svc.pickingService.generatePickList(productionOrderId, {}, users.production);
    await ctx.svc.pickingService.resolveManufacturingInstruction(productionOrderId, users.compounding);

    const session = await ctx.svc.mixingService.startSession(
      { productionOrderId, operatorId: users.compounding.userId, sessionStartDt: ago(80 - i * 2).toISOString() }, users.compounding,
    );
    const sessionId = extractId(session, 'secureMixingSessionId');
    mixingSessionCount++;
    await ctx.svc.mixingService.logStep(sessionId, {
      stepSequence: 1, stepDescription: 'Charge base + heart notes per the coded manufacturing instruction.',
      performedBy: users.compounding.userId, performedDt: ago(79 - i * 2).toISOString(),
    }, users.compounding);

    if (bucket === 'IN_PROGRESS') continue; // mixing under way, nothing produced yet

    await ctx.svc.mixingService.endSession(sessionId, { sessionEndDt: ago(78 - i * 2).toISOString() }, users.compounding);

    const oilBatchNumber = `DEMO-OIL-${String(i + 1).padStart(4, '0')}`;
    const oilBatch = await ctx.svc.productionBatchService.produceOilBatch({
      productionOrderId, secureMixingSessionId: sessionId, batchNumber: oilBatchNumber,
      producedQty: Math.floor(orderQty * 0.95), producedDt: ago(77 - i * 2).toISOString(),
    }, users.compounding);
    const oilBatchId = extractId(oilBatch, 'oilBatchId');
    oilBatchCount++;
    await ctx.svc.productionBatchService.recordProductionQc({
      oilBatchId, observedValue: 0.97, specMin: 0.9, specMax: 1.1, inspectedBy: users.qc.userId, inspectionDt: ago(76 - i * 2).toISOString(),
    }, users.qc);
    await ctx.svc.productionBatchService.transitionOilBatch(oilBatchId, 'IN_MATURATION', users.qc);
    await ctx.svc.productionBatchService.transitionOilBatch(oilBatchId, 'RELEASED', users.qc);

    const packageOrder = await ctx.svc.packagingOrdersService.createPackageOrder({
      productSkuId: skuId, oilBatchId, orderQty: Math.floor(orderQty * 0.9), plannedStartDt: ago(60 - i * 2).toISOString(),
    }, users.packaging);
    const packageOrderId = extractId(packageOrder, 'packageOrderId');
    packageOrderCount++;
    await ctx.svc.packagingOrdersService.issuePackagingMaterials(packageOrderId, users.packaging);

    const filling = await ctx.svc.packagingOrdersService.startFillingSession(
      { packageOrderId, operatorId: users.filling.userId, sessionStartDt: ago(58 - i * 2).toISOString() }, users.filling,
    );
    const fillingSessionId = extractId(filling, 'fillingSessionId');
    fillingSessionCount++;
    await ctx.svc.packagingOrdersService.recordFilling(fillingSessionId, {
      filledQty: Math.floor(orderQty * 0.88), rejectedQty: 2, recordedDt: ago(57 - i * 2).toISOString(),
    }, users.filling);
    await ctx.svc.packagingOrdersService.endFillingSession(fillingSessionId, { sessionEndDt: ago(56 - i * 2).toISOString() }, users.filling);

    const fgBatchNumber = `DEMO-FG-${String(i + 1).padStart(4, '0')}`;
    const fgBatch = await ctx.svc.packagingBatchService.produceFinishedGoodBatch({
      packageOrderId, productSkuId: skuId, batchNumber: fgBatchNumber, producedQty: Math.floor(orderQty * 0.88),
      manufacturingDate: isoDate(55 - i * 2), expiryDate: isoDate(-1090),
    }, users.packaging);
    const fgBatchId = extractId(fgBatch, 'finishedGoodBatchId');
    fgBatchCount++;

    const pkgOutcome: 'PASS' | 'FAIL' = i % 9 === 8 ? 'FAIL' : 'PASS';
    await ctx.svc.packagingQcService.create({
      finishedGoodBatchId: fgBatchId, leakageCheck: 'PASS', labelCheck: 'PASS',
      cartonCheck: pkgOutcome === 'FAIL' ? 'FAIL' : 'PASS', overallResult: pkgOutcome,
    }, users.qc);
    packagingQcCount++;
    const pkgQcRow = (await ctx.sql`
      select packaging_qc_id as id from packaging.packaging_qc where finished_good_batch_id = ${fgBatchId} order by created_dt desc limit 1
    `)[0] as { id: string } | undefined;
    if (pkgQcRow) {
      const outboxRow = (await ctx.sql`
        select payload from packaging.outbox where aggregate_id = ${pkgQcRow.id} and type = 'packaging.qc.recorded' order by occurred_at desc limit 1
      `)[0] as { payload: unknown } | undefined;
      if (outboxRow) await callPrivate(ctx.svc.packagingReleaseService, 'applyOne')(pkgQcRow.id, outboxRow.payload);
    }
    if (pkgOutcome === 'FAIL') continue; // FG held — no reservation/dispatch for this one

    await ctx.svc.reservationService.createReservation(
      { finishedGoodBatchId: fgBatchId, productSkuId: skuId, reservedQty: Math.floor(orderQty * 0.2), reservedForDocumentId: randomUUID() }, users.sales,
    );
    fgReservationCount++;

    const soNumber = `DEMO-SO-${String(i + 1).padStart(4, '0')}`;
    const existingSo = (await ctx.sql`select sales_order_id as id from sales.sales_order where so_number = ${soNumber} limit 1`)[0] as { id: string } | undefined;
    let salesOrderId: string;
    if (existingSo) {
      salesOrderId = existingSo.id;
    } else {
      const so = await ctx.svc.salesOrdersService.createSalesOrder({
        soNumber, customerId,
        items: [{ productSkuId: skuId, orderedQty: Math.floor(orderQty * 0.4), amount: Math.floor(orderQty * 0.4) * 900 }],
        reason: 'ALEMBIC OS Demo Factory — commercial order mirrored for the dispatch story.',
      }, users.sales);
      salesOrderId = extractId(so, 'salesOrderId');
      salesOrderCount++;
      await ctx.svc.salesOrdersService.confirmSalesOrder(salesOrderId, { reason: 'ALEMBIC OS Demo Factory — confirmed.' }, users.sales);
    }

    const salesItemRow = (await ctx.sql`select sales_order_item_id as id from sales.sales_order_items where sales_order_id = ${salesOrderId} limit 1`)[0] as { id: string } | undefined;

    await ctx.svc.dispatchService.createDispatch({
      salesOrderId, customerId, transporterId, vehicleNumber: `DEMO-DL-${2000 + i}`,
      items: [{ salesOrderItemId: salesItemRow?.id, finishedGoodBatchId: fgBatchId, dispatchedQty: Math.floor(orderQty * 0.4) }],
    }, users.sales);
    dispatchCount++;
  }

  out(`bridge/factory: ${requirementCount} DEMO-ORD requirements, ${productionOrderCount} production orders`);
  return {
    requirementCount, productionOrderCount, mixingSessionCount, oilBatchCount, shortageDraftCount,
    packageOrderCount, fillingSessionCount, fgBatchCount, packagingQcCount, fgReservationCount,
    salesOrderCount, dispatchCount,
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: automation — one REAL retry example, one REAL dead-letter example.
 *
 * Both start from the exact same real, deterministic failure mode: a production order with a
 * genuine material shortage, where the shortfall calculation (MaterialShortageService.evaluate)
 * is pushed past `numeric(18,4)`'s 14-integer-digit range by one pre-existing, absurdly
 * oversized `inventory.stock_reservation` row against that material (inserted directly here —
 * StockService's OWN createStockReservation would correctly REFUSE an over-reservation against
 * zero on-hand, which is the point: this fixture models a bad legacy row / a since-fixed import
 * bug, not something the live system can create today). That is a REAL Postgres numeric-
 * overflow thrown by REAL code (backend/api/src/automation/material-shortage.service.ts), caught
 * by the REAL ledger (backend/api/src/automation/ledger.ts), which is what genuinely marks the
 * automation.applied row FAILED and increments attempts — nothing about the failure itself is
 * fabricated.
 *   RETRY:       fails once for real, a REAL StockService.releaseStockReservation clears the bad
 *                reservation, and the NEXT real attempt succeeds — a real decision_log row.
 *   DEAD-LETTER: the same real failure, five real attempts, never fixed — a real
 *                automation.dead_letter row, written by the real ledger.ts catch path.
 * ════════════════════════════════════════════════════════════════════════ */

const MATERIAL_SHORTAGE_RULE = 'material_shortage_to_draft_pr';

async function poisonProductionOrder(ctx: Ctx, marker: string, materialId: string): Promise<string> {
  const existing = (await ctx.sql`
    select po.production_order_id as id
      from production.production_order po
      join production.production_order_ingredients i on i.production_order_id = po.production_order_id
     where i.material_id = ${materialId}
     limit 1
  `)[0] as { id: string } | undefined;
  if (existing) return existing.id;

  const productionDb = dbFor(ctx.sql, productionSchema);
  const stub = {
    async getFloorView() { return null; },
    async resolveManufacturingInstruction() { return null; },
    async getPickList() { return [{ materialId, percentage: 100, sequenceNo: 1 }]; },
  };
  const planning = new PlanningService(productionDb, stub);
  const bootstrap = principalFor(randomUUID(), ['production']);
  const created = await planning.createOrder({ formulaVersionId: randomUUID(), orderQty: 10 }, bootstrap);
  const productionOrderId = extractId(created, 'productionOrderId');

  const batchId = randomUUID();
  await ctx.sql`
    insert into inventory.inventory_batch (inventory_batch_id, material_id, quantity_on_hand, status, created_by, updated_by)
    values (${batchId}, ${materialId}, 0, 'ACTIVE', 'automation:demo-seed', 'automation:demo-seed')
  `;
  // `reserved_for_document_id` is a uuid column — the human-readable `marker` (e.g.
  // "DEMO-AUTOMATION-RETRY") lives only in this function's log/comment trail, not the row
  // itself; the row is found downstream by its material_id, not this id.
  out(`automation demo: poisoning ${marker} via inventory_batch ${batchId}`);
  await ctx.sql`
    insert into inventory.stock_reservation (stock_reservation_id, inventory_batch_id, reserved_qty, reserved_for_document_id, status, created_by, updated_by)
    values (${randomUUID()}, ${batchId}, 99999999999999, ${randomUUID()}, 'ACTIVE', 'automation:demo-seed', 'automation:demo-seed')
  `;
  return productionOrderId;
}

export interface AutomationDemoResult {
  retry: 'recovered' | 'skipped';
  deadLetter: 'dead-lettered' | 'skipped';
}

async function ensureAutomationRetryAndDeadLetterDemo(ctx: Ctx, owner: AuthPrincipal, materials: DemoMaterial[]): Promise<AutomationDemoResult> {
  const poisonMaterialRetry = materials[materials.length - 1]!.id;
  const poisonMaterialDeadLetter = materials[materials.length - 2]!.id;

  let retry: AutomationDemoResult['retry'] = 'skipped';
  const retryOrderId = await poisonProductionOrder(ctx, 'DEMO-AUTOMATION-RETRY', poisonMaterialRetry);
  const retryAlreadyDone = (await ctx.sql`
    select 1 from automation.applied where rule_code = ${MATERIAL_SHORTAGE_RULE} and dedupe_key = ${retryOrderId} and status = 'DONE' limit 1
  `)[0];
  if (retryAlreadyDone) {
    retry = 'recovered';
  } else {
    await callPrivate(ctx.svc.materialShortageService, 'applyOne')(retryOrderId); // real failure #1 (numeric overflow)
    const reservationRow = (await ctx.sql`
      select sr.stock_reservation_id as id from inventory.stock_reservation sr
        join inventory.inventory_batch ib on ib.inventory_batch_id = sr.inventory_batch_id
       where ib.material_id = ${poisonMaterialRetry} and sr.released_dt is null limit 1
    `)[0] as { id: string } | undefined;
    if (reservationRow) {
      await ctx.svc.stockService.releaseStockReservation(reservationRow.id, owner); // real recovery
    }
    await callPrivate(ctx.svc.materialShortageService, 'applyOne')(retryOrderId); // real retry — succeeds
    const nowRow = (await ctx.sql`select status from automation.applied where rule_code = ${MATERIAL_SHORTAGE_RULE} and dedupe_key = ${retryOrderId} limit 1`)[0] as { status: string } | undefined;
    retry = nowRow?.status === 'DONE' ? 'recovered' : 'skipped';
  }

  let deadLetter: AutomationDemoResult['deadLetter'] = 'skipped';
  const dlOrderId = await poisonProductionOrder(ctx, 'DEMO-AUTOMATION-DEADLETTER', poisonMaterialDeadLetter);
  const alreadyDead = (await ctx.sql`select 1 from automation.dead_letter where rule_code = ${MATERIAL_SHORTAGE_RULE} and dedupe_key = ${dlOrderId} limit 1`)[0];
  if (alreadyDead) {
    deadLetter = 'dead-lettered';
  } else {
    for (let attempt = 0; attempt < 5; attempt++) {
      await callPrivate(ctx.svc.materialShortageService, 'applyOne')(dlOrderId); // 5 real, identical failures
    }
    const dead = (await ctx.sql`select 1 from automation.dead_letter where rule_code = ${MATERIAL_SHORTAGE_RULE} and dedupe_key = ${dlOrderId} limit 1`)[0];
    deadLetter = dead ? 'dead-lettered' : 'skipped';
  }

  out(`automation demo: retry=${retry}, dead-letter=${deadLetter}`);
  return { retry, deadLetter };
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: alerts — real AutomationAlertsService.scan(), after narrowly backdating a couple of
 * rows past the alert thresholds (see the file-level comment on this being the ONE deliberate
 * direct-timestamp touch in this script).
 * ════════════════════════════════════════════════════════════════════════ */

async function ensureAlerts(ctx: Ctx): Promise<number> {
  // Deterministic ORDER BY so the SAME rows are picked (and re-backdated to the same idempotent
  // result) on every run — without it, Postgres may return a DIFFERENT arbitrary 2 rows under
  // `LIMIT` on a second run, ageing a different pair each time and growing the alert count
  // forever instead of staying at one alert per offending row, ever (automation.applied's own
  // exactly-once contract, which this demo fixture must not defeat by moving the target).
  await ctx.sql`
    update quality.qc_inspections set updated_dt = now() - interval '4 days'
     where qc_inspection_id in (
       select qc_inspection_id from quality.qc_inspections where overall_result = 'HOLD' order by qc_inspection_id limit 2
     )
  `;
  await ctx.sql`
    update procurement.purchase_request set updated_dt = now() - interval '5 days'
     where purchase_request_id in (
       select purchase_request_id from procurement.purchase_request where status = 'SUBMITTED' order by pr_number limit 2
     )
  `;
  await ctx.sql`
    update procurement.purchase_order set updated_dt = now() - interval '5 days'
     where purchase_order_id in (
       select purchase_order_id from procurement.purchase_order where status = 'DRAFT' order by po_number limit 2
     )
  `;

  await callPrivate(ctx.svc.alertsService, 'scan')();

  const raised = ((await ctx.sql`
    select count(*)::int as c from platform.notification_log
     where event_type in ('quality.qc.hold_overdue', 'procurement.pr.overdue', 'procurement.po.overdue')
  `)[0] as { c: number }).c;
  out(`alerts: ${raised} raised (QC HOLD age / PR overdue / PO overdue)`);
  return raised;
}

/* ════════════════════════════════════════════════════════════════════════
 * Phase: tutorial progress
 * ════════════════════════════════════════════════════════════════════════ */

async function ensureTutorialProgress(ctx: Ctx, users: DemoUsers): Promise<number> {
  const plan: Array<{ principal: AuthPrincipal; role: string; lessonId: string; events: Array<'start' | 'advance' | 'seen' | 'dismiss'> }> = [
    { principal: users.procurement, role: 'procurement', lessonId: 'procurement-reorder-to-requirement', events: ['start', 'advance', 'advance'] },
    { principal: users.receiving, role: 'receiving', lessonId: 'receiving-gate-to-grn', events: ['start', 'advance', 'advance', 'advance'] },
    { principal: users.warehouse, role: 'warehouse', lessonId: 'warehouse-stock-adjustment', events: ['start', 'seen'] },
    { principal: users.qc, role: 'qc', lessonId: 'qc-record-results', events: ['start', 'advance'] },
    { principal: users.production, role: 'production', lessonId: 'production-plan-create', events: ['start', 'advance', 'advance', 'advance'] },
    { principal: users.packaging, role: 'packaging', lessonId: 'packaging-qc-record', events: ['start'] },
    // The lesson's own track is 'dispatch' (tutorial-lessons.ts), reachable by the 'sales' role
    // (reachableTutorialTracks: dispatch -> ['sales']) — `role` here names the TRACK, not the
    // principal's role.
    { principal: users.sales, role: 'dispatch', lessonId: 'dispatch-confirmed-order', events: ['start', 'advance'] },
  ];
  let rows = 0;
  for (const p of plan) {
    const existing = (await ctx.sql`
      select 1 from platform.tutorial_progress where user_id = ${p.principal.userId} and role = ${p.role} and lesson_id = ${p.lessonId} limit 1
    `)[0];
    if (!existing) {
      for (const event of p.events) {
        await ctx.svc.tutorialService.applyEvent(p.principal, p.lessonId, { role: p.role, event: { type: event } });
      }
    }
    rows++;
  }
  out(`tutorial: ${rows} progress rows`);
  return rows;
}

/* ════════════════════════════════════════════════════════════════════════
 * CLI entry point — `pnpm demo:seed` / `tsx scripts/demo-seed.ts`
 * ════════════════════════════════════════════════════════════════════════ */

const isMainModule = (() => {
  try { return !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]; }
  catch { return false; }
})();

if (isMainModule) {
  runDemoSeed()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
