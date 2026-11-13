/* STOCK-E2E-2, RawProd step J6: pack one released oil batch into the packs the product is sold in, or leave
 * it as bulk (lead ruling LD-145), on the products the factory catalogue sent across the bridge.
 *   node j6-pack.mjs <runDir> <batch label> <commercial sku code> <part> [<part> ...]
 *   part:  100g:20   twenty packs of 100 g      (g or kg; a filled lot, counted in packs)
 *          bulk:1900000   1,900,000 mg left as bulk  (a lot counted in kg)
 * The product and its SKUs are the ones the catalogue made: nothing here types a product, a SKU code or a
 * pack size. TYPED_SKU=<code> makes the pack SKU by hand instead, as a person had to before STK-31, so the
 * defect can be shown. The bottle and its bill of packaging are the factory's own master data and are
 * invented (the sheet and the shop hold none). Statuses and integer mg only. */
import { client, until, stateFile } from './lib.mjs';
const [run, label, skuCode, ...parts] = process.argv.slice(2);
const C = client({ keysFile: `${run}/keys.json`, run });
const st = stateFile(`${run}/state.json`); const S = st.load();
const B = S.batch[label];
const out = (k, v) => { (B.steps ??= {})[k] = v; console.log(label, k, JSON.stringify(v)); st.save(S); };
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const { kg, pcs } = S.masters;
const err = (r) => r.error?.message?.slice(0, 220) ?? null;

// The product the catalogue made for this commercial code, and the formula it is made from.
S.fp ??= {};
if (!S.fp[skuCode]) {
  const product = (await C.all('owner', '/v1/products')).find((p) => p.productCode === skuCode);
  if (!product) { out('product', { found: false, why: 'the factory catalogue has not sent this product' }); process.exit(1); }
  const link = await C.rp('owner', 'POST', `/v1/products/${product.productId}/formula-link`, { formulaId: S.vault[B.fid].formulaId, reason: 'rehearsal: the formula this product is made from' });
  S.fp[skuCode] = { product: product.productId, link: link.status, skus: {} }; st.save(S);
  out('product', { found: true, formulaLink: link.status, err: link.status >= 300 ? err(link) : null });
}
const P = S.fp[skuCode];
const skus = (await C.all('owner', '/v1/product-skus')).filter((s) => s.productId === P.product);
const bal0 = await C.must('production', 'GET', `/v1/oil-batches/${B.oil}/balance`);
out('oilBefore', { made: bal0.madeMg, free: bal0.freeMg, remaining: bal0.remainingMg });

B.lots ??= [];
for (const part of parts) {
  const [what, nText] = part.split(':');
  const bulk = what === 'bulk';
  const m = /^(\d+(?:\.\d+)?)(g|kg)$/.exec(what);
  if (!bulk && !m) throw new Error(`not a part: ${part}`);
  const packMg = bulk ? null : Math.round(Number(m[1]) * (m[2] === 'kg' ? 1_000_000 : 1000));
  const key = bulk ? 'bulk' : `${process.env.TYPED_SKU ? 'typed-' : ''}${packMg}`;
  if (B.lots.some((l) => l.key === key)) continue;
  // The SKU: the bulk SKU carries the commercial code and no pack; a pack SKU is the product's SKU of that net content.
  let sku = bulk ? skus.find((s) => s.skuCode === skuCode) : skus.find((s) => Number(s.netContentMg) === packMg);
  let typed = false;
  if (!sku && !bulk && process.env.TYPED_SKU) {
    const made = await C.rp('owner', 'POST', '/v1/product-skus', { skuCode: process.env.TYPED_SKU, productId: P.product, packSize: `${m[1]} ${m[2]}`, uomId: pcs });
    if (made.status >= 300) { out(`sku_${key}`, { typedByHand: made.status, err: err(made) }); process.exit(1); }
    sku = made.body; typed = true;
  }
  if (!sku) { out(`sku_${key}`, { onFile: false, productSkus: skus.length, why: 'the factory holds no SKU of this pack for the product: a person would have to type one' }); process.exit(1); }
  const skuId = sku.productSkuId;
  // STK-32: a bulk lot is filled through a package order too, and a package order with no bill of packaging
  // cannot issue or fill ("has no BOM items to issue"); the catalogue's bulk SKU comes with none.
  if (!P.skus[skuId]) {
    const pm = (await C.must('owner', 'POST', '/v1/packaging-materials', { packagingMaterialCode: `PM-${label}-${key}`, packagingMaterialName: `Rehearsal container ${what}`, uomId: pcs })).packagingMaterialId;
    await C.must('owner', 'POST', '/v1/packaging-boms', { productSkuId: skuId, packagingMaterialId: pm, requiredQty: 1, uomId: pcs });
    await C.must('warehouse', 'POST', '/v1/inventory-batches', { materialId: pm, quantityOnHand: 500, uomId: pcs });
    P.skus[skuId] = { pm }; st.save(S);
  }
  const count = bulk ? null : Number(nText);
  const massMg = bulk ? Number(nText) : count * packMg;
  const qty = bulk ? massMg / 1_000_000 : count, uom = bulk ? kg : pcs;
  // An order this step opened and could not issue (its bill of packaging is copied when it is made, and it holds
  // the oil it was promised) is cancelled, which frees the oil, and made again.
  const stale = (await C.all('packaging', '/v1/package-orders')).filter((p) => p.oilBatchId === B.oil && p.productSkuId === skuId && p.status === 'DRAFT');
  for (const d of stale) out(`cancelStale_${key}`, { status: (await C.rp('packaging', 'POST', `/v1/package-orders/${d.packageOrderId}/cancel`, { reason: 'rehearsal: made before the SKU had a bill of packaging' })).status });
  const po = await C.rp('packaging', 'POST', '/v1/package-orders', { productSkuId: skuId, oilBatchId: B.oil, orderQty: qty, uomId: uom });
  if (po.status >= 300) { out(`packageOrder_${key}`, { status: po.status, err: err(po) }); process.exit(1); }
  const pkg = po.body.order.packageOrderId;
  const issue = await C.rp('packaging', 'POST', `/v1/package-orders/${pkg}/issue-materials`, {});
  const fs = await C.must('filling', 'POST', '/v1/filling-sessions', { packageOrderId: pkg });
  const det = await C.rp('filling', 'POST', `/v1/filling-sessions/${fs.fillingSessionId}/details`, { filledQty: qty, rejectedQty: 0, uomId: uom });
  const end = await C.rp('filling', 'POST', `/v1/filling-sessions/${fs.fillingSessionId}/end`, {});
  const lotNo = `FG-${label}-${bulk ? 'BULK' : what.toUpperCase()}`;
  const fg = await C.rp('packaging', 'POST', '/v1/finished-good-batches', { packageOrderId: pkg, productSkuId: skuId, batchNumber: lotNo, producedQty: qty, uomId: uom, manufacturingDate: today(), expiryDate: plusDays(730) });
  out(`fill_${key}`, { sku: typed ? 'typed by hand' : 'from the catalogue', bulk, packMg, count, massMg, packageOrder: po.status, issueMaterials: issue.status, issueErr: issue.status >= 300 ? err(issue) : null,
    fillDetail: det.status, detErr: det.status >= 300 ? err(det) : null, fillEnd: end.status, fgBatch: fg.status, fgErr: fg.status >= 300 ? err(fg) : null });
  if (fg.status >= 300) process.exit(1);
  B.lots.push({ key, bulk, packMg, count, massMg, fg: fg.body.batch.finishedGoodBatchId, pkg, lotNo, skuId, typed }); st.save(S);
}

// QC of the oil batch for this product: the certificate, released once (it sends qc.batch.released).
if (!B.coa) {
  const spec = await C.rp('qc', 'PUT', `/v1/product-qc-specs/${P.product}`, { sgMin: 0.5, sgMax: 2, flashPointMinC: 20, flashPointMaxC: 120, shelfLifeMonths: 24 });
  const coa = await C.rp('qc', 'POST', '/v1/batch-coas', { oilBatchId: B.oil, productId: P.product, sgResult: 1, flashPointResultC: 60, colourAppearance: 'Clear', colourAppearancePass: true, odourDescription: 'Conforms', odourPass: true });
  const coaId = coa.body?.batchCoaId ?? coa.body?.coa?.batchCoaId;
  B.coaId = coaId; st.save(S);
  if (process.env.HOLD_COA === '1') { out('coa', { spec: spec.status, coa: coa.status, release: 'held back for the out-of-order rehearsal' }); }
  else {
    const rel = await C.rp('qc', 'POST', `/v1/batch-coas/${coaId}/release`, {});
    out('coa', { spec: spec.status, coa: coa.status, coaErr: coa.status >= 300 ? err(coa) : null, release: rel.status, relErr: rel.status >= 300 ? err(rel) : null, emitted: rel.body?.emitted ?? null });
    B.coa = rel.status < 300; st.save(S);
  }
}
if (B.coa) {
  for (const l of B.lots) {
    if (l.released) continue;
    const lab = await C.rp('packaging', 'POST', `/v1/finished-good-batches/${l.fg}/labels`, { labelCount: l.bulk ? 1 : l.count });
    const done = await C.rp('packaging', 'POST', `/v1/package-orders/${l.pkg}/complete`, {});
    const pqc = await C.rp('packaging', 'POST', '/v1/packaging-qc', { finishedGoodBatchId: l.fg, leakageCheck: 'PASS', labelCheck: 'PASS', cartonCheck: 'PASS' });
    const released = await until('FG release', async () => (await C.all('packaging', '/v1/finished-good-batches')).find((x) => x.finishedGoodBatchId === l.fg)?.status === 'RELEASED', 30_000).catch(() => false);
    const c = lab.body?.labelContent ?? {};
    out(`label_${l.key}`, { label: lab.status, labelErr: lab.status >= 300 ? err(lab) : null, net: c.netQuantity != null ? `${c.netQuantity} ${c.unit}` : null, lot: c.lotQuantity != null ? `${c.lotQuantity} ${c.lotUnit}` : null,
      lotNumberIsOurs: c.batchNumber === l.lotNo, qc: c.qcStatus ?? null, complete: done.status, packagingQc: pqc.body?.overallResult ?? pqc.status, fgReleased: released });
    l.released = released; st.save(S);
  }
}
const bal = await C.must('production', 'GET', `/v1/oil-batches/${B.oil}/balance`);
out('oilAfter', { made: bal.madeMg, packed: bal.packedMg, rejected: bal.rejectedMg, loss: bal.lossMg, writtenOff: bal.writtenOffMg, remaining: bal.remainingMg });
