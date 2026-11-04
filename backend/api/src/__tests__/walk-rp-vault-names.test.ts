/**
 * WALK-RP-18: the Vault's Access audit and Production audit showed each Actor as a raw user id
 * ("01a1a6da-585e-79c5-8b1c-5e6d9f3a63a6"), and Approve recipes showed Drafted by / Sealed by as the
 * first 8 characters of one, so an approver or auditor could not say who revealed or sealed a recipe.
 * The Vault's own database holds no names (by design), but the Access grants card already reads them
 * from the main box's narrow /v1/formula-grantees directory (SWEEP2-O4), under the caller's own
 * formula:formula_access_policy:read. The audits and Approve recipes now use the same directory; an
 * id the directory cannot name says "User 01a1a6da" rather than a bare id. No grant changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web-vault/vault.js'), 'utf8');
const grab = (sig: string) => { const s = js.indexOf(sig); assert.ok(s >= 0, sig); return js.slice(s, js.indexOf('\n  }\n', s) + 4); };

test('the audit table names its actors', () => {
  const ctx: Record<string, unknown> = {
    h: (tag: string, _a: unknown, kids: unknown[]) => ({ tag, kids }), fmtDt: (x: string) => x, session: { userId: 'ME' },
  };
  vm.createContext(ctx);
  vm.runInContext(grab('  function personName(') + grab('  function auditTable(') + '\nthis.f = auditTable;', ctx);
  const out = JSON.stringify((ctx.f as (r: unknown[], n: unknown) => unknown)([
    { occurredAt: 't', actorId: 'U1', action: 'a', entityId: 'e', result: 'allow' },
    { occurredAt: 't', actorId: 'U2', action: 'a', entityId: 'e' },
    { occurredAt: 't', actorId: 'ME', action: 'a', entityId: 'e' },
  ], { U1: 'qc@rawaroma.local' }));
  assert.match(out, /qc@rawaroma\.local/);
  assert.match(out, /User U2/);
  assert.match(out, /"You"/);
  assert.doesNotMatch(out, /"U1"/);
});

test('Approve recipes names who drafted and sealed', () => {
  const body = grab('  async function screenReview(');
  assert.match(body, /await peopleNames\(\)/);
  assert.doesNotMatch(body, /String\(id\)\.slice\(0, 8\) : '—'/);
});
