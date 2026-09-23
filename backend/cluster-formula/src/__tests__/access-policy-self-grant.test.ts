/**
 * Security review S1, item 7 — CatalogService.createAccessPolicy self-grant guard. Real
 * Postgres, lane S1's own test DB (`FORMULA_TEST_DATABASE_URL` / default TEST_DATABASE_URL,
 * both point at rawprod_s1_test for this lane — see backend/cluster-formula/src/__tests__/
 * db.ts, unmodified, just pointed at this lane's database via env).
 *
 * `formula:formula_access_policy:write` is held only by `vault_approver` (scripts/ra-roles.ts).
 * Before this fix, a vault_approver could grant themselves a FORMULA_ACCESS_POLICY row for any
 * formula, which — combined with FormulasService.assertFormulaAccess (owner OR an active
 * policy grant) — is a one-step bypass of the per-formula scoping that gates the actual
 * plaintext read. The fix requires the grantee (when a userId is named) to be a DIFFERENT
 * person than the caller — a genuine two-person rule.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '@core/data-kernel';
import * as formulaSchema from '@ra/data-formula';
import { CatalogService } from '../catalog/catalog.service.js';
import { ensureSchema, formulaDb, closeTestClient } from './db.js';
import { principal } from '../../../test-support/db.js';

const { formulaMaster } = formulaSchema;

let db: ReturnType<typeof formulaDb>;
let catalog: CatalogService;

before(async () => {
  await ensureSchema();
  db = formulaDb();
  catalog = new CatalogService(db as any);
});

afterAll(async () => {
  await closeTestClient();
});

async function makeFormula(): Promise<string> {
  const formulaId = uuidv7();
  await db.insert(formulaMaster).values({
    formulaId,
    formulaCode: `TST-${uuidv7()}`,
    formulaName: 'test formula',
    status: 'ACTIVE',
    createdBy: 'test',
    updatedBy: 'test',
  });
  return formulaId;
}

test('item 7: a vault_approver self-granting a formula access policy is refused', async () => {
  const formulaId = await makeFormula();
  const vaultApproverId = uuidv7();
  const vaultApprover = principal({ userId: vaultApproverId, roles: ['vault_approver'], permissions: ['formula:formula_access_policy:write'] });

  await assert.rejects(
    () => catalog.createAccessPolicy({ formulaId, userId: vaultApproverId }, vaultApprover),
    (err: any) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /cannot grant yourself/i);
      return true;
    },
  );
});

test('item 7: a vault_approver granting a DIFFERENT vault_approver access succeeds (genuine two-person rule)', async () => {
  const formulaId = await makeFormula();
  const granter = uuidv7();
  const grantee = uuidv7();
  const vaultApprover = principal({ userId: granter, roles: ['vault_approver'], permissions: ['formula:formula_access_policy:write'] });

  const row = await catalog.createAccessPolicy({ formulaId, userId: grantee }, vaultApprover);
  assert.equal(row.formulaId, formulaId);
  assert.equal(row.userId, grantee);
});

test('item 7: a role-only grant (no userId named) is unaffected by the self-grant guard', async () => {
  const formulaId = await makeFormula();
  const granter = uuidv7();
  const vaultApprover = principal({ userId: granter, roles: ['vault_approver'], permissions: ['formula:formula_access_policy:write'] });
  const roleId = uuidv7();

  const row = await catalog.createAccessPolicy({ formulaId, roleId }, vaultApprover);
  assert.equal(row.formulaId, formulaId);
  assert.equal(row.roleId, roleId);
});
