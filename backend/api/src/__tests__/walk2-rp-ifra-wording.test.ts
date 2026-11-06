/** WALK2-RP-14: the New document form offered "IFRA Certificate". IFRA does not certify; a house declares
 *  conformity, so the only IFRA type offered is the conformity certificate. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web/shell.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
test('no "IFRA Certificate" among the document types a person can choose', () => {
  const form = js.slice(js.indexOf("'/v1/document-registry': { title: 'New document'"), js.indexOf("'/v1/document-registry': { title: 'New document'") + 600);
  assert.doesNotMatch(form, /'IFRA Certificate'/);
  assert.match(form, /'IFRA Conformity Certificate'/);
});
