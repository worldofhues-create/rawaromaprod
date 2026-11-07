/**
 * FLOOR-1 / FLOOR-2 — who holds lane floor-gaps' two permissions. A lot split is a stores task
 * (warehouse; the owner by its blanket grant); the verifier returns its leftover through the job's
 * own route (production:floor_verify:write), so it needs no split right. The FG zone colours are set
 * by the admin (and warehouse, which owns location:*). No floor role sets a colour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, FLOOR_ROLES } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';

const grantOf = (code: string) => RA_PERMISSIONS.filter((p) => ROLES.find((x) => x.code === code)!.select(p));
const SPLIT = 'inventory:lot_split:write', ZONE = 'location:fg_zone:write';

test('both permissions are in the catalogue; the owner holds both', () => {
  for (const p of [SPLIT, ZONE]) assert.ok(RA_PERMISSIONS.includes(p), p);
  assert.ok(grantOf('owner').includes(SPLIT) && grantOf('owner').includes(ZONE));
});

test('split: warehouse holds it; the floor roles do not (the verifier returns through its job)', () => {
  assert.ok(grantOf('warehouse').includes(SPLIT));
  for (const r of FLOOR_ROLES) assert.ok(!grantOf(r).includes(SPLIT), `${r} must not split lots`);
  assert.ok(grantOf('verifier').includes('production:floor_verify:write'));
});

test('FG zone colours: admin and warehouse set them; no floor role does', () => {
  assert.ok(grantOf('admin').includes(ZONE));
  assert.ok(grantOf('warehouse').includes(ZONE));
  for (const r of FLOOR_ROLES) assert.ok(!grantOf(r).includes(ZONE), `${r} must not set zone colours`);
});
