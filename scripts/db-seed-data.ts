/* Phase-1 demo data seed — a coherent perfume-manufacturing dataset across all 12 modules so
 * every role's dashboard is populated. DB is the source of truth; the portal renders this.
 * Idempotent: clears the demo tables (not iam auth) then re-inserts. Run:
 *   DATABASE_URL=... pnpm db:seed:data */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@core/data-kernel';
import * as md from '@ra/data-masterdata';
import * as proc from '@ra/data-procurement';
import * as inv from '@ra/data-inventory';
import * as qual from '@ra/data-quality';
import * as loc from '@ra/data-location';
import * as fm from '@ra/data-formula';
import * as prod from '@ra/data-production';
import * as pkg from '@ra/data-packaging';
import * as sales from '@ra/data-sales';

const id = () => uuidv7();
/** Real seeded `owner` user — created_by/updated_by are uuid FKs, not free text. */
const ACTOR = '019efe38-c5c3-74ef-a499-31e8bc10719b';
const meta = (status = 'ACTIVE') => ({ status, createdBy: ACTOR, updatedBy: ACTOR });
const n = (x: number) => String(x);
const DAY = 86400000;
const ago = (d: number) => new Date(Date.now() - d * DAY);
const dstr = (d: number) => ago(d).toISOString().slice(0, 10);
const pick = <T>(a: T[], i: number) => a[i % a.length] as T;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  const client = postgres(url, { max: 1, prepare: false });
  const db = drizzle(client);
  try {
    // ── clear demo tables (FK-safe: lines before headers; NEVER iam auth tables) ──
    const clear = [
      sales.dispatchItems, sales.dispatchMaster, sales.salesOrderItems, sales.salesOrder, sales.transporterMaster, sales.customerMaster,
      pkg.finishedGoodsBatchConsumption, pkg.finishedGoodBatchMaster, pkg.fillingSessionDetails, pkg.fillingSession, pkg.packageOrderItem, pkg.packageOrder, pkg.packagingBomMaster, pkg.productSku, pkg.productMaster, pkg.packagingMaterialMaster, pkg.productCategoryMaster,
      prod.oilBatchQcHistory, prod.productionQc, prod.oilBatchEventHistory, prod.oilBatchConsumption, prod.oilBatchMaster, prod.mixingStepLog, prod.secureMixingSession, prod.materialIssueItem, prod.materialIssue, prod.materialPickListItems, prod.materialPickList, prod.productionOrderIngredients, prod.productionOrder, prod.productionPlanItems, prod.productionPlan,
      fm.formulaEventHist, fm.formulaIngredients, fm.formulaStageIngredients, fm.formulaStageMaster, fm.formulaApproval, fm.formulaVersion, fm.formulaVault, fm.formulaMaster, fm.formulaTypeMaster,
      qual.qcResultDetails, qual.qcSampleRetention, qual.qcDisposition, qual.qcInspections, qual.qcParameterMaster,
      inv.stockTransfer, inv.inventoryBatch, inv.rmBatchMaster, inv.grnItems, inv.grnMaster, inv.gateEntryMaster,
      proc.purchaseOrderItems, proc.purchaseOrder, proc.quotationItems, proc.quotations, proc.purchaseRequestItems, proc.purchaseRequest, proc.vendorMaterialMap, proc.vendorDetails,
      md.materialQcSpecifications, md.materialStorageRules, md.rmAlias, md.material, md.materialSubcategoryMaster, md.materialCategoryMaster, md.materialGroup, md.materialTypeMaster,
      loc.rackMaster, loc.zoneMaster, loc.warehouseMaster, loc.locationMaster,
    ];
    for (const t of clear) { try { await db.delete(t); } catch { /* table may differ; skip */ } }

    // ── M01 location: a warehouse with 4 zones (Citrus/Amber/Florals/Flammables) + racks ──
    const locId = id();
    await db.insert(loc.locationMaster).values({ locationId: locId, locationCode: 'WH-04', locationName: 'Maison Secure · Factory Warehouse', ...meta() });
    const whId = id();
    await db.insert(loc.warehouseMaster).values({ warehouseId: whId, locationId: locId, warehouseCode: 'WH-04', warehouseName: 'Maison Secure', ...meta() });
    const ZONES = [['Z1', 'Citrus'], ['Z2', 'Amber'], ['Z3', 'Florals'], ['Z4', 'Flammables']];
    const zoneIds: string[] = [];
    for (const [zc, zn] of ZONES) { const z = id(); zoneIds.push(z); await db.insert(loc.zoneMaster).values({ zoneId: z, zoneCode: zc, zoneName: `${zc} · ${zn}`, ...meta() }); }
    for (let r = 1; r <= 9; r++) await db.insert(loc.rackMaster).values({ rackId: id(), zoneId: pick(zoneIds, r), rackCode: `R-${r}`, rackName: `Rack ${r}`, ...meta() });

    // ── M02 materials + masking aliases ──
    const TYPES = [['AC', 'Aroma Chemical'], ['EO', 'Essential Oil'], ['CO', 'Carrier Oil'], ['SO', 'Solvent']];
    const typeIds: Record<string, string> = {};
    for (const [tc, tn] of TYPES) { const t = id(); typeIds[tc] = t; await db.insert(md.materialTypeMaster).values({ materialTypeId: t, typeCode: tc, typeName: tn, ...meta() }); }
    const MATS = [
      ['RM-00117', 'Methyl dihydrojasmonate (Hedione)', 'AC'], ['RM-00042', 'Bergamot Oil · Calabria', 'EO'],
      ['RM-00231', 'Iso E Super', 'AC'], ['BASE-7741', 'Ambroxan', 'AC'], ['RM-00500', 'Dipropylene Glycol', 'SO'],
      ['RM-00088', 'Vetiver Oil · Haiti', 'EO'], ['RM-00301', 'Cedarwood · Virginia', 'EO'], ['RM-00412', 'Patchouli Oil', 'EO'],
      ['RM-00210', 'Rose Absolute', 'EO'], ['RM-00155', 'Vanillin', 'AC'], ['RM-00190', 'Coumarin', 'AC'], ['RM-00077', 'Linalool', 'AC'],
    ];
    const matIds: string[] = [];
    MATS.forEach((m, i) => { const mid = id(); matIds.push(mid); });
    for (let i = 0; i < MATS.length; i++) {
      await db.insert(md.material).values({ materialId: matIds[i], materialTypeId: typeIds[MATS[i][2]], materialCode: MATS[i][0], materialName: MATS[i][1], ...meta() });
      await db.insert(md.rmAlias).values({ rmAliasId: id(), materialId: matIds[i], aliasName: 'ING-A' + String(i + 1).padStart(3, '0'), aliasType: 'FLOOR', ...meta() });
    }

    // ── M03 vendors ──
    const VENDORS = [['VEN-001', 'Firmenich'], ['VEN-002', 'Givaudan'], ['VEN-003', 'IFF'], ['VEN-004', 'Robertet'], ['VEN-005', 'Symrise']];
    const vendorIds: string[] = [];
    for (const [vc, vn] of VENDORS) { const v = id(); vendorIds.push(v); await db.insert(proc.vendorDetails).values({ vendorId: v, vendorCode: vc, vendorName: vn, paymentTerms: 'NET 30', ...meta('APPROVED') }); }

    // ── M04 procurement: PRs + POs ──
    const PRS = [['PR-2406-101', 'HIGH'], ['PR-2406-102', 'MED'], ['PR-2406-103', 'HIGH'], ['PR-2406-104', 'LOW']];
    for (let i = 0; i < PRS.length; i++) await db.insert(proc.purchaseRequest).values({ purchaseRequestId: id(), prNumber: PRS[i][0], priority: PRS[i][1], expectedDeliveryDate: dstr(-7 + i), ...meta(['APPROVED', 'PENDING', 'APPROVED', 'DRAFT'][i]) });
    const POSTAT = ['ORDERED', 'APPROVED', 'PENDING', 'ORDERED', 'APPROVED', 'PENDING'];
    const poIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const po = id(); poIds.push(po);
      await db.insert(proc.purchaseOrder).values({ purchaseOrderId: po, poNumber: `PO-2406-${201 + i}`, vendorId: pick(vendorIds, i), orderDate: dstr(10 - i), totalAmount: n(12000 + i * 4500), ...meta(POSTAT[i]) });
      await db.insert(proc.purchaseOrderItems).values({ purchaseOrderItemId: id(), purchaseOrderId: po, materialId: pick(matIds, i), orderedQty: n(25 + i * 10), rate: n(120 + i * 30), amount: n((25 + i * 10) * (120 + i * 30)), ...meta() });
    }

    // ── QC parameter catalog (reference data, not per-batch — P0 follow-up on lane B1: the
    // "Record results" QC form has nothing to pick from without this). Standard perfume-oil
    // release checks; uom_id left null (this script doesn't seed platform.uom_master).
    const QC_PARAMS: [string, string][] = [
      ['APPEARANCE', 'Appearance'],
      ['COLOUR', 'Colour'],
      ['ODOUR', 'Odour'],
      ['SG20', 'Specific Gravity @ 20°C'],
      ['RI20', 'Refractive Index @ 20°C'],
      ['FLASHPT', 'Flash Point'],
      ['ACIDVAL', 'Acid Value'],
    ];
    for (const [code, name] of QC_PARAMS) {
      await db.insert(qual.qcParameterMaster).values({ qcParameterId: id(), parameterCode: code, parameterName: name, ...meta() });
    }

    // ── M05 receiving + QC: gate → GRN → RM batch → inventory ──
    const batchIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const ge = id(), grn = id(), batch = id();
      await db.insert(inv.gateEntryMaster).values({ gateEntryId: ge, gateEntryNumber: `GE-2406-${10 + i}`, vendorId: pick(vendorIds, i), purchaseOrderId: pick(poIds, i), vehicleNumber: `MH-12-${1000 + i * 37}`, driverName: ['R. Khan', 'S. Patil', 'A. Mehta', 'T. Joshi'][i % 4], entryDt: ago(6 - i * 0.4), ...meta() });
      await db.insert(inv.grnMaster).values({ grnId: grn, grnNumber: `GRN-2406-${18 + i}`, gateEntryId: ge, purchaseOrderId: pick(poIds, i), vendorId: pick(vendorIds, i), grnDate: dstr(6 - i), ...meta(['RECEIVED', 'PENDING'][i % 2]) });
      await db.insert(inv.grnItems).values({ grnItemId: id(), grnId: grn, materialId: pick(matIds, i), receivedQty: n(25 + i * 5), acceptedQty: n(25 + i * 5), rejectedQty: n(0), ...meta() });
      batchIds.push(batch);
      await db.insert(inv.rmBatchMaster).values({ rmBatchId: batch, materialId: pick(matIds, i), batchNumber: `F24-08${15 + i}`, manufacturingDate: dstr(40 - i), expiryDate: dstr(-700 - i), receivedQty: n(25 + i * 5), storageLocationId: locId, ...meta() });
      await db.insert(inv.inventoryBatch).values({ inventoryBatchId: id(), rmBatchId: batch, materialId: pick(matIds, i), storageLocationId: locId, quantityOnHand: n(20 + i * 4), ...meta() });
    }
    for (let i = 0; i < 3; i++) await db.insert(inv.stockTransfer).values({ stockTransferId: id(), fromLocationId: locId, toLocationId: locId, transferQty: n(5 + i), transferDt: ago(2 - i), ...meta() });

    const QCRES = ['PASS', 'PASS', 'PENDING', 'PASS', 'PENDING', 'FAIL'];
    for (let i = 0; i < 6; i++) {
      const insp = id();
      await db.insert(qual.qcInspections).values({ qcInspectionId: insp, rmBatchId: pick(batchIds, i), inspectionDt: ago(3 - i * 0.3), overallResult: QCRES[i], ...meta() });
      await db.insert(qual.qcResultDetails).values({ qcResultDetailId: id(), qcInspectionId: insp, observedValue: n(0.95 + i * 0.01), result: QCRES[i] === 'FAIL' ? 'Out of range' : 'Within spec', ...meta() });
      if (i < 3) await db.insert(qual.qcSampleRetention).values({ qcSampleRetentionId: id(), qcInspectionId: insp, rmBatchId: pick(batchIds, i), sampleCode: `SMP-${100 + i}`, sampleQty: n(5), retainedDt: ago(3 - i), retentionExpiryDt: ago(-365), ...meta() });
    }

    // ── M07 formula vault: types + 6 formulas + versions ──
    const ftId = id();
    await db.insert(fm.formulaTypeMaster).values({ formulaTypeId: ftId, typeCode: 'EDP', typeName: 'Eau de Parfum', ...meta() });
    const FORMULAS = ['Atlas Noir', 'Bois Citadelle', 'Rose Ivoire', 'Ambre Sel', 'Solène', 'Cèdre Verdict'];
    const versionIds: string[] = []; const formulaIds: string[] = [];
    for (let i = 0; i < FORMULAS.length; i++) {
      const f = id(), v = id(); formulaIds.push(f); versionIds.push(v);
      await db.insert(fm.formulaMaster).values({ formulaId: f, formulaTypeId: ftId, formulaCode: `FRM-${201 + i}`, formulaName: FORMULAS[i], currentVersionId: v, ...meta() });
      await db.insert(fm.formulaVersion).values({ formulaVersionId: v, formulaId: f, versionNumber: 1, approvedDt: ago(20 - i), ...meta('APPROVED') });
      await db.insert(fm.formulaEventHist).values({ formulaEventHistId: id(), formulaId: f, formulaVersionId: v, eventType: 'VERSION_APPROVED', eventDt: ago(20 - i), performedBy: ACTOR, remarks: 'Approved & locked', ...meta() });
    }

    // ── M08 production: plan + 6 orders (V-001..006) + ingredients (masked for floor) + oil batches ──
    const planId = id();
    await db.insert(prod.productionPlan).values({ productionPlanId: planId, locationId: locId, planDate: dstr(2), plannedStartDt: ago(2), plannedEndDt: ago(-5), ...meta() });
    const PSTAT = ['INPROGRESS', 'INPROGRESS', 'HOLD', 'INPROGRESS', 'PLANNING', 'INPROGRESS'];
    for (let i = 0; i < 6; i++) {
      const po = id();
      await db.insert(prod.productionOrder).values({ productionOrderId: po, formulaVersionId: pick(versionIds, i), locationId: locId, orderQty: n(180 + i * 20), actualStartDt: ago(4 - i * 0.5), ...meta(PSTAT[i]) });
      // ingredients reference real materials (masked at read for floor roles)
      const ic = 3 + (i % 3);
      for (let j = 0; j < ic; j++) await db.insert(prod.productionOrderIngredients).values({ productionOrderIngredientId: id(), productionOrderId: po, materialId: pick(matIds, i + j), requiredQty: n(20 + j * 12), issuedQty: j < 2, ...meta(j < 2 ? 'ISSUED' : 'PENDING') });
      if (i < 4) {
        const sess = id();
        await db.insert(prod.secureMixingSession).values({ secureMixingSessionId: sess, productionOrderId: po, sessionStartDt: ago(3 - i * 0.4), sessionEndDt: i < 2 ? ago(2.5 - i * 0.4) : null, ...meta(i < 2 ? 'DONE' : 'INPROGRESS') });
        if (i < 3) await db.insert(prod.oilBatchMaster).values({ oilBatchId: id(), productionOrderId: po, secureMixingSessionId: sess, batchNumber: `OIL-77${42 + i}`, producedQty: n(170 + i * 18), producedDt: ago(2 - i * 0.3), ...meta('RELEASED') });
      }
    }

    // ── M09 packaging: products + SKUs + materials + orders + filling + FG ──
    const PKMATS = [['PKG-BOT', 'Bottle 100ml'], ['PKG-CAP', 'Cap · matte'], ['PKG-LBL', 'Label'], ['PKG-CTN', 'Carton']];
    for (const [c, nm] of PKMATS) await db.insert(pkg.packagingMaterialMaster).values({ packagingMaterialId: id(), packagingMaterialCode: c, packagingMaterialName: nm, ...meta() });
    const skuIds: string[] = [];
    for (let i = 0; i < FORMULAS.length; i++) {
      const p = id(), s = id(); skuIds.push(s);
      await db.insert(pkg.productMaster).values({ productId: p, formulaId: pick(formulaIds, i), productCode: `PRD-${301 + i}`, productName: FORMULAS[i], ...meta() });
      await db.insert(pkg.productSku).values({ productSkuId: s, productId: p, skuCode: `SKU-${i % 2 ? '050' : '100'}-${i}`, packSize: i % 2 ? '50 ml' : '100 ml', ...meta() });
    }
    for (let i = 0; i < 4; i++) {
      const pko = id();
      await db.insert(pkg.packageOrder).values({ packageOrderId: pko, productSkuId: pick(skuIds, i), locationId: locId, orderQty: n(2400 - i * 400), plannedStartDt: ago(2 - i * 0.3), ...meta(['QUEUED', 'RELEASED'][i % 2]) });
      const fs = id();
      await db.insert(pkg.fillingSession).values({ fillingSessionId: fs, packageOrderId: pko, sessionStartDt: ago(1.5 - i * 0.3), sessionEndDt: i < 2 ? ago(1 - i * 0.3) : null, ...meta(i < 2 ? 'DONE' : 'FILLING') });
      if (i < 3) await db.insert(pkg.finishedGoodBatchMaster).values({ finishedGoodBatchId: id(), packageOrderId: pko, productSkuId: pick(skuIds, i), batchNumber: `PK-55${12 + i}`, producedQty: n(2400 - i * 400), manufacturingDate: dstr(1), expiryDate: dstr(-1095), ...meta('RELEASED') });
    }

    // ── M10 sales: customers + transporters + orders ──
    const CUSTS = [['CUS-001', 'Galerie Parfums · Paris'], ['CUS-002', 'Noor Trading · Dubai'], ['CUS-003', 'Aoyama Scents · Tokyo'], ['CUS-004', 'Bloom & Co · London']];
    const custIds: string[] = [];
    for (const [c, nm] of CUSTS) { const cu = id(); custIds.push(cu); await db.insert(sales.customerMaster).values({ customerId: cu, customerCode: c, customerName: nm, ...meta() }); }
    for (const [c, nm] of [['TRN-001', 'SwiftLine Logistics'], ['TRN-002', 'AeroFreight']]) await db.insert(sales.transporterMaster).values({ transporterId: id(), transporterCode: c, transporterName: nm, ...meta() });
    for (let i = 0; i < 4; i++) await db.insert(sales.salesOrder).values({ salesOrderId: id(), soNumber: `SO-2406-${401 + i}`, customerId: pick(custIds, i), orderDate: dstr(5 - i), totalAmount: n(48000 - i * 6000), ...meta(['CONFIRMED', 'DRAFT'][i % 2]) });

    // eslint-disable-next-line no-console
    console.log('db:seed:data complete — materials', matIds.length, '| vendors', vendorIds.length, '| POs 6 | batches', batchIds.length, '| formulas', formulaIds.length, '| production orders 6 | customers', custIds.length, '| qc parameters', QC_PARAMS.length);
  } finally {
    await client.end({ timeout: 5 });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
