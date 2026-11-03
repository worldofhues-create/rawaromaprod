/**
 * SWEEP2-FACTORY-2: a "+ New" form is shown on can(cfg.perm), so cfg.perm must be the permission
 * the POST it sends is guarded by. New plan item was shown on production:production_plan:write while
 * POST /v1/production-plan-items needs production:production_plan_items:write: today the same roles
 * hold both, so it is latent, and the first grant that splits them shows a form that only refuses
 * (or hides one that would work). Routes on DynamicPermission check in the service and are exempt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const shell = readFileSync(join(root, 'web/shell.js'), 'utf8');
const ctrl: string[] = [];
(function walk(d: string) {
  for (const e of readdirSync(d)) {
    if (['node_modules', 'dist', '__tests__'].includes(e)) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p); else if (e.endsWith('.controller.ts')) ctrl.push(readFileSync(p, 'utf8'));
  }
})(join(root, 'backend'));

test('every + New form is gated on the permission its POST route requires', () => {
  const start = shell.indexOf('  var CREATE = {');
  const tb = shell.slice(start, shell.indexOf('\n  };', start));
  const bad: string[] = [];
  let n = 0;
  for (const m of tb.matchAll(/\n    '\/v1\/([^']+)':\s*\{\s*title:\s*'([^']*)'[^\n]*?perm:\s*'([^']+)'/g)) {
    const [, ep, title, perm] = m;
    const re = new RegExp(`@Permissions\\('([^']+)'\\)\\s*@Post\\('v1/${ep!.replace(/[-/]/g, (c) => '\\' + c)}'\\)`);
    const hit = ctrl.map((c) => re.exec(c)).find(Boolean);
    if (!hit) continue; // DynamicPermission or a non-static guard: the service decides
    n++;
    if (hit[1] !== perm) bad.push(`${title}: form ${perm}, route ${hit[1]}`);
  }
  assert.ok(n > 30, `checked ${n} forms`);
  assert.deepEqual(bad, []);
});
