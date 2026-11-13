/* Step 4b: pack a released oil batch into real pack sizes, label, packaging QC, FG release.
 * Usage: node s6-pack.mjs <runDir> <label> <skuCode> <packGrams> [probe]   Counts and statuses only. */
import { client, until, stateFile } from './lib.mjs';
const [run, label, skuCode, packG, probe] = process.argv.slice(2);
const C = client({ api: 'http://127.0.0.1:4361', vault: 'http://127.0.0.1:4362', keysFile: `${run}/keys.json` });
const st = stateFile(`${run}/state.json`); const S = st.load();
const B = S.batch[label];
const step = (k, v) => { B.steps[k] = v; console.log(label, k, JSON.stringify(v)); st.save(S); };
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const { g, pcs } = S.masters;
const oilMg = Math.round(Number((await C.all('compounding', '/v1/oil-batches')).find((x) => x.oilBatchId === B.oil).producedQty) * 1000);
const packMg = Number(packG) * 1000;
const units = Math.floor(oilMg / packMg);

S.sku ??= {};
if (!S.sku[skuCode]) {
  const product = (await C.must('owner', 'POST', '/v1/products', { productCode: `P-${skuCode}`, productName: `Rehearsal ${B.fid}` })).productId;
  const sku = (await C.must('owner', 'POST', '/v1/product-skus', { skuCode, productId: product, packSize: `${packG} g`, uomId: pcs })).productSkuId;
  const link = await C.rp('owner', 'POST', `/v1/products/${product}/formula-link`, { formulaId: S.vault[B.fid].formulaId, reason: 'rehearsal' });
  const pm = (await C.must('owner', 'POST', '/v1/packaging-materials', { packagingMaterialCode: `PM-${skuCode}`, packagingMaterialName: `${packG} g bottle`, uomId: pcs })).packagingMaterialId;
  await C.must('owner', 'POST', '/v1/packaging-boms', { productSkuId: sku, packagingMaterialId: pm, requiredQty: 1, uomId: pcs });
  await C.must('warehouse', 'POST', '/v1/inventory-batches', { materialId: pm, quantityOnHand: 500, uomId: pcs });
  S.sku[skuCode] = { product, sku, pm, link: link.status };
  st.save(S);
}
const K = S.sku[skuCode];
// Package order in units of the pack.
const orderQty = probe === 'over' ? units + 5 : units;
const po = await C.rp('packaging', 'POST', '/v1/package-orders', { productSkuId: K.sku, oilBatchId: B.oil, orderQty, uomId: pcs });
// STOCK-FIX-RP (STK-11): the over-order probe is refused at the package order; that is the probe's answer.
if (po.status >= 300) { step('packageOrder', { status: po.status, err: po.error?.message?.slice(0, 200) }); process.exit(probe === 'over' && po.status === 409 ? 0 : 1); }
const pkg = po.body.order.packageOrderId;
const issue = await C.rp('packaging', 'POST', `/v1/package-orders/${pkg}/issue-materials`, {});
const fs = await C.must('filling', 'POST', '/v1/filling-sessions', { packageOrderId: pkg });
const filled = probe === 'over' ? units + 5 : units - (probe === 'short' ? 2 : 0);
const det = await C.rp('filling', 'POST', `/v1/filling-sessions/${fs.fillingSessionId}/details`, { filledQty: filled, rejectedQty: probe === 'short' ? 2 : 0, uomId: pcs });
const end = await C.rp('filling', 'POST', `/v1/filling-sessions/${fs.fillingSessionId}/end`, {});
// The FG batch: its number and quantity are typed by the caller. Try a typed number, and an over-count.
const fgQty = probe === 'over' ? units + 50 : filled;
const fg = await C.rp('packaging', 'POST', '/v1/finished-good-batches', { packageOrderId: pkg, productSkuId: K.sku, batchNumber: `FG-${label}-TYPED`, producedQty: fgQty, uomId: pcs, manufacturingDate: today(), expiryDate: plusDays(730) });
step('fill', { oilMg, packMg, unitsPossible: units, orderQty, packageOrder: po.status, issueMaterials: issue.status, fillDetail: det.status, fillEnd: end.status, filled,
  fgBatch: fg.status, fgProducedQtyTyped: fgQty, fgErr: fg.error?.message?.slice(0, 160) ?? null, theoreticalFilledMg: filled * packMg, remnantMg: oilMg - filled * packMg });
if (fg.status >= 300) process.exit(1);
const fgId = fg.body.batch.finishedGoodBatchId;
B.fg = fgId; B.pkg = pkg; B.units = filled; B.packMg = packMg; st.save(S);
if (probe) process.exit(0);

// Label before QC release: refused? Then the COA, release, label, packaging QC.
const labelEarly = await C.rp('packaging', 'POST', `/v1/finished-good-batches/${fgId}/labels`, { labelCount: filled });
const pqcEarly = await C.rp('packaging', 'POST', '/v1/packaging-qc', { finishedGoodBatchId: fgId, leakageCheck: 'PASS', labelCheck: 'PASS', cartonCheck: 'PASS' });
const spec = await C.rp('qc', 'PUT', `/v1/product-qc-specs/${K.product}`, { sgMin: 0.5, sgMax: 2, flashPointMinC: 20, flashPointMaxC: 120, shelfLifeMonths: 24 });
const coa = await C.rp('qc', 'POST', '/v1/batch-coas', { oilBatchId: B.oil, productId: K.product, sgResult: 1, flashPointResultC: 60, colourAppearance: 'Clear', colourAppearancePass: true, odourDescription: 'Conforms', odourPass: true });
const coaId = coa.body?.batchCoaId ?? coa.body?.coa?.batchCoaId;
const rel = await C.rp('qc', 'POST', `/v1/batch-coas/${coaId}/release`, {});
const lab = await C.rp('packaging', 'POST', `/v1/finished-good-batches/${fgId}/labels`, { labelCount: filled });
const done = await C.rp('packaging', 'POST', `/v1/package-orders/${pkg}/complete`, {});
const pqc = await C.rp('packaging', 'POST', '/v1/packaging-qc', { finishedGoodBatchId: fgId, leakageCheck: 'PASS', labelCheck: 'PASS', cartonCheck: 'PASS' });
const released = await until('FG release', async () => (await C.all('packaging', '/v1/finished-good-batches')).find((x) => x.finishedGoodBatchId === fgId)?.status === 'RELEASED', 30_000).catch(() => false);
step('labelQc', { labelBeforeQc: labelEarly.status, packagingQcBeforeLabel: pqcEarly.status, spec: spec.status, coa: coa.status, coaRelease: rel.status, label: lab.status,
  labelLot: lab.body?.labelContent?.batchNumber === `FG-${label}-TYPED` ? 'the typed number' : (lab.body?.labelContent?.batchNumber ? 'other' : null), labelNet: lab.body?.labelContent?.netQuantity ?? null,
  labelFields: Object.keys(lab.body?.labelContent ?? {}).join(','), complete: done.status, packagingQc: pqc.body?.overallResult ?? pqc.status, fgReleased: released });
const stock = await C.rp('packaging', 'GET', '/v1/fg-stock?limit=100');
const mine = (Array.isArray(stock.body) ? stock.body : stock.body?.items ?? []).find((x) => x.finishedGoodBatchId === fgId);
step('fgStock', { route: stock.status, producedQty: mine?.producedQty ?? null, availableQty: mine?.availableQty ?? null, fields: Object.keys(mine ?? {}).join(',') });
