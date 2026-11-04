/**
 * WALK-RP-21 [STOCK]: on Put-away & pick, pressing Go with the scan box empty did nothing at all (onScan in
 * web/ws-produce.js returned on an empty code), so a store keeper whose scanner had not fired saw a
 * dead button and pressed again. It now says what to do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web/ws-produce.js'), 'utf8');
const s = js.indexOf('  function onScan('), e = js.indexOf('\n  }\n', s) + 4;

test('Go with an empty scan box says so', () => {
  const toasts: string[] = []; let called = 0;
  const ctx: Record<string, unknown> = { PV: {}, $: () => ({ innerHTML: '' }), toast: (m: string) => toasts.push(m), tunnel: () => { called++; return new Promise(() => {}); } };
  vm.createContext(ctx);
  vm.runInContext(js.slice(s, e) + '\nthis.f = onScan;', ctx);
  (ctx.f as (c: string) => void)('');
  assert.equal(called, 0);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0]!, /Scan|type/);
});

// The real dead buttons: btn() always wrote type="button" and then the caller's type="submit", and a
// browser keeps the first of two same-named attributes. Go, Move and Add rack were therefore plain
// buttons inside their forms: pressing them never submitted, so stock could not be moved and a rack
// could not be added from a mouse or a touch screen (and Enter never submits a form of several fields
// with no submit button, despite "Enter saves" on Add a rack).
test('a submit button made by btn() is a submit button', () => {
  const line = js.split('\n').find((l) => l.trimStart().startsWith('function btn('))!;
  const ctx: Record<string, unknown> = {}; vm.createContext(ctx); vm.runInContext(line + '\nthis.f = btn;', ctx);
  const html = (ctx.f as (...a: string[]) => string)('', 'Move', 'p', ' type="submit"');
  assert.equal((html.match(/type="/g) || []).length, 1, html);
  assert.match(html, /type="submit"/);
  assert.match((ctx.f as (...a: string[]) => string)('x', 'Open'), /type="button"/);
});
