/**
 * WALK2-RP-5: the paired TV's board (web/pair.js). "updated" printed the UTC clock out of the ISO string
 * (5h30 behind on an Indian floor), stages read PICK/VERIFY/MIX where the console says Pick/Verify/Mix,
 * a failed read left the board silently stale or blank, and a board without a QC backlog threw.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web/pair.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
test('time is local, not sliced out of the UTC string', () => { assert.doesNotMatch(js, /String\(b\.at\)\.slice/); assert.match(js, /toLocaleTimeString\('en-IN'/); });
test('stages read as words', () => assert.match(js, /STAGE\[j\.stage\] \|\| j\.stage/));
test('a failed read is said on the TV', () => assert.match(js, /did not update/));
test('no unguarded QC backlog', () => assert.doesNotMatch(js, /b\.qcBacklog\.qc2Ready/));
