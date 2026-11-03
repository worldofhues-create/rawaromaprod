/**
 * SWEEP2-O6 (RawProd): Factory, Platform and Vault send every write through one tunnel and none
 * carried an idempotency key or held its button, so a double press was two writes. raOnce answers an
 * identical in-flight write from the first request and holds the pressed button; the channel's own
 * retries, the refresh and Ruh's confirmed resend bypass it so nothing waits on itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FILES = ['web/shell.js', 'web-platform/platform.js', 'web-vault/vault.js'];

function load(file: string) {
  const js = readFileSync(join(root, file), 'utf8');
  const s = js.indexOf('  /* SWEEP2-O6: one press');
  const e = js.indexOf('\n  }\n', js.indexOf('function raOnce(', s)) + 4;
  let onClick: ((e: unknown) => void) | null = null;
  const ctx: Record<string, unknown> = { document: { addEventListener: (_t: string, f: (e: unknown) => void) => { onClick = f; } }, Date, Promise, JSON, String };
  vm.runInNewContext(js.slice(s, e) + '\nthis.raOnce = raOnce;', ctx);
  return { raOnce: ctx.raOnce as (p: string, o: unknown, r: () => Promise<unknown>) => Promise<unknown> | null, press: (el: unknown) => onClick!({ target: { closest: () => el } }) };
}

for (const file of FILES) {
  test(`${file}: a double press writes once and the button is held until it answers`, async () => {
    const { raOnce, press } = load(file);
    let sent = 0;
    const run = () => new Promise((r) => setTimeout(() => r({ status: 200, n: ++sent }), 20));
    const btn = { disabled: false, attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; }, removeAttribute(k: string) { delete this.attrs[k]; } };
    press(btn);
    const opts = { method: 'POST', body: { qty: 2 } };
    const a = raOnce('/v1/stock-adjustments', opts, run)!;
    assert.equal(btn.disabled, true);
    const b = raOnce('/v1/stock-adjustments', { method: 'POST', body: { qty: 2 } }, run)!;
    assert.deepEqual(await a, await b);
    assert.equal(sent, 1);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(btn.disabled, false);
    assert.equal(raOnce('/v1/stock-adjustments', { method: 'GET' }, run), null, 'reads are not merged');
    await raOnce('/v1/stock-adjustments', opts, run);
    assert.equal(sent, 2, 'a press after the answer is a new write');
  });
}

test('only a top-level call is merged; retries and the confirmed resend pass through', () => {
  const shell = readFileSync(join(root, 'web/shell.js'), 'utf8');
  assert.match(shell, /if \(_retried === undefined && !_ch && !\(opts && opts\.ruhConfirmed\)\) \{ var once = raOnce\(path, opts, function \(\) \{ return tunnel\(path, opts, false\); \}\)/);
  const plat = readFileSync(join(root, 'web-platform/platform.js'), 'utf8');
  assert.match(plat, /if \(_retried === undefined && !\(opts && opts\.ruhConfirmed\)\) \{ var once = raOnce/);
  const vault = readFileSync(join(root, 'web-vault/vault.js'), 'utf8');
  assert.match(vault, /opts\.raOnced\)\)\) \{ var once = raOnce\(path, opts, function \(\) \{ return callTunnel\(tunnel, path, Object\.assign\(\{\}, opts, \{ raOnced: true \}\)\); \}\)/);
});
