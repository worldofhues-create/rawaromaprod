/* Step 1: the sheet's ingredients as raw materials, through the real API. Prints counts only. */
import { readSheet, formulasOf, normName, client } from './lib.mjs';
import { stateFile } from './lib.mjs';
const [xlsx, run] = process.argv.slice(2);
const C = client({ api: 'http://127.0.0.1:4361', vault: 'http://127.0.0.1:4362', keysFile: `${run}/keys.json` });
const st = stateFile(`${run}/state.json`); const S = st.load();
const ev = (k, v) => { S.ev ??= {}; S.ev[k] = v; console.log(k, JSON.stringify(v)); };

const sheet = readSheet(xlsx);
const { formulas, notes } = formulasOf(sheet);
ev('sheet', { sheets: sheet.sheets, rows: sheet.rows.length, formulas: formulas.map((f) => ({ id: f.id, headRow: f.headRow, lines: f.lines.length, totalMg: f.totalMg, totalRows: f.totalRows.map((t) => t.row) })), blankInsideBlock: notes.blankInsideBlock, colC: notes.colC });
// Spelling variants: names the same after trimming and case, and names repeated inside one formula.
const spell = new Map();
for (const f of formulas) for (const l of f.lines) { const k = normName(l.name); (spell.get(k) ?? spell.set(k, new Set()).get(k)).add(l.name); }
ev('names', { rawSpellings: new Set(formulas.flatMap((f) => f.lines.map((l) => l.name))).size, distinctAfterTrimAndCase: spell.size,
  withTrailingOrLeadingSpace: [...new Set(formulas.flatMap((f) => f.lines.map((l) => l.name)))].filter((n) => n !== n.trim()).length,
  groupsWithVariants: [...spell.values()].filter((s) => s.size > 1).length,
  repeatedInsideAFormula: formulas.flatMap((f) => { const seen = new Map(); const rep = []; for (const l of f.lines) { const k = normName(l.name); if (seen.has(k)) rep.push(`${f.id} row ${seen.get(k)} and row ${l.row}`); else seen.set(k, l.row); } return rep; }),
  dilutionMarked: [...spell.keys()].filter((k) => /\d+(\.\d+)?\s*%/.test(k)).length });

if (!S.masters) {
  const uom = async (code, name) => (await C.must('owner', 'POST', '/v1/uoms', { uomCode: code, uomName: name })).uomId;
  const g = await uom('g', 'Gram'), kg = await uom('kg', 'Kilogram'), pcs = await uom('pcs', 'Pieces');
  const vendor = (await C.must('procurement', 'POST', '/v1/vendors', { vendorCode: 'REH-V-1', vendorName: 'Rehearsal supplier (scratch)' })).vendorId;
  const qcParam = (await C.must('qc', 'POST', '/v1/qc-parameters', { parameterCode: 'REH-RI', parameterName: 'Refractive index' })).qcParameterId;
  S.masters = { g, kg, pcs, vendor, qcParam }; st.save(S);
}
// The floor's colour families: the sheet names none. One family for everything, Signal for the solvents (D-2).
const fams = await C.must('owner', 'GET', '/v1/floor/families');
ev('familiesBefore', (Array.isArray(fams) ? fams : fams.items ?? []).length);
for (const [code, name, colour, hex, initial] of [['solvent', 'Solvent', 'Signal', '#2F5DFF', 'S'], ['unsorted', 'Not yet sorted (rehearsal)', 'Grey', '#8A8A8A', 'G']]) {
  const r = await C.rp('owner', 'PUT', `/v1/floor/families/${code}`, { familyName: name, colourName: colour, colourHex: hex, initial });
  if (r.status >= 300 && r.status !== 409) throw new Error(`family ${code}: ${r.status} ${JSON.stringify(r.error)}`);
}

// One material per name after trimming and case. A code is minted here because the sheet has none.
S.mat ??= {};
const tStart = Date.now(); let created = 0, refused = [];
const keys = [...spell.keys()];
const SOLVENT = new Set(['dpg', 'ipm', 'dep', 'tec', 'ethanol', 'benzyl benzoate']);
for (const [i, k] of keys.entries()) {
  if (S.mat[k]) continue;
  const name = [...spell.get(k)][0].trim();
  const code = `REH-RM-${String(i + 1).padStart(3, '0')}`;
  const r = await C.rp('owner', 'POST', '/v1/materials', { materialCode: code, materialName: name, uomId: S.masters.g, qcRequired: true, shelfLifeDays: 730 });
  if (r.status >= 300) { refused.push({ index: i + 1, status: r.status, code: r.error?.code }); continue; }
  const fc = await C.rp('owner', 'POST', '/v1/floor/codes', { materialId: r.body.materialId, familyCode: SOLVENT.has(k) ? 'solvent' : 'unsorted' });
  S.mat[k] = { id: r.body.materialId, code, floor: fc.body?.code ?? null, floorStatus: fc.status };
  created++;
}
st.save(S);
ev('materials', { created, refused, apiCallsPerMaterial: 2, seconds: Math.round((Date.now() - tStart) / 1000),
  withFloorCode: Object.values(S.mat).filter((m) => m.floor).length, floorCodeStatuses: [...new Set(Object.values(S.mat).map((m) => m.floorStatus))] });
// A second material with the same code, and one with the same name: does the master refuse either?
const dupCode = await C.rp('owner', 'POST', '/v1/materials', { materialCode: 'REH-RM-001', materialName: 'duplicate code probe', uomId: S.masters.g });
const firstName = [...spell.get(keys[0])][0].trim();
const dupName = await C.rp('owner', 'POST', '/v1/materials', { materialCode: 'REH-RM-PROBE', materialName: firstName, uomId: S.masters.g });
ev('duplicateProbes', { sameCode: dupCode.status, sameName: dupName.status });
if (dupName.status < 300) S.probeMaterial = dupName.body.materialId;
S.formulasMeta = formulas.map((f) => ({ id: f.id, headRow: f.headRow, lines: f.lines.length, totalMg: f.totalMg }));
st.save(S);
