/**
 * SWEEP2-O4: the query behind GET /v1/formula-grantees, against real Postgres. It names active human
 * users and every role, and carries nothing a grant picker does not need -- no hash, no mobile.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { uuidv7 } from '@core/data-kernel';
import { SecurityService } from '../security/security.service.js';
import { ensureSchema, orgDb, orgSchema, closeTestClient } from '../../../test-support/db.js';

const { userMaster, roleMaster } = orgSchema;
let db: ReturnType<typeof orgDb>;
let svc: SecurityService;
before(async () => { await ensureSchema(); db = orgDb(); svc = new SecurityService(db as any, { async record() {} }); });
afterAll(async () => { await closeTestClient(); });

async function user(name: string, over: Record<string, unknown> = {}) {
  const userId = uuidv7();
  await db.insert(userMaster).values({ userId, userName: name, email: `${name}@t.test`, passwordHash: 'secret-hash', mobileNumber: '9999999999',
    isActive: true, status: 'ACTIVE', createdBy: 'test', updatedBy: 'test', ...over } as never);
  return userId;
}

test('active humans by name, every role by name, and nothing secret', async () => {
  const s = randomUUID().slice(0, 6);
  const alive = await user(`grantee-${s}`);
  const off = await user(`gone-${s}`, { isActive: false });
  const svcAcct = await user(`ruh-${s}`, { accountKind: 'SERVICE', passwordHash: null });
  const roleId = uuidv7();
  await db.insert(roleMaster).values({ roleId, roleCode: `r-${s}`, roleName: `Role ${s}`, status: 'ACTIVE', createdBy: 'test', updatedBy: 'test' });
  const out = await svc.formulaGrantees();
  const ids = out.users.map((u) => u.userId);
  assert.ok(ids.includes(alive));
  assert.ok(!ids.includes(off), 'inactive users are not offered');
  assert.ok(!ids.includes(svcAcct), 'service accounts are not offered');
  assert.deepEqual(Object.keys(out.users.find((u) => u.userId === alive)!).sort(), ['email', 'userId', 'userName']);
  assert.equal(out.roles.find((r) => r.roleId === roleId)?.roleName, `Role ${s}`);
  assert.doesNotMatch(JSON.stringify(out), /secret-hash|9999999999/);
});
