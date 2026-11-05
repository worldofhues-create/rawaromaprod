/**
 * PROD-A-1 — PolicyService on a real Postgres (production-floor plan §12.0): the seeded defaults,
 * publishing versions with who/why, a decision keeping the version it used, test-before-save,
 * single-record overrides limited to admin/owner, and HOLD when nothing resolves.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { PolicyService, PolicyUnresolved } from '../policy/policy.service.js';

let svc: PolicyService;
const admin = principal({ roles: ['admin'] });
const floor = principal({ roles: ['picker'], userId: '00000000-0000-7000-8000-0000000000aa' });

before(async () => {
  await ensureSchema();
  svc = new PolicyService(testClient());
});
after(closeTestClient);

/** A private policy per test, so tests never see each other's versions. */
async function freshPolicy(body: unknown = { rules: [], hasDefault: false }): Promise<string> {
  const sql = testClient();
  const key = `test.${crypto.randomUUID().slice(0, 8)}`;
  await sql`insert into platform.policy (policy_key, title) values (${key}, 'test')`;
  await sql`insert into platform.policy_version (policy_key, version, body, reason, created_by, created_dt)
    values (${key}, 1, ${sql.json(body as never)}, 'seed', 'system', now() - interval '1 day')`;
  return key;
}

test('the five plan policies exist; floor.queue defaults to strict alternation; payment terms hold', async () => {
  const keys = (await svc.list()).map((r) => (r as { key: string }).key);
  for (const k of ['receiving.shortfall', 'floor.queue', 'procurement.payment_terms', 'planning.cover', 'qc.rework']) assert.ok(keys.includes(k), k);
  const q = await svc.evaluate('floor.queue', {});
  assert.deepEqual(q.value, { mode: 'alternate' });
  assert.equal(q.ruleId, null);
  assert.ok(q.version >= 1);
  await assert.rejects(() => svc.evaluate('procurement.payment_terms', { vendor: 'X' }), PolicyUnresolved);
});

test('an unknown policy is a 404, not a silent default', async () => {
  await assert.rejects(() => svc.evaluate('no.such.policy', {}), /No policy/);
});

test('publish: needs a reason, refuses an invalid body, and writes the next version with who', async () => {
  const key = await freshPolicy();
  await assert.rejects(() => svc.publish(key, { rules: [], hasDefault: true, defaultValue: 1 }, '  ', admin), /why/);
  await assert.rejects(() => svc.publish(key, { rules: [{ id: 'a', scope: 'x', when: [], then: 1 }], hasDefault: false }, 'r', admin), /unknown scope/);
  const v = await svc.publish(key, { rules: [{ id: 'a', scope: 'vendor', when: [{ field: 'vendor', op: 'eq', value: 'G' }], then: 10 }], hasDefault: true, defaultValue: 20 }, 'Givaudan is strict', admin);
  assert.equal(v.version, 2);
  const h = await svc.history(key);
  assert.equal((h.versions[0] as { createdBy: string }).createdBy, admin.userId);
  assert.equal((h.versions[0] as { reason: string }).reason, 'Givaudan is strict');
  const r = await svc.evaluate(key, { vendor: 'G' });
  assert.equal(r.value, 10);
  assert.equal(r.ruleId, 'a');
  assert.equal(r.version, 2);
});

test('versioned: a decision made yesterday re-evaluates on the version in force yesterday', async () => {
  const key = await freshPolicy({ rules: [], hasDefault: true, defaultValue: 'old' });
  const yesterday = new Date(Date.now() - 3600_000);
  const d = await svc.decide(key, { record_type: 'po', record_id: 'PO-1' }, admin, yesterday);
  await svc.publish(key, { rules: [], hasDefault: true, defaultValue: 'new' }, 'change', admin);
  assert.equal((await svc.evaluate(key, {})).value, 'new');
  assert.equal((await svc.evaluate(key, {}, yesterday)).value, 'old');
  assert.equal(d.version, 1);
  const [row] = await testClient()`select version, explain from platform.policy_decision where policy_key = ${key}`;
  assert.equal(row!.version, 1);
});

test('test before saving: a draft is evaluated, nothing is written, and a hold says hold', async () => {
  const key = await freshPolicy();
  const draft = { rules: [{ id: 'n', scope: 'material_family', when: [{ field: 'material_family', op: 'eq', value: 'naturals' }], then: 10 }], hasDefault: false };
  const hit = await svc.test(key, draft, { material_family: 'naturals' });
  assert.equal(hit.resolved, true);
  assert.equal((hit as { value: unknown }).value, 10);
  const miss = await svc.test(key, draft, { material_family: 'musk' });
  assert.equal(miss.resolved, false);
  assert.equal((miss as { hold?: boolean }).hold, true);
  const bad = await svc.test(key, { rules: 'x' }, {});
  assert.equal(bad.valid, false);
  assert.equal((await svc.history(key)).versions.length, 1);
});

test('override on one record: admin/owner only, needs a reason, shows OVERRIDDEN, and can be revoked', async () => {
  const key = await freshPolicy({ rules: [], hasDefault: true, defaultValue: 'reject' });
  await assert.rejects(() => svc.override(key, 'po', 'PO-7', 'accept', 'short ok', floor), /Only an admin/);
  await assert.rejects(() => svc.override(key, 'po', 'PO-7', 'accept', '', admin), /reason/);
  const o = await svc.override(key, 'po', 'PO-7', 'accept', 'Owner accepted this short delivery', admin);
  assert.equal(o.status, 'OVERRIDDEN');
  await assert.rejects(() => svc.override(key, 'po', 'PO-7', 'x', 'again', admin), /already has an override/);
  const r = await svc.evaluate(key, { record_type: 'po', record_id: 'PO-7' });
  assert.equal(r.value, 'accept');
  assert.match(r.explain, /OVERRIDDEN/);
  assert.equal((await svc.evaluate(key, { record_type: 'po', record_id: 'PO-8' })).value, 'reject');
  await svc.revokeOverride(o.overrideId, 'done', admin);
  assert.equal((await svc.evaluate(key, { record_type: 'po', record_id: 'PO-7' })).value, 'reject');
});

test('hold: decide() records the HOLD and still throws so the caller cannot proceed', async () => {
  const key = await freshPolicy();
  await assert.rejects(() => svc.decide(key, { record_type: 'po', record_id: 'PO-H' }, admin), PolicyUnresolved);
  const [row] = await testClient()`select explain, value from platform.policy_decision where policy_key = ${key}`;
  assert.match(String(row!.explain), /^HOLD/);
  assert.equal(row!.value, null);
});

test('version rows are append-only: two concurrent publishes get distinct versions', async () => {
  const key = await freshPolicy();
  const b = { rules: [], hasDefault: true, defaultValue: 1 };
  const [a, c] = await Promise.all([svc.publish(key, b, 'a', admin), svc.publish(key, b, 'c', admin)]);
  assert.notEqual(a.version, c.version);
});
