/* Step 1: the sheet's ingredients as raw materials, through the real API. Prints counts only. */
import { readSheet, formulasOf, normName, client } from './lib.mjs';
import { stateFile } from './lib.mjs';
const [xlsx, run] = process.argv.slice(2);
const C = client({ keysFile: `${run}/keys.json`, run });
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
// The floor's colour families: the sheet names none. STOCK-FIX-RP (STK-19): the nine D-2 families are seeded
// by migration (Signal for the solvents among them); one more holds everything the sheet does not sort.
const fams = await C.must('owner', 'GET', '/v1/floor/families');
ev('familiesBefore', (Array.isArray(fams) ? fams : fams.items ?? []).length);
for (const [code, name, colour, hex, initial] of [['unsorted', 'Not yet sorted (rehearsal)', 'Olive', '#6B7A2A', 'V']]) {
  const r = await C.rp('owner', 'PUT', `/v1/floor/families/${code}`, { familyName: name, colourName: colour, colourHex: hex, initial });
  if (r.status >= 300 && r.status !== 409) throw new Error(`family ${code}: ${r.status} ${JSON.stringify(r.error)}`);
}

// One material per name after trimming and case. STOCK-FIX-RP (STK-17): ONE file through the raw-material
// import, a dry run then the commit, codes minted in order and floor codes filed with them. The file is
// built here, in memory, from the sheet, sent to the scratch API, and never written anywhere.
S.mat ??= {};
const tStart = Date.now(); let created = 0, refused = [];
const keys = [...spell.keys()];
const SOLVENT = new Set(['dpg', 'ipm', 'dep', 'tec', 'ethanol', 'benzyl benzoate']);
const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const todo = keys.filter((k) => !S.mat[k]);
if (todo.length) {
  const csv = ['material_name,family', ...todo.map((k) => `${csvCell([...spell.get(k)][0].trim())},${SOLVENT.has(k) ? 'solvent' : 'unsorted'}`)].join('\n');
  const dry = await C.must('procurement', 'POST', '/v1/materials/import', { csv });
  ev('importDryRun', { rows: dry.rows.length, errorCount: dry.errorCount, warningCount: dry.warningCount, onFile: dry.rows.filter((r) => r.onFile).length,
    errorKinds: [...new Set(dry.rows.flatMap((r) => r.errors.map((e) => e.replace(/".*"|line \d+|[A-Z]+-\d+/g, '_'))))],
    warningKinds: [...new Set(dry.rows.flatMap((r) => r.warnings.map((e) => e.replace(/".*"|line \d+|[A-Z]+-\d+/g, '_'))))], committed: dry.committed });
  const done = await C.rp('procurement', 'POST', '/v1/materials/import', { csv, commit: true });
  if (done.status >= 300 || !done.body.committed) { ev('importCommit', { status: done.status, errorCount: done.body?.errorCount ?? null }); process.exit(1); }
  for (const c of done.body.created) {
    const k = todo[c.line - 2];
    S.mat[k] = { id: c.materialId, code: c.materialCode, floor: c.floorCode, floorStatus: c.floorCode ? 201 : null };
    created++;
  }
  // STK-30: a name the factory already holds (the catalogue Alembic sent) is that material; it is used, not remade.
  for (const c of done.body.existing ?? []) {
    const k = todo[c.line - 2];
    S.mat[k] = { id: c.materialId, code: c.materialCode, floor: c.floorCode, floorStatus: c.floorCode ? 200 : null, onFile: true };
  }
  ev('alreadyOnFile', { rows: (done.body.existing ?? []).length, withFloorCode: (done.body.existing ?? []).filter((c) => c.floorCode).length });
}
st.save(S);
const codesInOrder = Object.values(S.mat).map((m) => m.floor).filter(Boolean);
ev('materials', { created, refused, apiCalls: 2, seconds: Math.round((Date.now() - tStart) / 1000),
  withFloorCode: codesInOrder.length, floorNumbersInOrder: codesInOrder.every((c, i, a) => i === 0 || a[i - 1].split('-')[0] !== c.split('-')[0] || Number(c.split('-')[1]) > Number(a[i - 1].split('-')[1])) });
// A second material with the same code, and one with the same name: does the master refuse either?
const dupCode = await C.rp('owner', 'POST', '/v1/materials', { materialCode: 'REH-RM-001', materialName: 'duplicate code probe', uomId: S.masters.g });
const firstName = [...spell.get(keys[0])][0].trim();
const dupName = await C.rp('owner', 'POST', '/v1/materials', { materialCode: 'REH-RM-PROBE', materialName: firstName, uomId: S.masters.g });
ev('duplicateProbes', { sameCode: dupCode.status, sameName: dupName.status });
if (dupName.status < 300) S.probeMaterial = dupName.body.materialId;
S.formulasMeta = formulas.map((f) => ({ id: f.id, headRow: f.headRow, lines: f.lines.length, totalMg: f.totalMg }));
st.save(S);
