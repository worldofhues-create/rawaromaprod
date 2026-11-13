/* Step 3: F1..F5 into the Vault, as the system intends: recipe import (percent), submit, second-person
 * approval, lock. Then who can read it. Prints statuses and counts only, never a line. */
import { readSheet, formulasOf, normName, client, until, stateFile } from './lib.mjs';
const [xlsx, run] = process.argv.slice(2);
const C = client({ api: 'http://127.0.0.1:4361', vault: 'http://127.0.0.1:4362', keysFile: `${run}/keys.json` });
const st = stateFile(`${run}/state.json`); const S = st.load();
const ev = (k, v) => { S.ev ??= {}; S.ev[k] = v; console.log(k, JSON.stringify(v)); st.save(S); };
const { formulas } = formulasOf(readSheet(xlsx));
const V = { vault: true };

/** mg of a line over the formula's total -> percent text, exact (6 decimals is the Vault's limit). */
function pct(mg, totalMg) {
  const scaled = BigInt(mg) * 100_000_000n; // percent x 1e6
  if (scaled % BigInt(totalMg) !== 0n) throw new Error('not exact at 6 decimals');
  const v = scaled / BigInt(totalMg);
  return `${v / 1_000_000n}.${String(v % 1_000_000n).padStart(6, '0')}`.replace(/\.?0+$/, '');
}
const csvOf = (code, lines) => ['formula_code,material_code,percentage', ...lines.map((l) => `${code},${l.materialCode},${l.pct}`)].join('\n');

// The material catalogue reaches the Vault on a timer.
await until('the catalogue on the Vault', async () => {
  const r = await C.rp('formulator', 'GET', `/v1/vault/materials?q=${encodeURIComponent('REH-RM-196')}`, undefined, V);
  return r.status === 200 && JSON.stringify(r.body).includes('REH-RM-196');
}, 60_000).catch(() => ev('catalogueOnVault', 'not seen by search within 60 s'));

S.vault ??= {};
for (const f of formulas) {
  if (S.vault[f.id]?.approved) continue;
  const code = `REH-${f.id}`;
  const made = S.vault[f.id]?.formulaId ? { formulaId: S.vault[f.id].formulaId } : await C.must('formulator', 'POST', '/v1/formulas', { formulaCode: code, formulaName: `Rehearsal ${f.id}` }, V);
  S.vault[f.id] = { formulaId: made.formulaId, code };
  const lines = f.lines.map((l) => ({ row: l.row, k: normName(l.name), materialCode: S.mat[normName(l.name)].code, mg: l.mg, pct: pct(l.mg, f.totalMg) }));
  // 1. As the sheet stands: dry run.
  const dry = await C.must('formulator', 'POST', '/v1/formula-recipes/import', { csv: csvOf(code, lines), commit: false }, V);
  const rec = dry.recipes?.[0] ?? {};
  const out = { lines: lines.length, dry: { errorCount: dry.errorCount, warningCount: dry.warningCount, total: rec.total, recipeErrors: (rec.errors ?? []).map((e) => e.replace(/line \d+/g, 'line N')), rowErrors: dry.rows?.filter((r) => r.error).length } };
  // 2. Duplicate material lines merged (grams added), as a formulator would have to.
  const merged = [];
  for (const l of lines) { const m = merged.find((x) => x.k === l.k); if (m) { m.mg += l.mg; m.mergedRows.push(l.row); } else merged.push({ ...l, mergedRows: [l.row] }); }
  for (const m of merged) m.pct = pct(m.mg, f.totalMg);
  out.mergedRows = merged.filter((m) => m.mergedRows.length > 1).map((m) => m.mergedRows);
  const commit = await C.rp('formulator', 'POST', '/v1/formula-recipes/import', { csv: csvOf(code, merged), commit: true, submit: true }, V);
  out.commit = { status: commit.status, committed: commit.body?.committed, errorCount: commit.body?.errorCount, total: commit.body?.recipes?.[0]?.total, version: commit.body?.recipes?.[0]?.version?.versionNumber };
  const fv = commit.body?.recipes?.[0]?.version?.formulaVersionId;
  S.vault[f.id].fv = fv;
  // 3. The author cannot approve; the second person can (fresh sign-in).
  const self = await C.rp('formulator', 'POST', `/v1/formula-versions/${fv}/approve`, { remarks: 'self' }, V);
  const appr = await C.rp('vault_approver', 'POST', `/v1/formula-versions/${fv}/approve`, { remarks: 'rehearsal' }, V);
  const lock = await C.rp('vault_approver', 'POST', `/v1/formula-versions/${fv}/lock`, {}, V);
  out.approve = { byAuthor: self.status, bySecondPerson: appr.status, err: appr.error?.message?.slice(0, 120) ?? null, lock: lock.status };
  S.vault[f.id].approved = appr.status < 300;
  S.vault[f.id].lines = merged.map((m) => ({ k: m.k, mg: m.mg, rows: m.mergedRows }));
  ev(`vault_${f.id}`, out);
}

// Does the Vault check the total? A probe version of F5 with its smallest line left out (so it totals under 100 %).
if (!S.vault.probeShort) {
  const f = formulas[4];
  const small = [...f.lines].sort((a, b) => a.mg - b.mg)[0];
  const lines = f.lines.filter((l) => l !== small).map((l) => ({ materialCode: S.mat[normName(l.name)].code, pct: pct(l.mg, f.totalMg) }));
  const made = await C.must('formulator', 'POST', '/v1/formulas', { formulaCode: 'REH-PROBE-SHORT', formulaName: 'Rehearsal probe: under 100 %' }, V);
  const commit = await C.rp('formulator', 'POST', '/v1/formula-recipes/import', { csv: csvOf('REH-PROBE-SHORT', lines), commit: true, submit: true }, V);
  const fv = commit.body?.recipes?.[0]?.version?.formulaVersionId;
  const appr = await C.rp('vault_approver', 'POST', `/v1/formula-versions/${fv}/approve`, { remarks: 'probe' }, V);
  // And one with nothing in it at all.
  const empty = await C.must('formulator', 'POST', '/v1/formulas', { formulaCode: 'REH-PROBE-EMPTY', formulaName: 'Rehearsal probe: empty' }, V);
  const efv = (await C.must('formulator', 'POST', '/v1/formula-versions', { formulaId: empty.formulaId, versionNumber: 1 }, V)).formulaVersionId;
  const esub = await C.rp('formulator', 'POST', `/v1/formula-versions/${efv}/submit-for-review`, {}, V);
  const eappr = await C.rp('vault_approver', 'POST', `/v1/formula-versions/${efv}/approve`, { remarks: 'probe' }, V);
  S.vault.probeShort = { fv, formulaId: made.formulaId, emptyFv: efv };
  ev('vaultTotalProbe', { shortTotal: commit.body?.recipes?.[0]?.total, shortWarnings: commit.body?.warningCount, shortCommitted: commit.body?.committed, shortApprove: appr.status,
    emptySubmit: esub.status, emptyApprove: eappr.status, emptyErr: eappr.error?.message?.slice(0, 120) ?? esub.error?.message?.slice(0, 120) ?? null });
}

// Who can read it afterwards.
const fv1 = S.vault.F1.fv;
const probe = {};
for (const role of ['picker', 'verifier', 'mixer', 'sales', 'production', 'qc', 'warehouse', 'formulator', 'vault_approver', 'owner']) {
  const a = await C.rp(role, 'GET', `/v1/formula-versions/${fv1}/ingredients`, undefined, V).catch((e) => ({ status: `signin:${String(e.message).slice(0, 40)}` }));
  const b = await C.rp(role, 'POST', `/v1/formula-versions/${fv1}/actual`, { reason: 'rehearsal access probe' }, V).catch((e) => ({ status: `signin:${String(e.message).slice(0, 40)}` }));
  const shape = a.status === 200 ? Object.keys((Array.isArray(a.body) ? a.body[0] : a.body?.items?.[0]) ?? {}).join(',') : null;
  probe[role] = { ingredients: a.status, actual: b.status, ingredientFields: shape };
}
ev('vaultReadProbe', probe);
// The main box: does any route there hand a floor role a name or a percentage? (it holds no formula DB)
const mainFormula = await C.rp('picker', 'GET', `/v1/formula-versions/${fv1}/ingredients`);
ev('mainBoxFormulaRoute', { picker: mainFormula.status });
// An Alembic person with no RawProd account (an unknown email in a valid assertion).
// Every read is logged: the Vault's access audit.
const audit = await C.rp('owner', 'GET', '/v1/formula-access-audit?limit=200', undefined, V);
const rows = Array.isArray(audit.body) ? audit.body : audit.body?.items ?? [];
const byAction = {}; for (const r of rows) { const k = `${r.action ?? r.eventType ?? '?'}|${r.result ?? ''}`; byAction[k] = (byAction[k] ?? 0) + 1; }
ev('vaultAudit', { status: audit.status, rows: rows.length, byAction, fields: Object.keys(rows[0] ?? {}) });
