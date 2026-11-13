import { client, stateFile } from './lib.mjs';
const run = process.argv[2];
const C = client({ api: 'http://127.0.0.1:4361', vault: 'http://127.0.0.1:4362', keysFile: `${run}/keys.json` });
const parked = await C.rp('owner', 'GET', '/v1/bridge/outbox/parked?limit=50');
const rows = Array.isArray(parked.body) ? parked.body : parked.body?.items ?? [];
const res = [];
for (const r of rows) { const x = await C.rp('owner', 'POST', `/v1/bridge/outbox/${r.outboxId ?? r.id}/replay`, { reason: 'rehearsal: tenant id configured' }); res.push({ type: r.type, replay: x.status }); }
console.log('replay', JSON.stringify({ parked: rows.length, res, keys: Object.keys(rows[0] ?? {}).join(',') }));
const loc = await C.rp('warehouse', 'GET', '/v1/shelf/locations');
const bins = (Array.isArray(loc.body) ? loc.body : loc.body?.items ?? loc.body?.bins ?? []);
console.log('bins', JSON.stringify({ status: loc.status, n: bins.length, first: bins[0] ? Object.fromEntries(Object.entries(bins[0]).filter(([k]) => /code|bin/i.test(k))) : null }));
