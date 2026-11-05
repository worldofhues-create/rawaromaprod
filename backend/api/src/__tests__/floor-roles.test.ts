/**
 * PROD-A-3 — the six floor roles (production-floor plan §10) and their grant-refusal rules: coded
 * material only, no role granting, nothing from the Vault, not the §109.7 instruction read, and
 * none of the rules engine's admin writes. Seed-time (ra-roles.ts / db-seed.ts) and runtime
 * (SecurityService.createRolePermission) must agree.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '@core/data-kernel';
import { ROLES, FLOOR_ROLES, floorForbidden, ROLE_GRANTERS } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';
import { SecurityService, FLOOR_ROLES as RUNTIME_FLOOR_ROLES, FLOOR_FORBIDDEN } from '../../../cluster-org/src/security/security.service.js';
import { ensureSchema, testClient, orgDb, principal, closeTestClient } from '../../../test-support/db.js';

const grantOf = (code: string) => {
  const r = ROLES.find((x) => x.code === code);
  assert.ok(r, `role ${code} exists`);
  return RA_PERMISSIONS.filter((p) => r!.select(p));
};

test('all six floor roles exist in the seed catalogue, each with a sample login', () => {
  assert.deepEqual(FLOOR_ROLES, ['picker', 'verifier', 'mixer', 'packing', 'logistics', 'finance']);
  for (const c of FLOOR_ROLES) {
    const r = ROLES.find((x) => x.code === c)!;
    assert.ok(r.passwordEnv.startsWith('BOOTSTRAP_'));
    assert.ok(grantOf(c).length > 0, `${c} holds something`);
  }
});

test('no floor role holds a forbidden permission (reveal, iam, formula, vault, instruction, rule writes)', () => {
  for (const c of FLOOR_ROLES) {
    const bad = grantOf(c).filter(floorForbidden);
    assert.deepEqual(bad, [], `${c} must not hold ${bad.join(', ')}`);
    assert.ok(!ROLE_GRANTERS.includes(c));
  }
});

test('station split: picker picks, verifier verifies, mixer mixes; none holds another station\'s write', () => {
  const p = grantOf('picker'), v = grantOf('verifier'), m = grantOf('mixer');
  assert.ok(p.includes('production:floor_pick:write') && !p.includes('production:floor_verify:write') && !p.includes('production:floor_mix:write'));
  assert.ok(v.includes('production:floor_verify:write') && !v.includes('production:floor_pick:write') && !v.includes('production:floor_mix:write'));
  assert.ok(m.includes('production:floor_mix:write') && !m.includes('production:floor_pick:write') && !m.includes('production:floor_verify:write'));
  for (const g of [p, v, m]) assert.ok(g.includes('inventory:lot_barcode:resolve') && g.includes('production:floor_label:write'));
});

test('logistics cannot change an order or a price; finance only reads', () => {
  const l = grantOf('logistics');
  assert.ok(!l.includes('sales:sales_order:write') && !l.includes('sales:sales_order_items:write') && !l.includes('sales:customer_master:write'));
  assert.ok(grantOf('finance').every((p) => p.endsWith(':read')));
});

test('the runtime refusal mirrors the seed rule exactly', () => {
  assert.deepEqual(RUNTIME_FLOOR_ROLES, FLOOR_ROLES);
  for (const p of [...RA_PERMISSIONS, 'masterdata:material:reveal']) assert.equal(FLOOR_FORBIDDEN(p), floorForbidden(p), p);
});

test('admin runs the Rules screen and the colour table; only procurement (and owner) file a material under a family', () => {
  const a = grantOf('admin');
  for (const p of ['platform:policy:read', 'platform:policy:write', 'platform:policy_override:write', 'masterdata:floor_family:write']) assert.ok(a.includes(p), p);
  assert.ok(!a.includes('masterdata:floor_code:write'));
  const holders = ROLES.filter((r) => r.select('masterdata:floor_code:write')).map((r) => r.code).sort();
  assert.deepEqual(holders, ['owner', 'procurement']);
});

/* ── runtime: SecurityService refuses mapping a forbidden permission onto a floor role ──── */

before(ensureSchema);
after(closeTestClient);

test('runtime: mapping material reveal onto picker is refused; an allowed floor permission is not', async () => {
  const sql = testClient();
  const roleId = uuidv7();
  const code = 'picker';
  const [existing] = await sql<{ role_id: string }[]>`select role_id from iam.role_master where role_code = ${code}`;
  const pickerRoleId = existing?.role_id ?? roleId;
  if (!existing) await sql`insert into iam.role_master (role_id, role_code, role_name, status, created_by, updated_by) values (${pickerRoleId}, ${code}, 'Picker', 'ACTIVE', 'test', 'test')`;
  const permId = async (c: string) => {
    await sql`insert into iam.permission_master (permission_id, permission_code, permission_name, status, created_by, updated_by)
      values (${uuidv7()}, ${c}, ${c}, 'ACTIVE', 'test', 'test') on conflict do nothing`;
    const [r] = await sql<{ permission_id: string }[]>`select permission_id from iam.permission_master where permission_code = ${c} limit 1`;
    return r!.permission_id;
  };
  const security = new SecurityService(orgDb() as never);
  const owner = principal({ roles: ['owner'] });
  const reveal = await permId('masterdata:material:reveal');
  const policyWrite = await permId('platform:policy:write');
  await assert.rejects(() => security.createRolePermission({ roleId: pickerRoleId, permissionId: reveal } as never, owner), /may never be mapped/);
  await assert.rejects(() => security.createRolePermission({ roleId: pickerRoleId, permissionId: policyWrite } as never, owner), /may never be mapped/);
  const ok = await security.createRolePermission({ roleId: pickerRoleId, permissionId: await permId('production:floor_queue:read') } as never, owner);
  assert.ok(ok);
});
