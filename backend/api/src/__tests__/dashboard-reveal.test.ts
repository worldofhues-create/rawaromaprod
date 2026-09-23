/**
 * S3 security review item 10 — DashboardService.snapshot's `reveal.product` flag. `formula:
 * actual:` is a NEVER_IMPLICIT permission everywhere else in this codebase
 * (backend-kernel's PermissionsGuard.NEVER_IMPLICIT_PATTERNS: "super_admin/owner/admin get NO
 * implicit vault plaintext"), but the dashboard's own `isOwner` check used to bypass that rule
 * for product identity — an owner/super_admin principal holding no `formula:actual:read`
 * permission at all still saw real formula names. This proves the fix: `reveal.product` is
 * true ONLY for a principal explicitly holding `formula:actual:read`, role notwithstanding.
 *
 * Real Postgres (`testClient()`), the same DashboardService the app actually wires up — every
 * one of `snapshot()`'s ~30 aggregate queries degrades to `[]` on failure (its own documented
 * resilience), so this runs correctly even against a database with no formula.* tables at all
 * (the vault schema is deliberately absent from the shared test schema — see vault-isolation-
 * check.test.ts) and even with every other table empty. `reveal` is computed independently of
 * any row data, so no fixture rows are needed to prove this specific flag.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { DashboardService } from '../dashboard/dashboard.service.js';

let svc: DashboardService;

before(async () => {
  await ensureSchema();
  svc = new DashboardService(testClient());
});

after(async () => {
  await closeTestClient();
});

test('super_admin WITHOUT formula:actual:read does NOT see product identity (the fix)', async () => {
  const snap = await svc.snapshot(principal({ roles: ['super_admin'], permissions: [] }));
  assert.equal(snap.reveal.product, false);
});

test('owner WITHOUT formula:actual:read does NOT see product identity either', async () => {
  const snap = await svc.snapshot(principal({ roles: ['owner'], permissions: [] }));
  assert.equal(snap.reveal.product, false);
});

test('a principal holding formula:actual:read EXPLICITLY sees product identity, role notwithstanding', async () => {
  const snap = await svc.snapshot(principal({ roles: [], permissions: ['formula:actual:read'] }));
  assert.equal(snap.reveal.product, true);
});

test('super_admin WITH formula:actual:read also sees product identity (role + explicit permission both present)', async () => {
  const snap = await svc.snapshot(principal({ roles: ['super_admin'], permissions: ['formula:actual:read'] }));
  assert.equal(snap.reveal.product, true);
});

test('control: seeMaterial is UNCHANGED by this fix — isOwner still grants it implicitly '
  + '(masterdata:material:reveal is not a NEVER_IMPLICIT permission)', async () => {
  const snap = await svc.snapshot(principal({ roles: ['super_admin'], permissions: [] }));
  assert.equal(snap.reveal.material, true);
});
