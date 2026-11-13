/* Step 6 (RawProd half): pair the bridge with the listening Alembic, put the finished lots away on a shelf,
 * which sends fg.batch.received. Usage: node s7-bridge.mjs <runDir> <label...> */
import { readFileSync } from 'node:fs';
import { client, until, stateFile } from './lib.mjs';
const [run, ...labels] = process.argv.slice(2);
const C = client({ api: 'http://127.0.0.1:4361', vault: 'http://127.0.0.1:4362', keysFile: `${run}/keys.json` });
const st = stateFile(`${run}/state.json`); const S = st.load();
const out = (k, v) => console.log(k, JSON.stringify(v));
const pair = JSON.parse(readFileSync(`${run}/bridge.json`, 'utf8'));
const cfg = await C.rp('owner', 'PUT', '/v1/bridge/config', { enabled: true, hmacSecret: pair.secret, webhookUrl: pair.webhookUrl });
out('bridgeConfig', { status: cfg.status, err: cfg.error?.message?.slice(0, 160) ?? null });
if (!S.rack) {
  const r = await C.rp('owner', 'POST', '/v1/shelf/layout/rack', { zoneCode: 'FGZ', zoneName: 'Finished goods', rackCode: 'B3', rackName: 'FG rack B3', shelves: 2, binsPerShelf: 4, walkSeq: 1 });
  out('rack', { status: r.status, err: r.error?.message?.slice(0, 160) ?? null }); S.rack = r.status < 300; st.save(S);
}
for (const label of labels) {
  const B = S.batch[label];
  const tasks = await until('a put-away task', async () => (await C.all('warehouse', '/v1/shelf/tasks')).filter((t) => (t.finishedGoodBatchId ?? t.fgBatchId) === B.fg), 30_000).catch(() => []);
  const ready = await C.rp('warehouse', 'GET', '/v1/shelf/ready');
  let put = null;
  if (!tasks.length) {
    put = await C.rp('warehouse', 'POST', '/v1/shelf/putaway', { finishedGoodBatchId: B.fg });
  }
  const t = tasks[0] ?? put?.body?.task ?? put?.body;
  const taskId = t?.shelfTaskId ?? t?.taskId ?? t?.id;
  const bin = t?.targetBinCode ?? t?.binCode ?? t?.targetBin ?? null;
  const done = taskId ? await C.rp('warehouse', 'POST', `/v1/shelf/tasks/${taskId}/putaway`, { bin: bin ?? 'B3-S1-B1', binCode: bin ?? 'B3-S1-B1', qty: B.units }) : null;
  out(`putaway_${label}`, { tasksFound: tasks.length, readyRoute: ready.status, ensure: put?.status ?? null, ensureErr: put?.error?.message?.slice(0, 160) ?? null, task: !!taskId, bin: bin ? 'assigned' : null,
    complete: done?.status ?? null, err: done?.error?.message?.slice(0, 200) ?? null, taskKeys: Object.keys(t ?? {}).join(',') });
}
// What the bridge did.
await new Promise((r) => setTimeout(r, 8000));
const ob = await C.rp('owner', 'GET', '/v1/bridge/outbox?limit=50');
out('bridgeOutbox', { status: ob.status, rows: (Array.isArray(ob.body) ? ob.body : ob.body?.items ?? []).map((e) => ({ type: e.type, delivered: !!(e.publishedAt ?? e.deliveredAt), lastStatus: e.lastHttpStatus ?? null, parked: e.parkedReason ?? null })) });
