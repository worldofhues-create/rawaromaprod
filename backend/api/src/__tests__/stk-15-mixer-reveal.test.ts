/**
 * STOCK-FIX-RP (STK-15; owner decision D-1, LD-35, WO-FLOOR-6): the mixer's scoped name reveal, tested
 * as a hostile insider would try it.
 *
 * The rule: the material NAME, beside its floor code, on the CURRENT step of an ACTIVE batch, to the
 * mixer ASSIGNED to that batch, and to nobody else. Never a list, a share, a weight or a print; every
 * view logged (who, batch, step, when) with the name itself never written; gone the moment the step is
 * confirmed. Pickers and verifiers see codes only. The material names here are made up.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ensureSchema, testClient, productionDb, principal, closeTestClient } from '../../../test-support/db.js';
import { signedTyped } from '../../../test-support/typed-check-fixtures.js';
import { PickingService, MixingService, BatchService } from '@ra/cluster-production';
import type { VaultPort } from '../../../cluster-formula/src/vault-port.js';
import { FloorCodeService } from '../floor/floor-code.service.js';
import { FloorStationService } from '../floor/floor-station.service.js';

const vault: VaultPort = { async resolveManufacturingInstruction() { return null; }, async resolvePickList() { return null; } };
let codes: FloorCodeService;
let stations: FloorStationService;
const sql = () => testClient();
const uid = () => crypto.randomUUID();
const tag = () => uid().slice(0, 6).toUpperCase();
const NAMES = ['Zephyr Absolute Test', 'Quillwood Isolate Test'];
const REVEAL = 'production:floor_mix:reveal_name';

const admin = principal({ roles: ['admin'], userId: uid() });
const proc = principal({ roles: ['procurement'], userId: uid(), permissions: ['masterdata:material:reveal'] });
const picker = principal({ roles: ['picker'], userId: uid(), permissions: [] });
const verifier = principal({ roles: ['verifier'], userId: uid(), permissions: [] });
let mixerA: ReturnType<typeof principal>;
let mixerB: ReturnType<typeof principal>;

async function user(role: string) {
  const id = uid();
  await sql()`insert into iam.role_master (role_code, role_name, status) values (${role}, ${role}, 'ACTIVE') on conflict (role_code) do nothing`;
  await sql()`insert into iam.user_master (user_id, user_name, email, is_active, status) values (${id}, ${'Mixer ' + tag()}, ${`m-${id.slice(0, 8)}@test.local`}, true, 'ACTIVE')`;
  await sql()`insert into iam.user_role_mapping (user_id, role_id, status) select ${id}, role_id, 'ACTIVE' from iam.role_master where role_code = ${role}`;
  return principal({ roles: [role], userId: id, permissions: ['production:floor_mix:write', REVEAL] });
}

before(async () => {
  await ensureSchema();
  codes = new FloorCodeService(sql());
  const db = productionDb();
  stations = new FloorStationService(sql(), codes, new PickingService(db, vault), new MixingService(db), new BatchService(db));
  mixerA = await user('mixer');
  mixerB = await user('mixer');
});
after(closeTestClient);

async function gram() {
  await sql()`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values (${uid()}, 'g', 'gram', 'ACTIVE') on conflict do nothing`;
  return (await sql()`select uom_id::text from platform.uom_master where uom_code = 'g'`)[0]!.uom_id as string;
}

/** A job at MIX with two material lines and one production note, picked and verified. */
async function jobAtMix() {
  const t = tag();
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const fam = `fam_${t.toLowerCase()}`;
  await codes.setFamily({ familyCode: fam, familyName: `Family ${t}`, colourName: `Tone${letters}`, colourHex: '#2F5DFF' }, admin);
  const g = await gram();
  const mats: Array<{ id: string; code: string; lot: { barcode: string; bin: string } }> = [];
  for (const name of NAMES) {
    const id = uid();
    await sql()`insert into masterdata.material (material_id, material_code, material_name, status) values (${id}, ${'M-' + tag()}, ${name}, 'ACTIVE')`;
    const fc = await codes.assignCode(id, fam, proc);
    const rb = uid(), ib = uid(), bin = uid(), binCode = `PF-R-${tag()}`;
    await sql()`insert into location.bin_master (bin_id, bin_code, status) values (${bin}, ${binCode}, 'ACTIVE')`;
    await sql()`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status) values (${rb}, ${id}, ${'RM-' + tag()}, '2099-01-01', 'ACTIVE')`;
    await sql()`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values (${uid()}, ${rb}, 'ACCEPT')`;
    await sql()`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status) values (${ib}, ${rb}, ${id}, ${bin}, 1000, ${g}, 'ACTIVE')`;
    mats.push({ id, code: fc.code, lot: { barcode: await codes.lotBarcode(ib, null), bin: binCode } });
  }
  const orderId = uid(), pl = uid();
  await sql()`insert into production.production_order (production_order_id, order_qty, uom_id, status) values (${orderId}, 1, ${g}, 'INPROGRESS')`;
  await sql()`insert into production.material_pick_list (material_pick_list_id, production_order_id, status) values (${pl}, ${orderId}, 'ACTIVE')`;
  for (const [i, m] of mats.entries()) {
    await sql()`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, uom_id, status) values (${uid()}, ${orderId}, ${m.id}, ${10 + i}, false, ${g}, 'ACTIVE')`;
    await sql()`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, uom_id, status, created_dt) values (${uid()}, ${pl}, ${m.id}, ${10 + i}, ${g}, 'ACTIVE', clock_timestamp())`;
  }
  const job = await stations.createJob(orderId, { steps: ['Stir 10 minutes'] }, admin);
  const lines = (await stations.pickView(job.floorJobId)).lines;
  for (const [i, l] of lines.entries()) await stations.pickLine(job.floorJobId, l.floorLineId, { bin: mats[i]!.lot.bin, barcode: mats[i]!.lot.barcode }, picker);
  await stations.completePick(job.floorJobId, { tote: `T-${tag()}` }, picker);
  for (const l of (await stations.verifyView(job.floorJobId)).lines) await stations.verifyLine(job.floorJobId, l.floorLineId, { actualMg: l.targetMg, ...(await signedTyped(l.targetMg, verifier)) }, verifier);
  await stations.completeVerify(job.floorJobId, verifier);
  return { job, mats };
}

const noNames = (what: string, v: unknown) => {
  const s = JSON.stringify(v);
  for (const n of NAMES) assert.ok(!s.includes(n), `${what} carries no material name`);
};

test('the assigned mixer sees the current step\'s name beside its code, one name only, no share and no weight', async () => {
  const { job, mats } = await jobAtMix();
  await stations.assignMixer(job.floorJobId, mixerA.userId, admin);
  const r = await stations.revealCurrentStep(job.floorJobId, {}, mixerA);
  assert.deepEqual({ seq: r.seq, code: r.code, name: r.name }, { seq: 1, code: mats[0]!.code, name: NAMES[0] });
  assert.deepEqual(Object.keys(r).sort(), ['code', 'jobNo', 'name', 'seq', 'shownUntil']);
  assert.ok(!/\d+(\.\d+)?\s*%|mg|grams?\b/i.test(JSON.stringify({ ...r, shownUntil: '' })), 'no share, no weight');
});

test('hostile: another mixer, the verifier, a picker and an unassigned batch are refused', async () => {
  const { job } = await jobAtMix();
  await assert.rejects(() => stations.revealCurrentStep(job.floorJobId, {}, mixerA), (e: unknown) => e instanceof ForbiddenException && /no assigned mixer/.test((e as Error).message));
  await stations.assignMixer(job.floorJobId, mixerA.userId, admin);
  await assert.rejects(() => stations.revealCurrentStep(job.floorJobId, {}, mixerB), (e: unknown) => e instanceof ForbiddenException && /another mixer/.test((e as Error).message));
  await assert.rejects(() => stations.revealCurrentStep(job.floorJobId, {}, { ...verifier, permissions: [REVEAL] }), ForbiddenException);
  await assert.rejects(() => stations.revealCurrentStep(job.floorJobId, {}, picker), ForbiddenException);
  // Another mixer cannot even move the steps of a batch assigned to someone else.
  await assert.rejects(() => stations.doStep(job.floorJobId, 1, mixerB), /another mixer/);
  // The verifier or picker can never be assigned to mix it.
  await assert.rejects(() => stations.assignMixer(job.floorJobId, verifier.userId, admin), /picked or verified/);
  const n = await sql()`select count(*)::int as n from production.floor_mix_reveal where floor_job_id = ${job.floorJobId}`;
  assert.equal(n[0]!.n, 0, 'a refused reveal is not a view');
});

test('hostile: a future step is refused; a confirmed step\'s name is gone; a production note shows no name', async () => {
  const { job } = await jobAtMix();
  await stations.assignMixer(job.floorJobId, mixerA.userId, admin);
  await assert.rejects(() => stations.revealCurrentStep(job.floorJobId, { seq: 2 }, mixerA), (e: unknown) => e instanceof ForbiddenException && /Only the current step \(1\)/.test((e as Error).message));
  await stations.doStep(job.floorJobId, 1, mixerA);
  await assert.rejects(() => stations.revealCurrentStep(job.floorJobId, { seq: 1 }, mixerA), ForbiddenException);
  const second = await stations.revealCurrentStep(job.floorJobId, {}, mixerA);
  assert.equal(second.seq, 2);
  assert.equal(second.name, NAMES[1]);
  await stations.doStep(job.floorJobId, 2, mixerA);
  await assert.rejects(() => stations.revealCurrentStep(job.floorJobId, {}, mixerA), (e: unknown) => e instanceof ConflictException && /adds no material/.test((e as Error).message));
});

test('hostile: a finished batch shows nothing, and nothing the mixer, picker or verifier can read or print carries a name', async () => {
  const { job } = await jobAtMix();
  await stations.assignMixer(job.floorJobId, mixerA.userId, admin);
  const m = await stations.mixView(job.floorJobId);
  noNames('the mix view (every step)', m);
  noNames('the pick view', await stations.pickView(job.floorJobId));
  noNames('the verify view', await stations.verifyView(job.floorJobId));
  await stations.revealCurrentStep(job.floorJobId, {}, mixerA);
  for (const st of m.steps) await stations.doStep(job.floorJobId, st.seq, mixerA);
  const done = await stations.completeMix(job.floorJobId, mixerA);
  noNames('the MIXED label', done.label);
  noNames('a reprinted MIXED label', await stations.print(job.floorJobId, 'MIXED', 'smudged', mixerA));
  await assert.rejects(() => stations.revealCurrentStep(job.floorJobId, {}, mixerA), (e: unknown) => e instanceof ConflictException && /not a batch being mixed/.test((e as Error).message));
});

test('hostile: the log records who, job, step, line and when for every view, and never the name', async () => {
  const { job } = await jobAtMix();
  await stations.assignMixer(job.floorJobId, mixerA.userId, admin);
  await stations.revealCurrentStep(job.floorJobId, {}, mixerA);
  await stations.revealCurrentStep(job.floorJobId, {}, mixerA); // a second look is a second view
  const log = await stations.revealLog(job.floorJobId);
  assert.equal(log.items.length, 2);
  assert.ok(log.items.every((i) => i.revealedTo === mixerA.userId && i.stepSeq === 1 && i.revealedAt));
  noNames('the reveal log', log);
  const raw = await sql()`select * from production.floor_mix_reveal where floor_job_id = ${job.floorJobId}`;
  noNames('the reveal table', raw);
  await assert.rejects(() => sql()`update production.floor_mix_reveal set step_seq = 9 where floor_job_id = ${job.floorJobId}`, /append-only/);
  await assert.rejects(() => sql()`delete from production.floor_mix_reveal where floor_job_id = ${job.floorJobId}`, /append-only/);
});

test('hostile: a stopped line shows no name until a supervisor resumes it', async () => {
  const { job } = await jobAtMix();
  await stations.assignMixer(job.floorJobId, mixerA.userId, admin);
  const [l] = await sql()`select floor_line_id::text from production.floor_line where floor_job_id = ${job.floorJobId} order by seq limit 1`;
  await sql()`insert into production.floor_line_stop (floor_line_stop_id, floor_job_id, floor_line_id, station, kind, scanned, detail, stopped_by)
              values (${uid()}, ${job.floorJobId}, ${l!.floor_line_id}, 'PICK', 'WRONG_MATERIAL', 'X', 'test stop', ${picker.userId})`;
  await assert.rejects(() => stations.revealCurrentStep(job.floorJobId, {}, mixerA), /stopped/);
});

test('hostile: the grant is the mixer\'s alone, and it is not the everywhere-reveal; the route demands it', async () => {
  const { ROLES } = await import('../../../../scripts/ra-roles.js');
  const { RA_PERMISSIONS } = await import('../../../../scripts/ra-permissions.js');
  const grantOf = (code: string) => RA_PERMISSIONS.filter((p: string) => ROLES.find((x: { code: string }) => x.code === code)!.select(p));
  assert.ok(grantOf('mixer').includes(REVEAL));
  assert.ok(!grantOf('mixer').includes('masterdata:material:reveal'), 'the mixer does not get every name everywhere');
  for (const r of ['picker', 'verifier', 'packing', 'compounding', 'filling', 'production', 'warehouse', 'qc', 'sales']) assert.ok(!grantOf(r).includes(REVEAL), `${r} holds no reveal`);
  const { Reflector } = await import('@nestjs/core');
  const { FloorController } = await import('../floor/floor.controller.js');
  const { META_PERMISSIONS } = await import('../../../backend-kernel/src/decorators/metadata.keys.js');
  const meta = new Reflector().get(META_PERMISSIONS, FloorController.prototype.revealCurrentStep);
  assert.deepEqual(meta, [REVEAL]);
  // A supervisor reads the log; a mixer's own permissions do not include it.
  assert.deepEqual(new Reflector().get(META_PERMISSIONS, FloorController.prototype.revealLog), ['production:floor_job:write']);
  assert.ok(!grantOf('mixer').includes('production:floor_job:write'));
});
