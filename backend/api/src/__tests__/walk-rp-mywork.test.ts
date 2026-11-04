/**
 * WALK-RP-1: the dashboard's "My work" strip (web/shell.js; no browser). The dashboard read
 * /v1/alerts inside `try { ... } catch (e) {}` and passed whatever came back to myWorkPanel, so a
 * refused or unreachable alert feed rendered "Nothing needs action." -- an overdue QC or stock queue
 * read as cleared on the home screen, while the header bell beside it said the feed was down.
 * Comments are stripped before any source match, so a comment cannot satisfy a test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
const js = strip(readFileSync(join(root, 'web/shell.js'), 'utf8'));

function panel() {
  const s = js.indexOf('  function myWorkPanel(');
  const e = js.indexOf('\n  }\n', s) + 4;
  const ctx: Record<string, unknown> = { alertNavKey: () => null, escHtml: (x: string) => String(x),
    gCard: (o: { meta: string; body: string }) => o.meta + '|' + o.body };
  vm.createContext(ctx);
  vm.runInContext(js.slice(s, e) + '\nthis.f = myWorkPanel;', ctx);
  return ctx.f as (ad: unknown) => string;
}

test('a failed alert feed is said on My work, never "Nothing needs action."', () => {
  const html = panel()({ failed: 'The alert feed did not answer.' });
  assert.doesNotMatch(html, /Nothing needs action/);
  assert.match(html, /did not load/);
});

test('an empty, answered feed still says nothing needs action', () => {
  assert.match(panel()({ alerts: [], total: 0 }), /Nothing needs action/);
});

test('the dashboard no longer swallows the alert read', () => {
  const dash = js.slice(js.indexOf("tunnel('/v1/alerts'); ad ="), js.indexOf('var html = myWorkPanel(ad)'));
  assert.doesNotMatch(dash, /catch \(e\) \{\s*\}/);
});
