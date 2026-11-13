/* STOCK-FIX-RP (STK-10): each batch's remnant counted and decided, through the real route, after packing.
 * B1 and B6 kept (packable later), B2 short of the book by a little and written off, B3 (QC failed)
 * written off whole, B5 held. Statuses and integer mg only. Usage: node s8-remnant.mjs <runDir> */
import { client, stateFile } from './lib.mjs';
const [run] = process.argv.slice(2);
const C = client({ api: 'http://127.0.0.1:4361', vault: 'http://127.0.0.1:4362', keysFile: `${run}/keys.json` });
const st = stateFile(`${run}/state.json`); const S = st.load();
const plan = { B1: 'KEEP', B2: 'LOSS_WRITE_OFF', B3: 'FAILED_WRITE_OFF', B5: 'HOLD', B6: 'KEEP' };
const out = {};
for (const [label, what] of Object.entries(plan)) {
  const B = S.batch?.[label];
  if (!B?.oil) { out[label] = 'no oil batch'; continue; }
  const bal = await C.must('production', 'GET', `/v1/oil-batches/${B.oil}/balance`);
  const r = { before: { made: bal.madeMg, packed: bal.packedMg, rejected: bal.rejectedMg, remaining: bal.remainingMg, status: bal.status } };
  const post = (role, body) => C.rp(role, 'POST', `/v1/oil-batches/${B.oil}/remnant`, body);
  if (what === 'KEEP' || what === 'HOLD') {
    r.overBook = (await post('production', { weighedMg: bal.remainingMg + 1, disposition: 'KEEP', reason: 'probe' })).status;
    r.decide = (await post('production', { weighedMg: bal.remainingMg, disposition: what, reason: what === 'HOLD' ? 'rehearsal: held for review' : undefined })).status;
  } else if (what === 'LOSS_WRITE_OFF') {
    const loss = Math.min(345, bal.remainingMg);
    r.packagingWriteOff = (await post('packaging', { weighedMg: bal.remainingMg - loss, disposition: 'WRITE_OFF', reason: 'probe' })).status;
    r.noReason = (await post('production', { weighedMg: bal.remainingMg - loss, disposition: 'WRITE_OFF' })).status;
    r.decide = (await post('production', { weighedMg: bal.remainingMg - loss, disposition: 'WRITE_OFF', reason: 'rehearsal: residue in the vessel, below one pack' })).status;
  } else {
    r.keepFailed = (await post('production', { weighedMg: bal.remainingMg, disposition: 'KEEP' })).status;
    r.decide = (await post('production', { weighedMg: bal.remainingMg, disposition: 'WRITE_OFF', reason: 'rehearsal: QC 1 failed' })).status;
  }
  const after = await C.must('production', 'GET', `/v1/oil-batches/${B.oil}/balance`);
  r.after = { made: after.madeMg, packed: after.packedMg, rejected: after.rejectedMg, loss: after.lossMg, writtenOff: after.writtenOffMg, remaining: after.remainingMg, yieldBp: after.yieldBp,
    remnant: after.remnant?.disposition ?? null, balances: after.madeMg === after.packedMg + after.rejectedMg + after.lossMg + after.writtenOffMg + (after.remainingMg ?? 0) };
  out[label] = r;
  console.log(label, JSON.stringify(r));
}
S.remnants = out; st.save(S);
