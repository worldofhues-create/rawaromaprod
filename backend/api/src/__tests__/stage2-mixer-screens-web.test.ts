/**
 * STAGE-2-RP (c), STK-38: the mixer's two screens, in the web app (web/ws-floor.js).
 *
 * The routes existed (STK-15) and no screen called them, so a supervisor could not assign a batch and
 * a mixer could not see the one name the owner decided they may see (D-1). The screens are the
 * smallest that are true: an "Assign mixer" control on the batch in the floor queue, and on the Mix
 * station the current step's name, asked for by a press, shown beside its floor code, and gone when
 * the step is confirmed. The browser walk (e2e/specs/factory/stk38-mixer-screens.spec.ts) drives both.
 * Here: the service worker cannot cache the answer, and the screen keeps no copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = (p: string) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');

/** web/sw.js with a recording `self`: which fetches it answers itself, and what it puts in a cache. */
function worker() {
  const listeners: Record<string, (e: unknown) => void> = {};
  const puts: string[] = [];
  const cache = { put: (k: unknown) => { puts.push(String((k as { url?: string }).url ?? k)); return Promise.resolve(); }, add: () => Promise.resolve(), match: () => Promise.resolve(undefined) };
  const sandbox: Record<string, unknown> = {
    URL, Promise,
    self: { location: { origin: 'https://rawfactory.huecycle.in' }, addEventListener: (n: string, f: (e: unknown) => void) => { listeners[n] = f; }, skipWaiting() {}, clients: { claim() {} } },
    caches: { open: () => Promise.resolve(cache), match: () => Promise.resolve(undefined), keys: () => Promise.resolve([]), delete: () => Promise.resolve(true) },
    fetch: () => Promise.resolve({ clone: () => ({}), ok: true, status: 200 }),
  };
  runInNewContext(read('web/sw.js'), sandbox);
  return {
    /** true when the worker took the request (respondWith), false when it left it to the network untouched. */
    takes(method: string, url: string, mode = 'cors'): boolean {
      let taken = false;
      listeners.fetch!({ request: { method, url, mode }, respondWith() { taken = true; }, waitUntil() {} });
      return taken;
    },
    puts,
  };
}

test('the service worker never touches the reveal: not the tunnel it travels through, not the route itself, by any method', async () => {
  const w = worker();
  const O = 'https://rawfactory.huecycle.in';
  for (const [method, url] of [
    ['POST', `${O}/rpc`], ['GET', `${O}/rpc`], // every console call is a POST to the encrypted tunnel
    ['POST', `${O}/v1/floor/jobs/0190a0c8-0000-7000-8000-000000000001/mix/reveal`],
    ['GET', `${O}/v1/floor/jobs/0190a0c8-0000-7000-8000-000000000001/mix/reveal`],
    ['GET', `${O}/v1/floor/jobs/0190a0c8-0000-7000-8000-000000000001/mix/assignment`],
    ['POST', 'https://api.rawfactory.huecycle.in/v1/floor/jobs/x/mix/reveal'],
  ] as const) assert.equal(w.takes(method, url), false, `${method} ${url} is left to the network`);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(w.puts, [], 'nothing was written to a cache');
  // the control: a static file IS taken, so the recorder would have seen a cache write
  assert.equal(w.takes('GET', `${O}/shell.css`), true);
});

const floor = read('web/ws-floor.js');

test('the Mix station asks for the name by a press, for the current step only, and keeps no copy', () => {
  assert.match(floor, /\/mix\/reveal', \{ method: 'POST', body: \{ seq: /, 'the reveal names the step it is for');
  assert.match(floor, /can\('production:floor_mix:reveal_name'\)/, 'only someone who holds the reveal permission is offered it');
  const view = /async function mixJobView\([\s\S]*?\n  \}\n/.exec(floor)![0];
  assert.match(view, /fl-reveal/);
  assert.doesNotMatch(view, /localStorage|sessionStorage|indexedDB|caches\./, 'the name is never put in browser storage');
  assert.doesNotMatch(floor, /window\.[A-Za-z_$.]*[Rr]eveal\w* *=/, 'and never on a global another script could read');
  assert.match(view, /visibilitychange/, 'a screen that is left clears the name');
});

test('the floor queue offers "Assign mixer" to a supervisor, by person, not by typing an id', () => {
  assert.match(floor, /\/mix\/assignment'/);
  assert.match(floor, /\/mix\/assign', \{ method: 'POST', body: \{ userId: /);
  assert.match(floor, /Assign mixer/);
  const queue = /async function viewQueue\([\s\S]*?\n  \}\n/.exec(floor)![0];
  assert.match(queue, /data-assign=/);
  assert.match(floor, /t: 'select'/, 'the mixer is chosen from the people who may mix');
});

/* STAGE-2-RP (STK-44): the Packing station asks why a weight was typed and offers "Scale not reading"
 * as the answer (ws-floor-ops.js passes it as the field's value). The form sheet drew a text INPUT's
 * value and dropped a TEXTAREA's, so the question opened empty, "Ask for a sign-off" answered "Why
 * typed is needed", and the finished-goods walk stopped there (as a packer would have, puzzled). */
test('the form sheet shows the value a textarea field was given, as it does for an input', () => {
  const shell = read('web/shell.js');
  const textarea = /f\.t === 'textarea' \? '<textarea data-ask="[^\n]*<\/textarea>'/.exec(shell);
  assert.ok(textarea, 'the textarea branch of askForm');
  assert.match(textarea![0], /f\.value != null \? escHtml\(f\.value\) : ''/, 'its value is drawn, escaped');
  assert.match(read('web/ws-floor-ops.js'), /t: 'textarea', req: true, value: 'Scale not reading'/, 'the one caller that gives a textarea a value');
});
