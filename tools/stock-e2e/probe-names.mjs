import { client, stateFile } from './lib.mjs';
const run = process.argv[2];
const C = client({ keysFile: `${run}/keys.json`, run });
const S = stateFile(`${run}/state.json`).load();
const names = Object.keys(S.mat).filter((k) => k.length > 4);
const leaks = (b) => { const t = JSON.stringify(b ?? '').toLowerCase(); return names.filter((n) => t.includes(n)).length; };
const lot = S.receipt.lines.find((l) => l.invBatch);
const bc = (await C.rp('warehouse', 'POST', `/v1/floor/lots/${lot.invBatch}/barcode`, {})).body?.barcode;
const out = {};
for (const role of ['picker', 'verifier', 'mixer', 'warehouse', 'production', 'qc', 'sales']) {
  const r = {};
  for (const [k, p] of [['materials', '/v1/materials?limit=100'], ['scan', `/v1/floor/scan?code=${bc}`], ['inventoryBatches', '/v1/inventory-batches?limit=100'], ['availability', '/v1/inventory-availability?limit=100'], ['pickList', `/v1/production-orders/${S.batch.B1.order}/manufacturing-instruction`], ['search', '/v1/search?resource=materials&q=a']]) {
    const x = await C.rp(role, 'GET', p); r[k] = `${x.status}:${x.status < 300 ? leaks(x.body) : '-'}`;
  }
  out[role] = r;
}
console.log('nameLeakProbe (status:names visible)', JSON.stringify(out));
