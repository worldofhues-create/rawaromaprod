import { client, stateFile, readSheet, formulasOf, normName } from './lib.mjs';
const [xlsx, run] = process.argv.slice(2);
const C = client({ api: 'http://127.0.0.1:4361', vault: 'http://127.0.0.1:4362', keysFile: `${run}/keys.json` });
const st = stateFile(`${run}/state.json`); const S = st.load();
const { formulas } = formulasOf(readSheet(xlsx));
const today = new Date().toISOString().slice(0, 10);
const P = 'postgres://' + process.env.USER + '@127.0.0.1:5561/stock_e2e_rp';
import { execFileSync } from 'node:child_process';
const q = (s) => execFileSync('/opt/homebrew/opt/postgresql@17/bin/psql', [P, '-Atc', s], { encoding: 'utf8' }).trim();
async function probe(fid, qty, uomKey, tag) {
  const f = formulas.find((x) => x.id === fid);
  const uom = S.masters[uomKey]; const factor = uomKey === 'kg' ? 1_000_000 : 1000;
  const o = await C.must('production', 'POST', '/v1/production-orders', { formulaVersionId: S.vault[fid].fv, orderQty: qty, uomId: uom });
  const id = o.order.productionOrderId;
  await C.must('production', 'POST', `/v1/production-orders/${id}/pick-list`, { pickListDate: today });
  const rows = q(`select i.material_id || '|' || i.picked_qty from production.material_pick_list_items i join production.material_pick_list p on p.material_pick_list_id = i.material_pick_list_id where p.production_order_id = '${id}'`).split('\n').map((l) => l.split('|'));
  let off = 0, maxOff = 0, sysTot = 0, exTot = 0, fracMg = 0;
  for (const l of S.vault[fid].lines) {
    const exact = (l.mg * qty * factor) / f.totalMg; exTot += exact; if (!Number.isInteger(exact)) fracMg++;
    const r = rows.find((x) => x[0] === S.mat[l.k].id); const sys = Math.round(Number(r[1]) * factor); sysTot += sys;
    if (Math.abs(sys - exact) > 1e-9) { off++; maxOff = Math.max(maxOff, Math.abs(sys - exact)); }
  }
  const job = await C.rp('production', 'POST', '/v1/floor/jobs', { productionOrderId: id });
  console.log(tag, JSON.stringify({ fid, qty, uom: uomKey, lines: rows.length, linesOffExact: off, maxOffMg: Math.round(maxOff * 1000) / 1000, exactTotalMg: exTot, pickTotalMg: sysTot, totalDiffMg: sysTot - exTot, linesNotWholeMg: fracMg, floorJob: job.status, floorJobMsg: job.error?.message?.replace(/\([A-Z]+-\d{4}\)/, '(CODE)').slice(0, 120) ?? null }));
  if (job.status < 300) { /* leave it; it is a probe */ }
}
await probe('F1', 5, 'kg', 'P1-F1-5kg-in-kg');
await probe('F2', 1, 'kg', 'P2-F2-1kg-in-kg');
await probe('F2', 333, 'g', 'P3-F2-333g');
await probe('F1', 2500, 'g', 'P4-F1-2.5kg-in-g');
// Pack without a lot: an FG batch with no number, on the probe package order.
const B5 = S.batch.B5;
const fg = await C.rp('packaging', 'POST', '/v1/finished-good-batches', { packageOrderId: B5.pkg, productSkuId: S.sku.a9pm.sku, producedQty: 1, uomId: S.masters.pcs });
const fg2 = await C.rp('packaging', 'POST', '/v1/finished-good-batches', { packageOrderId: B5.pkg, productSkuId: S.sku.a9pm.sku, batchNumber: 'FG-B1-TYPED', producedQty: 1, uomId: S.masters.pcs });
console.log('P5-fg-without-lot', fg.status, fg.error?.message?.slice(0, 120) ?? null, '| reuse of another batch number', fg2.status, fg2.error?.message?.slice(0, 100) ?? null);
// Pick more than on hand: a direct reservation beyond a lot.
const lot = S.receipt.lines.find((l) => l.invBatch);
const r = await C.rp('warehouse', 'POST', '/v1/stock-reservations', { inventoryBatchId: lot.invBatch, reservedQty: 999999, uomId: S.masters.g, reservedForDocumentId: B5.order });
console.log('P6-reserve-beyond-on-hand', r.status, r.error?.message?.slice(0, 100) ?? null);
