import { client, stateFile, EMAIL } from './lib.mjs';
const run = process.argv[2];
const C = client({ keysFile: `${run}/keys.json`, run });
const S = stateFile(`${run}/state.json`).load();
for (const role of ['formulator', 'vault_approver']) {
  const a = await C.rp(role, 'GET', '/v1/formula-access-audit?limit=500', undefined, { vault: true });
  const rows = Array.isArray(a.body) ? a.body : a.body?.items ?? [];
  const by = {}; for (const r of rows) { const k = `${r.action}|${r.result ?? ''}`; by[k] = (by[k] ?? 0) + 1; }
  console.log(role, a.status, rows.length, JSON.stringify(by), Object.keys(rows[0] ?? {}).join(','));
}
// An Alembic person with no RawProd account
EMAIL.stranger = 'someone.at.alembic@example.invalid';
const r = await C.rp('stranger', 'GET', `/v1/formula-versions/${S.vault.F1.fv}/ingredients`, undefined, { vault: true }).catch((e) => ({ status: 'signin refused', msg: e.message.slice(0, 160) }));
console.log('alembic-only person', JSON.stringify(r).slice(0, 300));
