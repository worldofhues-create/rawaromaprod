/**
 * WALK-RP-15 [AUTH, UI only]: Assign role (web/ws-platform.js) filled its Role list from one page and
 * `.catch(function () {})`, so a refused or failed /v1/roles read left an empty list and the owner was
 * told only "Pick a role." when there was nothing to pick. It now reads through fkRows and says a
 * failed list on the form (fkFail), as every other picker does. No grant or check changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web/ws-platform.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

test('the role list does not swallow a failure', () => {
  assert.doesNotMatch(js, /\.catch\(function \(\) \{\}\)/);
  assert.match(js, /fkRows\('\/v1\/roles'\)\.then\(function \(fr\) \{\s*fkFail\(\$\('ra-role'\), fr\.error\)/);
});
