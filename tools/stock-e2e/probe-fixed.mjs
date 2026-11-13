import { client, stateFile } from './lib.mjs';
const run = process.argv[2];
const C = client({ api: 'http://127.0.0.1:4361', vault: 'http://127.0.0.1:4362', keysFile: `${run}/keys.json` });
const S = stateFile(`${run}/state.json`).load();
const B5 = S.batch.B5, pcs = S.masters.pcs, today = new Date().toISOString().slice(0, 10);
const po = await C.must('packaging', 'POST', '/v1/package-orders', { productSkuId: S.sku.a9pm.sku, oilBatchId: B5.oil, orderQty: 2, uomId: pcs });
const pkg = po.order.packageOrderId;
await C.rp('packaging', 'POST', `/v1/package-orders/${pkg}/issue-materials`, {});
const fs = await C.must('filling', 'POST', '/v1/filling-sessions', { packageOrderId: pkg });
await C.rp('filling', 'POST', `/v1/filling-sessions/${fs.fillingSessionId}/details`, { filledQty: 2, rejectedQty: 0, uomId: pcs });
await C.rp('filling', 'POST', `/v1/filling-sessions/${fs.fillingSessionId}/end`, {});
const over = await C.rp('packaging', 'POST', '/v1/finished-good-batches', { packageOrderId: pkg, productSkuId: S.sku.a9pm.sku, batchNumber: 'FG-B5-FIXPROBE', producedQty: 10, uomId: pcs, manufacturingDate: today });
const ok = await C.rp('packaging', 'POST', '/v1/finished-good-batches', { packageOrderId: pkg, productSkuId: S.sku.a9pm.sku, batchNumber: 'FG-B5-FIXPROBE2', producedQty: 2, uomId: pcs, manufacturingDate: today });
console.log('afterFix', JSON.stringify({ overFill: over.status, msg: over.error?.message?.replace(/[0-9a-f-]{36}/, '<order>').slice(0, 160), exact: ok.status }));
// The empty formula version, through the Vault API, on the fixed code? (the vault process is unchanged: report only)
