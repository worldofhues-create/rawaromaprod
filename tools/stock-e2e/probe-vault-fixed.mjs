import { client } from './lib.mjs';
const run = process.argv[2];
const C = client({ keysFile: `${run}/keys.json`, run });
const V = { vault: true };
const f = await C.must('formulator', 'POST', '/v1/formulas', { formulaCode: `REH-PROBE-EMPTY2-${Date.now()}`, formulaName: 'probe: empty after fix' }, V);
const fv = (await C.must('formulator', 'POST', '/v1/formula-versions', { formulaId: f.formulaId, versionNumber: 1 }, V)).formulaVersionId;
const sub = await C.rp('formulator', 'POST', `/v1/formula-versions/${fv}/submit-for-review`, {}, V);
const appr = await C.rp('vault_approver', 'POST', `/v1/formula-versions/${fv}/approve`, { remarks: 'probe' }, V);
console.log('vaultAfterFix', JSON.stringify({ submit: sub.status, approve: appr.status, msg: appr.error?.message?.replace(/[0-9a-f-]{36}/, '<v>').slice(0, 140) }));
