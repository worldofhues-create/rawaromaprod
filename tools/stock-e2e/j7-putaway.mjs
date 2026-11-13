/* STOCK-E2E-2, RawProd step J7: finished goods received. Each released lot of the named batches is put away
 * on the finished-goods rack, which is the act that sends `fg.batch.received` across the bridge.
 *   node j7-putaway.mjs <runDir> <batch label> [<batch label> ...]
 * Prints statuses and what the fact said about packs (count and net mg, or neither for bulk). */
import { client, until, stateFile } from './lib.mjs';
const [run, ...labels] = process.argv.slice(2);
const C = client({ keysFile: `${run}/keys.json`, run });
const st = stateFile(`${run}/state.json`); const S = st.load();
const out = (k, v) => console.log(k, JSON.stringify(v));
if (!S.rack) {
  const r = await C.rp('owner', 'POST', '/v1/shelf/layout/rack', { zoneCode: 'FGZ', zoneName: 'Finished goods', rackCode: 'B3', rackName: 'FG rack B3', shelves: 4, binsPerShelf: 6, walkSeq: 1 });
  out('rack', { status: r.status, err: r.error?.message?.slice(0, 160) ?? null }); S.rack = r.status < 300; st.save(S);
}
for (const label of labels) {
  const B = S.batch[label];
  for (const l of B.lots ?? []) {
    if (l.putAway || !l.released) continue;
    const tasks = await until('a put-away task', async () => { const t = (await C.all('warehouse', '/v1/shelf/tasks')).filter((t) => (t.finishedGoodBatchId ?? t.fgBatchId) === l.fg); return t.length ? t : null; }, 20_000).catch(() => []);
    let ensure = null;
    if (!tasks.length) ensure = await C.rp('warehouse', 'POST', '/v1/shelf/putaway', { finishedGoodBatchId: l.fg });
    const t = tasks[0] ?? ensure?.body?.task ?? ensure?.body;
    const taskId = t?.shelfTaskId ?? t?.taskId ?? t?.id;
    // The bin the system chose for the task (another SKU's bin is refused with a warning to read).
    const bin = t?.label ?? t?.bin ?? null;
    const done = taskId && bin ? await C.rp('warehouse', 'POST', `/v1/shelf/tasks/${taskId}/putaway`, { binCode: bin }) : null;
    const f = done?.body?.fgBatchReceived;
    out(`putaway_${label}_${l.key}`, { task: !!taskId, complete: done?.status ?? null, err: done?.error?.message?.slice(0, 200) ?? null, sent: f?.sent ?? null, problems: f?.problems ?? null,
      fact: f?.payload ? { skuIsTheProductCode: Object.keys(S.fp ?? {}).includes(f.payload.sku), qty_kg: f.payload.qty_kg,
        pack_count: f.payload.pack_count ?? null, pack_net_mg: f.payload.pack_net_mg ?? null, pack_size: f.payload.pack_size ?? null, qc_batch_no: !!f.payload.qc_batch_no } : null });
    if (done?.status < 300) { l.putAway = true; l.fact = f?.payload ? { sku: f.payload.sku, qty_kg: f.payload.qty_kg, pack_count: f.payload.pack_count ?? null, pack_net_mg: f.payload.pack_net_mg ?? null } : null; st.save(S); }
  }
}
await new Promise((r) => setTimeout(r, 6000));
const parked = await C.rp('owner', 'GET', '/v1/bridge/outbox/parked?limit=50');
const rows = Array.isArray(parked.body) ? parked.body : parked.body?.items ?? [];
out('rawprodOutboxParked', { status: parked.status, parked: rows.length, why: [...new Set(rows.map((r) => `${r.type}:${r.parkedReason ?? r.lastError ?? '?'}`))] });
