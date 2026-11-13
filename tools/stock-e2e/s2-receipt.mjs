/* Step 2: opening stock for every ingredient, through PO -> gate -> GRN -> incoming QC. Counts only. */
import { readSheet, formulasOf, normName, client, until, stateFile } from './lib.mjs';
const [xlsx, run] = process.argv.slice(2);
const C = client({ keysFile: `${run}/keys.json`, run });
const st = stateFile(`${run}/state.json`); const S = st.load();
const ev = (k, v) => { S.ev ??= {}; S.ev[k] = v; console.log(k, JSON.stringify(v)); st.save(S); };
const { formulas } = formulasOf(readSheet(xlsx));
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

// What the rehearsal will make: F1 at 5 kg and F2 at 1 kg twice (one to fail QC), F3 at 1 kg (shortfall probe).
// STOCK-E2E-2: the joint run makes other batches; SE2E_PLAN="F1:5000000,F2:7000000,..." (formula:mg) says which.
const PLAN = process.env.SE2E_PLAN
  ? process.env.SE2E_PLAN.split(',').map((x) => { const [f, mg] = x.split(':'); return [f, Number(mg)]; })
  : [['F1', 5_000_000], ['F2', 1_000_000], ['F2', 1_000_000], ['F3', 1_000_000]];
const needMg = new Map();
for (const [fid, batchMg] of PLAN) {
  const f = formulas.find((x) => x.id === fid);
  for (const l of f.lines) { const k = normName(l.name); needMg.set(k, (needMg.get(k) ?? 0) + (l.mg * batchMg) / f.totalMg); }
}
const keys = [...new Set(formulas.flatMap((f) => f.lines.map((l) => normName(l.name))))];
const F1keys = new Set(formulas[0].lines.map((l) => normName(l.name)));
// F3 is received at exactly the 1 kg need on one material, so the shortfall probe has something to find.
const shortKey = process.env.SE2E_NO_SHORT ? null : formulas[2].lines.map((l) => normName(l.name)).find((k) => !F1keys.has(k) && !formulas[1].lines.some((x) => normName(x.name) === k));
S.shortKey = shortKey;

if (!S.receipt) {
  const { vendor, g } = S.masters;
  // Lots: grams, whole, at least twice what the plan needs (+10 g). F1's materials come in two lots with different expiry (FEFO).
  const lines = [];
  for (const k of keys) {
    const m = S.mat[k];
    const need = needMg.get(k) ?? 0;
    let qtyG = Math.ceil((2 * need) / 1000) + 10;
    if (k === shortKey) qtyG = Math.ceil((need / 2) / 1000); // half of what one F3 kg needs
    if (F1keys.has(k)) { lines.push({ k, qtyG: Math.ceil(qtyG / 2), expiry: plusDays(400), mfg: plusDays(-60) }); lines.push({ k, qtyG: Math.ceil(qtyG / 2), expiry: plusDays(700), mfg: plusDays(-10) }); }
    else lines.push({ k, qtyG, expiry: plusDays(700), mfg: plusDays(-10) });
  }
  // Probe lots on the first F1 material: one that will FAIL incoming QC, one left untested.
  const probeKey = formulas[0].lines.map((l) => normName(l.name))[0];
  lines.push({ k: probeKey, qtyG: 500, expiry: plusDays(300), mfg: plusDays(-90), probe: 'FAIL' });
  lines.push({ k: probeKey, qtyG: 500, expiry: plusDays(200), mfg: plusDays(-90), probe: 'UNTESTED' });
  S.probeKey = probeKey;
  const t0 = Date.now();
  const po = await C.must('procurement', 'POST', '/v1/purchase-orders', { vendorId: vendor, orderDate: today(),
    items: lines.map((l) => ({ materialId: S.mat[l.k].id, orderedQty: l.qtyG, uomId: g, rate: 1, amount: l.qtyG })) });
  const poId = po.purchaseOrder.purchaseOrderId;
  const approve = await C.rp('owner', 'POST', `/v1/purchase-orders/${poId}/approve`, { remarks: 'rehearsal' });
  const issue = await C.rp('procurement', 'POST', `/v1/purchase-orders/${poId}/issue`, {});
  const ack = await C.rp('procurement', 'POST', `/v1/purchase-orders/${poId}/acknowledge`, {});
  ev('po', { lines: lines.length, poItems: po.items.length, approve: approve.status, issue: issue.status, ack: ack.status, ackErr: ack.error?.message?.slice(0, 160) ?? null });
  const gate = await C.must('receiving', 'POST', '/v1/gate-entries', { vendorId: vendor, purchaseOrderId: poId, vehicleNumber: 'MP09RH0001', entryDt: new Date().toISOString() });
  const gateId = gate.gateEntry?.gateEntryId ?? gate.gateEntryId;
  const grn = await C.rp('receiving', 'POST', '/v1/grns', { gateEntryId: gateId, purchaseOrderId: poId, vendorId: vendor, grnDate: today(),
    // STOCK-FIX-RP (STK-16): each line names the supplier's own lot (a scratch reference: the sheet has none).
    items: lines.map((l, i) => ({ purchaseOrderItemId: po.items[i].purchaseOrderItemId, materialId: S.mat[l.k].id, receivedQty: l.qtyG, acceptedQty: l.qtyG, rejectedQty: 0, uomId: g, manufacturingDate: l.mfg, expiryDate: l.expiry, supplierLotRef: `SUP-REH-${String(i + 1).padStart(4, '0')}` })) });
  if (grn.status >= 300) { ev('grn', { status: grn.status, error: grn.error }); process.exit(1); }
  S.receipt = { poId, gateId, grnId: grn.body.grn.grnId, lines: lines.map((l, i) => ({ k: l.k, qtyG: l.qtyG, expiry: l.expiry, probe: l.probe ?? null, rmBatch: grn.body.batches[i]?.rmBatchId, batchNumber: grn.body.batches[i]?.batchNumber })) };
  ev('grn', { status: grn.status, batches: grn.body.batches.length, seconds: Math.round((Date.now() - t0) / 1000) });
}

// Incoming QC: every lot gets an inspection; results + a retained sample + ACCEPT (FAIL probe: REJECT; UNTESTED: nothing).
if (!S.qcDone) {
  const t0 = Date.now();
  const insps = await until('every incoming inspection', async () => {
    const all = await C.all('qc', '/v1/qc-inspections');
    const by = new Map(all.filter((i) => i.rmBatchId).map((i) => [i.rmBatchId, i.qcInspectionId]));
    return S.receipt.lines.every((l) => by.has(l.rmBatch)) ? by : null;
  }, 120_000);
  const tally = {};
  const acceptNoSample = await (async () => {
    const l = S.receipt.lines.find((x) => !x.probe);
    // Before the sample: is ACCEPT refused (FLOOR-QC-IN-1)?
    const r = await C.rp('qc', 'POST', `/v1/qc-inspections/${insps.get(l.rmBatch)}/disposition`, { dispositionCode: 'ACCEPT', dispositionReason: 'probe: no result, no sample' });
    return { status: r.status, msg: r.error?.message?.slice(0, 140) ?? null };
  })();
  for (const l of S.receipt.lines) {
    if (l.probe === 'UNTESTED') continue;
    const id = insps.get(l.rmBatch);
    const pass = l.probe === 'FAIL' ? 'FAIL' : 'PASS';
    const r1 = await C.rp('qc', 'POST', `/v1/qc-inspections/${id}/results`, { results: [{ qcParameterId: S.masters.qcParam, observedValue: 1.47, result: pass }] });
    const r2 = await C.rp('qc', 'POST', '/v1/qc-sample-retentions', { qcInspectionId: id, rmBatchId: l.rmBatch, sampleCode: `RS-${l.batchNumber}`, retainedDt: new Date().toISOString() });
    const r3 = await C.rp('qc', 'POST', `/v1/qc-inspections/${id}/disposition`, l.probe === 'FAIL' ? { dispositionCode: 'REJECT', dispositionReason: 'probe' } : { dispositionCode: 'ACCEPT', dispositionReason: 'within spec' });
    const k = `${r1.status}/${r2.status}/${r3.status}`; tally[k] = (tally[k] ?? 0) + 1;
    if (r3.status >= 300 && !tally[`err:${r3.error?.code}`]) tally[`err:${r3.error?.code}`] = r3.error?.message?.slice(0, 160);
  }
  S.qcDone = true;
  ev('incomingQc', { inspections: insps.size, acceptBeforeSample: acceptNoSample, statusTally: tally, seconds: Math.round((Date.now() - t0) / 1000) });
}

// Raw stock on hand by lot.
const inv = await until('released stock on the books', async () => {
  const all = await C.all('warehouse', '/v1/inventory-batches');
  const mine = all.filter((b) => S.receipt.lines.some((l) => l.rmBatch === b.rmBatchId));
  return mine.length >= S.receipt.lines.filter((l) => !l.probe).length ? mine : null;
}, 120_000).catch(() => null);
const allInv = await C.all('warehouse', '/v1/inventory-batches');
for (const l of S.receipt.lines) l.invBatch = allInv.find((b) => b.rmBatchId === l.rmBatch)?.inventoryBatchId ?? null;
const avail = await C.rp('warehouse', 'GET', '/v1/inventory-availability?limit=500');
ev('stockOnHand', { inventoryBatches: allInv.length, linkedToOurLots: S.receipt.lines.filter((l) => l.invBatch).length,
  probeFailHasInvBatch: !!S.receipt.lines.find((l) => l.probe === 'FAIL').invBatch, probeUntestedHasInvBatch: !!S.receipt.lines.find((l) => l.probe === 'UNTESTED').invBatch,
  availabilityRoute: avail.status, availabilityRows: Array.isArray(avail.body) ? avail.body.length : avail.body?.items?.length,
  sumOnHandG: allInv.filter((b) => S.receipt.lines.some((l) => l.rmBatch === b.rmBatchId)).reduce((s, b) => s + Number(b.quantityOnHand), 0),
  sumReceivedG: S.receipt.lines.reduce((s, l) => s + l.qtyG, 0), sampleShape: Object.keys(allInv[0] ?? {}).filter((k) => /qty|quantity|uom|status|material|batch|expiry/i.test(k)) });
