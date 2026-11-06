/**
 * WALK2-RP-3: the floor board's TV mode (web/ws-floor-ops.js enterBoardTv). A failed read left the TV
 * blank, or the last board with nothing saying it was stale; and it read the whole floor on a station's
 * paired display, where the in-console board asks for that station.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web/ws-floor-ops.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const tv = js.slice(js.indexOf('function enterBoardTv('), js.indexOf('window.RA.registerViews'));

test('TV mode says when the board did not load instead of going blank', () => {
  assert.match(tv, /did not update/);
  assert.match(tv, /if \(b\) FV\.tvHost\.innerHTML = boardHtml\(b, true\);\s*else/);
});
test('TV mode asks for the paired station, as the in-console board does', () => {
  assert.match(tv, /\?station=' \+ encodeURIComponent\(k\.station\)/);
});
test('a board without a QC backlog block does not throw', () => {
  assert.doesNotMatch(js, /b\.qcBacklog\.qc2Ready\.length/);
});
