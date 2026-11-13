/* Step 4: one production batch through the stations, by the API, with the wrong things tried on the way.
 * Usage: node s4-produce.mjs <xlsx> <runDir> <F1..F5> <batch grams> <label> [qcfail|skipmac|short]  Counts and statuses only. */
import { readSheet, formulasOf, normName, client, until, stateFile } from './lib.mjs';
const [xlsx, run, fid, batchG, label, mode = 'full'] = process.argv.slice(2);
const C = client({ api: 'http://127.0.0.1:4361', vault: 'http://127.0.0.1:4362', keysFile: `${run}/keys.json` });
const st = stateFile(`${run}/state.json`); const S = st.load();
const B = (S.batch ??= {})[label] ??= { fid, batchG: Number(batchG), mode, steps: {} };
const step = (k, v) => { B.steps[k] = v; console.log(label, k, JSON.stringify(v)); st.save(S); };
const { formulas } = formulasOf(readSheet(xlsx));
const f = formulas.find((x) => x.id === fid);
const today = () => new Date().toISOString().slice(0, 10);
const { g } = S.masters;
const batchMg = Number(batchG) * 1000;

// What the formula says each line must be, exactly, in mg (the merged Vault lines).
const exact = S.vault[fid].lines.map((l) => ({ k: l.k, materialId: S.mat[l.k].id, mg: (l.mg * batchMg) / f.totalMg }));

if (!B.order) {
  const plan = (await C.must('production', 'POST', '/v1/production-plans', { planDate: today() })).productionPlanId;
  const item = (await C.must('production', 'POST', '/v1/production-plan-items', { productionPlanId: plan, formulaId: S.vault[fid].formulaId, plannedQty: Number(batchG), uomId: g })).productionPlanItemId;
  const o = await C.rp('production', 'POST', '/v1/production-orders', { formulaVersionId: S.vault[fid].fv, productionPlanItemId: item, orderQty: Number(batchG), uomId: g });
  if (o.status >= 300) { step('order', { status: o.status, error: o.error }); process.exit(1); }
  B.order = o.body.order.productionOrderId; B.plan = plan; B.planItem = item;
  const ings = o.body.ingredients ?? o.body.order?.ingredients ?? [];
  step('order', { status: o.status, orderNumber: o.body.order.orderNumber, ingredientsReturned: Array.isArray(ings) ? ings.length : null, bodyKeys: Object.keys(o.body),
    reservation: o.body.reservation ? { linesReserved: o.body.reservation.linesReserved, shortLines: o.body.reservation.shortLines } : null });
}
// Reservation at planning (LD-19): is anything reserved by the order itself?
const resv = (await C.all('warehouse', '/v1/stock-reservations')).filter((r) => r.reservedForDocumentId === B.order);
step('reservedByOrder', { reservations: resv.length });

if (!B.pickList) {
  const pl = await C.rp('production', 'POST', `/v1/production-orders/${B.order}/pick-list`, { pickListDate: today() });
  if (pl.status >= 300) { step('pickList', { status: pl.status, error: pl.error }); process.exit(1); }
  B.pickList = pl.body.pickList.materialPickListId;
  const items = pl.body.items ?? [];
  // Scaling: the system's line quantity against the exact formula quantity, to the mg.
  const sysMg = items.map((i) => ({ materialId: i.materialId, mg: Math.round(Number(i.pickedQty ?? i.requiredQty) * 1000) }));
  const diffs = exact.map((e) => { const s = sysMg.find((x) => x.materialId === e.materialId); return s ? s.mg - e.mg : null; });
  step('pickList', { status: pl.status, lines: items.length, formulaLines: exact.length, exactTotalMg: exact.reduce((s, e) => s + e.mg, 0), systemTotalMg: sysMg.reduce((s, x) => s + x.mg, 0),
    linesOff: diffs.filter((d) => d !== 0).length, maxOffMg: Math.max(...diffs.map((d) => Math.abs(d ?? 0))), missing: diffs.filter((d) => d === null).length, itemFields: Object.keys(items[0] ?? {}).join(','),
    exactNonIntegerMg: exact.filter((e) => !Number.isInteger(e.mg)).length });
  B.sysLines = sysMg;
}

if (!B.job) {
  const j = await C.rp('production', 'POST', '/v1/floor/jobs', { productionOrderId: B.order });
  // STOCK-FIX-RP (STK-9): a short order is known at planning and kept off the floor (no picker is sent to an empty shelf).
  if (j.status >= 300) {
    step('job', { status: j.status, error: j.error?.message?.replace(/[A-Z]+-\d{4}/g, 'CODE').slice(0, 160) ?? null });
    if (mode === 'short' && j.status === 409) {
      // The short order is cancelled, which releases what it did hold, so the later batches are not starved by a probe.
      const held = (await C.all('warehouse', '/v1/stock-reservations')).filter((r) => r.reservedForDocumentId === B.order && !r.releasedDt).length;
      const c = await C.rp('production', 'POST', `/v1/production-orders/${B.order}/cancel`, { reason: 'rehearsal: shortfall probe' });
      const after = (await C.all('warehouse', '/v1/stock-reservations')).filter((r) => r.reservedForDocumentId === B.order && !r.releasedDt).length;
      step('cancel', { status: c.status, holdsBefore: held, released: c.body?.reservationsReleased ?? null, holdsAfter: after });
      process.exit(0);
    }
    process.exit(1);
  }
  B.job = j.body.floorJobId; step('job', { status: j.status, jobNo: j.body.jobNo, lines: j.body.lines, steps: j.body.steps });
}

/* ── 1 Pick ── */
if (!B.picked) {
  const view = await C.must('picker', 'GET', `/v1/floor/jobs/${B.job}/pick`);
  const leak = JSON.stringify(view);
  const names = exact.map((e) => [...new Set(formulas.flatMap((x) => x.lines.filter((l) => normName(l.name) === e.k).map((l) => l.name.trim())))][0]);
  step('pickView', { lines: view.lines.length, waiting: view.lines.filter((l) => l.waiting).length, showsName: names.some((n) => n.length > 3 && leak.includes(n)), showsGrams: /targetMg|grams|"mg"/i.test(leak), fields: Object.keys(view.lines[0] ?? {}).join(',') });
  if (view.lines.some((l) => l.waiting)) { step('pickBlocked', { waiting: view.lines.filter((l) => l.waiting).map((l) => ({ seq: l.seq, why: l.waiting.replace(/[A-Z]+-\d{4}/, 'CODE') })) }); if (mode === 'short') process.exit(0); }
  const lots = S.receipt.lines;
  const probes = {};
  if (view.stop) probes.resumedLeftoverStop = (await C.rp('production', 'POST', `/v1/floor/jobs/${B.job}/stop/resume`, { reason: 'rehearsal: a stop left by an earlier run' })).status;
  // a) the wrong material: line 1 scanned with line 2's lot -> refused and the line stops.
  if (!B.wrongProbeDone && view.lines.length > 1 && view.lines[1].takeLot && !view.lines[0].picked) {
    B.wrongProbeDone = true;
    const r = await C.rp('picker', 'POST', `/v1/floor/jobs/${B.job}/pick/lines/${view.lines[0].floorLineId}`, { barcode: view.lines[1].takeLot.barcode, bin: view.lines[1].takeLot.bin ?? '' });
    const blocked = await C.rp('picker', 'POST', `/v1/floor/jobs/${B.job}/pick/lines/${view.lines[0].floorLineId}`, { barcode: view.lines[0].takeLot.barcode, bin: view.lines[0].takeLot.bin ?? '' });
    const selfResume = await C.rp('picker', 'POST', `/v1/floor/jobs/${B.job}/stop/resume`, { reason: 'probe' });
    const resume = await C.rp('production', 'POST', `/v1/floor/jobs/${B.job}/stop/resume`, { reason: 'rehearsal: wrong drum put back' });
    probes.wrongMaterial = { scan: r.status, rightLotWhileStopped: blocked.status, resumeBySamePerson: selfResume.status, resumeBySupervisor: resume.status };
  }
  // b) off-FEFO: an F1 material with two lots; take the later one without a reason, then with one.
  let offFefoDone = null;
  for (const l of view.lines) {
    const k = Object.keys(S.mat).find((x) => S.mat[x].floor === l.floorCode);
    const later = lots.filter((x) => x.k === k && !x.probe && x.invBatch).sort((a, b) => b.expiry.localeCompare(a.expiry))[0];
    if (!later || lots.filter((x) => x.k === k && !x.probe).length < 2 || offFefoDone) continue;
    const mint = await C.rp('warehouse', 'POST', `/v1/floor/lots/${later.invBatch}/barcode`, {});
    const code = mint.body?.barcode ?? mint.body?.code;
    const no = await C.rp('picker', 'POST', `/v1/floor/jobs/${B.job}/pick/lines/${l.floorLineId}`, { barcode: code, bin: '' });
    const yes = await C.rp('picker', 'POST', `/v1/floor/jobs/${B.job}/pick/lines/${l.floorLineId}`, { barcode: code, bin: '', reason: 'rehearsal: older drum seal broken' });
    offFefoDone = l.floorLineId; probes.offFefo = { withoutReason: no.status, withReason: yes.status, mintStatus: mint.status };
  }
  // c) a lot that holds less than the line (or a stranger's barcode): an unknown label.
  // d) everything else as directed.
  const tally = {};
  const fresh = await C.must('picker', 'GET', `/v1/floor/jobs/${B.job}/pick`);
  for (const l of fresh.lines) {
    if (l.picked) continue;
    if (!l.takeLot) { tally.noLot = (tally.noLot ?? 0) + 1; continue; }
    const r = await C.rp('picker', 'POST', `/v1/floor/jobs/${B.job}/pick/lines/${l.floorLineId}`, { barcode: l.takeLot.barcode, bin: l.takeLot.bin ?? '' });
    tally[r.status] = (tally[r.status] ?? 0) + 1;
    if (r.status >= 300) tally[`e${r.status}`] = r.error?.message?.slice(0, 140);
  }
  const early = await C.rp('verifier', 'POST', `/v1/floor/jobs/${B.job}/verify/complete`, {});
  const done = await C.rp('picker', 'POST', `/v1/floor/jobs/${B.job}/pick/complete`, { tote: `T-${label}` });
  step('pick', { probes, tally, verifyBeforePickDone: early.status, complete: done.status, err: done.error?.message?.slice(0, 160) ?? null });
  if (done.status >= 300) process.exit(1);
  B.picked = true; st.save(S);
}

/* ── 2 Verify (issue by the weighed grams) ── */
// STOCK-FIX-RP (STK-27): the rehearsal has no scale, so every weight is typed, and a typed weight is
// accepted only with a second person's sign-off: the verifier asks, the admin (not the typist) signs.
async function typed(mg) {
  const c = await C.must('verifier', 'POST', '/v1/scales/typed-checks', { station: 'Floor', mg, reason: 'rehearsal: no scale connected' });
  await C.must('admin', 'POST', `/v1/scales/typed-checks/${c.checkId}/sign`, {});
  return { source: 'typed', weightCheckId: c.checkId };
}
if (!B.verified) {
  const v = await C.must('verifier', 'GET', `/v1/floor/jobs/${B.job}/verify`);
  const probes = {};
  const first = v.lines.find((l) => !l.verified);
  probes.pickerVerifies = (await C.rp('picker', 'POST', `/v1/floor/jobs/${B.job}/verify/lines/${first.floorLineId}`, { actualMg: first.targetMg, source: 'typed' })).status;
  probes.typedUnsigned = (await C.rp('verifier', 'POST', `/v1/floor/jobs/${B.job}/verify/lines/${first.floorLineId}`, { actualMg: first.targetMg, source: 'typed' })).status;
  const out = await C.rp('verifier', 'POST', `/v1/floor/jobs/${B.job}/verify/lines/${first.floorLineId}`, { actualMg: first.targetMg + first.toleranceMg + 1, ...(await typed(first.targetMg + first.toleranceMg + 1)) });
  probes.outOfTolerance = { status: out.status, verified: out.body?.verified ?? null };
  const tally = {}; B.weighed = {};
  for (const [i, l] of v.lines.entries()) {
    if (l.verified) continue;
    // Every third line weighs a little under its target (inside tolerance): the ledger must end on the reading.
    const under = i % 3 === 1 ? Math.min(l.toleranceMg, Math.floor(l.targetMg / 500)) : 0;
    const actual = l.targetMg - under;
    const r = await C.rp('verifier', 'POST', `/v1/floor/jobs/${B.job}/verify/lines/${l.floorLineId}`, { actualMg: actual, ...(await typed(actual)) });
    const k = `${r.status}:${r.body?.verified}`; tally[k] = (tally[k] ?? 0) + 1;
    if (r.body?.verified) B.weighed[l.floorLineId] = { seq: l.seq, targetMg: l.targetMg, actualMg: actual };
    else tally[`why:${r.status}`] = (r.body?.message ?? r.error?.message ?? '').slice(0, 140);
  }
  const done = await C.rp('verifier', 'POST', `/v1/floor/jobs/${B.job}/verify/complete`, {});
  step('verify', { probes, tally, underWeighedLines: Object.values(B.weighed).filter((w) => w.actualMg < w.targetMg).length,
    targetTotalMg: Object.values(B.weighed).reduce((s, w) => s + w.targetMg, 0), weighedTotalMg: Object.values(B.weighed).reduce((s, w) => s + w.actualMg, 0), complete: done.status, err: done.error?.message?.slice(0, 160) ?? null });
  if (done.status >= 300) process.exit(1);
  B.verified = true; st.save(S);
}

/* ── 3 Compound ── */
if (!B.oil) {
  const m = await C.must('mixer', 'GET', `/v1/floor/jobs/${B.job}/mix`);
  const leak = JSON.stringify(m);
  const probes = {};
  probes.verifierMixes = (await C.rp('verifier', 'POST', `/v1/floor/jobs/${B.job}/mix/steps/1`, {})).status;
  probes.outOfOrder = (await C.rp('mixer', 'POST', `/v1/floor/jobs/${B.job}/mix/steps/${Math.min(3, m.steps.length)}`, {})).status;
  probes.completeEarly = (await C.rp('mixer', 'POST', `/v1/floor/jobs/${B.job}/mix/complete`, {})).status;
  probes.mixerSeesName = exact.some((e) => { const n = formulas.flatMap((x) => x.lines).find((l) => normName(l.name) === e.k)?.name.trim(); return n && n.length > 3 && leak.includes(n); });
  probes.mixerSeesPercent = /%|percent/i.test(leak);
  probes.stepShape = Object.keys(m.steps[0] ?? {}).join(',');
  // STOCK-FIX-RP (STK-15, D-1): the scoped reveal, tried as the floor would try it. Statuses only; the name is
  // checked to be present or absent, never printed.
  if (process.env.REVEAL_PROBE === label) {
    // The mixer's user id: the subject of the access token the mixer already holds (it read the mix view above).
    const tok = C.tokens.get('mixer|factory')?.token;
    const mixerId = tok ? JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8')).sub : null;
    probes.revealUnassigned = (await C.rp('mixer', 'POST', `/v1/floor/jobs/${B.job}/mix/reveal`, {})).status;
    probes.assign = (await C.rp('production', 'POST', `/v1/floor/jobs/${B.job}/mix/assign`, { userId: mixerId })).status;
    const rv = await C.rp('mixer', 'POST', `/v1/floor/jobs/${B.job}/mix/reveal`, {});
    const k = exact[0]?.k; const name = k ? formulas.flatMap((x) => x.lines).find((l) => normName(l.name) === k)?.name.trim() : null;
    probes.reveal = { status: rv.status, seq: rv.body?.seq ?? null, nameIsLine1s: !!(name && rv.body?.name === name), fields: Object.keys(rv.body ?? {}).sort().join(',') };
    probes.revealFutureStep = (await C.rp('mixer', 'POST', `/v1/floor/jobs/${B.job}/mix/reveal`, { seq: 2 })).status;
    probes.revealPicker = (await C.rp('picker', 'POST', `/v1/floor/jobs/${B.job}/mix/reveal`, {})).status;
    probes.revealVerifier = (await C.rp('verifier', 'POST', `/v1/floor/jobs/${B.job}/mix/reveal`, {})).status;
    const log = await C.must('production', 'GET', `/v1/floor/jobs/${B.job}/mix/reveals`);
    probes.revealLog = { views: log.items.length, logCarriesName: !!(name && JSON.stringify(log).includes(name)) };
  }
  let ok = 0;
  for (const s of m.steps) { const r = await C.rp('mixer', 'POST', `/v1/floor/jobs/${B.job}/mix/steps/${s.seq}`, {}); if (r.status < 300) ok++; }
  if (process.env.REVEAL_PROBE === label) probes.revealAfterLastStep = (await C.rp('mixer', 'POST', `/v1/floor/jobs/${B.job}/mix/reveal`, {})).status;
  const done = await C.rp('mixer', 'POST', `/v1/floor/jobs/${B.job}/mix/complete`, {});
  B.oil = done.body?.oilBatchId; B.oilNo = done.body?.batchNo;
  step('mix', { probes, steps: m.steps.length, stepsDone: ok, complete: done.status, batchNo: done.body?.batchNo ?? null, err: done.error?.message?.slice(0, 160) ?? null });
  if (!B.oil) process.exit(1);
  st.save(S);
}

/* ── QC 1, maceration, QC 2 ── */
if (!B.released) {
  const ob = (await C.all('compounding', '/v1/oil-batches')).find((x) => x.oilBatchId === B.oil);
  step('oilBatch', { status: ob?.status, producedQty: ob?.producedQty, uom: ob?.uomId === g ? 'g' : ob?.uomId, weighedTotalMg: Object.values(B.weighed).reduce((s, w) => s + w.actualMg, 0) });
  if (!B.macSet) {
    const put = await C.rp('owner', 'PUT', `/v1/maceration/settings/${S.vault[fid].formulaId}`, { required: true, minDays: 45, maxDays: 120 });
    B.macSet = put.status; step('macerationSetting', { status: put.status, err: put.error?.message?.slice(0, 120) ?? null });
  }
  const qcBody = (pass) => ({ oilBatchId: B.oil, qcParameterId: S.masters.qcParam, observedValue: pass ? 1.47 : 1.52, specMin: 1.46, specMax: 1.48 });
  if (mode === 'skipmac') {
    // LD-99: can maceration be skipped? ACTIVE -> HOLD -> RELEASED with one QC PASS.
    const q = await C.rp('qc', 'POST', '/v1/production-qc', qcBody(true));
    const hold = await C.rp('compounding', 'POST', `/v1/oil-batches/${B.oil}/transition`, { status: 'HOLD' });
    const rel = await C.rp('compounding', 'POST', `/v1/oil-batches/${B.oil}/transition`, { status: 'RELEASED' });
    step('skipMaceration', { qc: q.body?.qc?.result, hold: hold.status, released: rel.status, err: rel.error?.message?.slice(0, 140) ?? null });
    B.released = rel.status < 300; st.save(S); process.exit(0);
  }
  if (mode === 'qcfail') {
    const q1 = await C.rp('qc', 'POST', '/v1/production-qc', qcBody(false));
    const mac = await C.rp('compounding', 'POST', `/v1/oil-batches/${B.oil}/transition`, { status: 'IN_MATURATION' });
    const fail = await C.rp('compounding', 'POST', `/v1/oil-batches/${B.oil}/transition`, { status: 'FAILED' });
    step('qc1Fail', { qc1: q1.body?.qc?.result ?? q1.status, intoMaceration: mac.status, macErr: mac.error?.message?.slice(0, 120) ?? null, failed: fail.status });
    process.exit(0);
  }
  const relBeforeQc = await C.rp('compounding', 'POST', `/v1/oil-batches/${B.oil}/transition`, { status: 'RELEASED' });
  const macBeforeQc = await C.rp('compounding', 'POST', `/v1/oil-batches/${B.oil}/transition`, { status: 'IN_MATURATION' });
  const q1 = await C.rp('qc', 'POST', '/v1/production-qc', qcBody(true));
  const mac = await C.rp('compounding', 'POST', `/v1/oil-batches/${B.oil}/transition`, { status: 'IN_MATURATION' });
  const relDay1 = await C.rp('compounding', 'POST', `/v1/oil-batches/${B.oil}/transition`, { status: 'RELEASED' });
  const runs = await C.all('production', '/v1/maceration/runs');
  const runRow = runs.find((r) => r.oilBatchId === B.oil);
  const early = {};
  for (const role of ['compounding', 'qc', 'production', 'admin', 'owner']) {
    const r = await C.rp(role, 'POST', `/v1/maceration/runs/${runRow?.macerationRunId ?? runRow?.id}/release-early`, { reason: 'rehearsal: cannot wait 45 days on a scratch database' });
    early[role] = r.status; if (r.status < 300) break;
  }
  const relNoQc2 = await C.rp('compounding', 'POST', `/v1/oil-batches/${B.oil}/transition`, { status: 'RELEASED' });
  const q2 = await C.rp('qc', 'POST', '/v1/production-qc', qcBody(true));
  const rel = await C.rp('compounding', 'POST', `/v1/oil-batches/${B.oil}/transition`, { status: 'RELEASED' });
  step('qcMaceration', { releaseBeforeAnyQc: relBeforeQc.status, maceratePreQc1: macBeforeQc.status, qc1: q1.body?.qc?.result, intoMaceration: mac.status, runFound: !!runRow, runMinDays: runRow?.minDays ?? null,
    releaseOnDay1: relDay1.status, releaseOnDay1Msg: relDay1.error?.message?.replace(/B-\d+-\d+/, 'B-…').slice(0, 120) ?? null, earlyReleaseBy: early, releaseWithoutQc2: relNoQc2.status, qc2: q2.body?.qc?.result, released: rel.status, err: rel.error?.message?.slice(0, 140) ?? null });
  B.released = rel.status < 300; st.save(S);
}
