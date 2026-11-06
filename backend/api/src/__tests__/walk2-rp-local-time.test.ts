/**
 * WALK2-RP-6: floor screens and the hand-off label sliced the server's UTC ISO string for a time, so a
 * PICKED label and every "ends"/"last seen"/version time read 5h30 behind the floor's clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const f of ['web/ws-floor.js', 'web/ws-floor-ops.js']) {
  const js = strip(readFileSync(join(root, f), 'utf8'));
  test(`${f}: no UTC string slicing for a time`, () => {
    assert.doesNotMatch(js, /replace\('T', ' '\)\.slice\(0, 16\)/);
    assert.doesNotMatch(js, /String\(v\.createdDt\)\.slice/);
  });
  test(`${f}: localTime prints the local clock`, () => {
    const src = js.slice(js.indexOf('function localTime('), js.indexOf('\n', js.indexOf('function localTime(')));
    const ctx: Record<string, unknown> = {}; vm.createContext(ctx); vm.runInContext(src + '\nthis.f = localTime;', ctx);
    const iso = '2026-11-07T18:45:00.000Z'; const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    assert.equal((ctx.f as (v: string) => string)(iso), `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`);
    assert.equal((ctx.f as (v: null) => string)(null), '');
  });
}
