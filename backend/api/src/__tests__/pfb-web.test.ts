/**
 * PROD-B-9 — the P2 floor screens ship: ws-floorb.js is loaded, precached, registers its five views,
 * puts them on the rails of the roles that do the work, sends weights as integer mg, and never
 * prints a hazard it does not hold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const web = (f: string) => readFileSync(fileURLToPath(new URL('../../../../web/' + f, import.meta.url)), 'utf8');
const VIEWS = ['__recvaudit__', '__payrelease__', '__qccheckpoints__', '__qcgate__', '__lotrecall__'];

test('index.html loads ws-floorb.js after ws-produce.js, and weight.js before it', () => {
  const h = web('index.html');
  assert.ok(h.indexOf('/ws-produce.js') < h.indexOf('/ws-floorb.js'));
  assert.ok(h.indexOf('/weight.js') > -1 && h.indexOf('/weight.js') < h.indexOf('/ws-floorb.js'));
});

test('the service worker precaches it under a bumped cache name', () => {
  const s = web('sw.js');
  assert.match(s, /'\/ws-floorb\.js'/);
  assert.match(s, /'\/weight\.js'/);
  assert.match(s, /const CACHE = 'ra-shell-v122'/);
});

test('the five views register, have a readable address and a help line', () => {
  const js = web('ws-floorb.js'), routes = web('routes.js'), guide = web('screen-guide.js');
  for (const v of VIEWS) {
    assert.ok(js.includes(v + ':'), v);
    assert.ok(routes.includes(v), 'route ' + v);
    assert.ok(guide.includes(v), 'help ' + v);
  }
});

test('weights go to the server as mg; the label hazard comes from the server only', () => {
  const js = web('ws-floorb.js');
  assert.match(js, /receivedBase: rec/);
  assert.match(js, /adjustmentMg: m/);
  assert.ok(!/UN ?\d{4}|Not hazardous|IFRA certified/i.test(js));
  assert.match(js, /esc\(p\.hazard\)/);
});
