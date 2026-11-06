/** WALK2-RP-16: fields (.fld) were 31px tall on a touch screen in all three consoles; 44px floor. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
for (const f of ['web/ui-contract/shell.css', 'web-platform/platform.css', 'web-vault/vault.css']) {
  test(`${f}: fields keep the touch floor on a coarse pointer`, () => {
    const css = readFileSync(join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(css, /@media \(pointer:coarse\)\{ \.fld:not\(\[type=checkbox\]\):not\(\[type=radio\]\),select\.fld\{min-height:var\(--ch-touch-floor-coarse-pointer\)\} \}/);
  });
}
