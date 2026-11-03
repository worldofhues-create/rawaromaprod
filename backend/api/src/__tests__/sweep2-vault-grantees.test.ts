/**
 * SWEEP2-O4: the Vault's Access grants card showed grantees as raw user and role UUIDs and asked a
 * vault_approver -- who may not read user_master -- to paste a "User UUID" to grant access. It now
 * reads GET /v1/formula-grantees (names only, on formula:formula_access_policy:read), shows names,
 * and grants through a picker of people by name that leaves out the approver themself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../../../../scripts/ra-roles.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

test('the directory route is the grants read, and every role that reads grants may ask it', () => {
  const ctl = read('backend/cluster-org/src/security/security.controller.ts');
  assert.match(ctl, /@Permissions\('formula:formula_access_policy:read'\)\s*@Get\('v1\/formula-grantees'\)/);
  for (const code of ['owner', 'formulator', 'vault_approver']) {
    assert.ok(ROLES.find((r) => r.code === code)!.select('formula:formula_access_policy:read'), code);
  }
});

test('the directory sends names, never secrets or contact numbers', () => {
  const svc = read('backend/cluster-org/src/security/security.service.ts');
  const body = svc.slice(svc.indexOf('async formulaGrantees('), svc.indexOf('Who may approve a PENDING'));
  assert.ok(body.length > 100);
  assert.doesNotMatch(body, /passwordHash|mobileNumber|employeeCode|alembicSubject/);
  assert.match(body, /accountKind === 'HUMAN'/);
});

test('the card shows names and grants by picker, not by pasted UUID', () => {
  const v = read('web-vault/vault.js');
  const card = v.slice(v.indexOf("var page = await apiAll('/v1/formula-access-policies"), v.indexOf("h('h2', {}, ['Access grants'])"));
  assert.doesNotMatch(card, /User UUID/);
  assert.doesNotMatch(card, /\[g\.userId \|\| '—'\]|\[g\.roleId \|\| '—'\]/);
  assert.match(card, /mainApi\('\/v1\/formula-grantees'\)/);
  assert.match(card, /h\('select', \{ class: 'fld', 'aria-label': 'Person to grant access'/);
  assert.match(card, /u\.userId !== me/);
});
