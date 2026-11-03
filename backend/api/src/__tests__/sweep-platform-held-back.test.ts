/**
 * SWEEP-PLATFORM: "Updates not sent" (web-platform/platform.js; no browser). GET
 * /v1/bridge/outbox/parked returns at most 200 rows, oldest first (outbox-admin.service.ts
 * listParked), and the card headlined "200 held back" as the total. After a sales-system outage
 * the backlog is in the thousands; the admin would replay 200 and believe the backlog cleared.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web-platform/platform.js'), 'utf8');

test('a full page of held-back updates says more are behind it', () => {
  const s = js.indexOf('function heldBackCount(');
  assert.ok(s > 0, 'platform.js defines heldBackCount');
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext(js.slice(s, js.indexOf('\n  }\n', s) + 4) + '\nthis.f = heldBackCount;', ctx);
  const f = ctx.f as (n: number) => string;
  assert.equal(f(3), '3 held back');
  assert.match(f(200), /oldest 200 shown, more held back/);
  assert.match(js, /heldBackCount\(items\.length\)/);
});
