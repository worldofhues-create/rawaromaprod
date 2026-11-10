/**
 * FONT-RP-2: Manrope and JetBrains Mono, and no other typeface (owner decision 2026-11-10:
 * "remove any other font in the system").
 *
 * Every file that can name a typeface in the three consoles and the shared packages is scanned; any
 * family that is not one of the two (or a CSS generic) fails, as does a font file other than the two
 * variable woff2s, and a console root whose fonts/type.css stops declaring both from this origin.
 * The planted cases at the bottom prove the scanner fires -- a scan that matches nothing would
 * otherwise pass exactly like a clean tree.
 *
 * Deliberately NOT scanned: label-render.js's PDF and printer-command paths (Type1 Helvetica in
 * the label PDF; printer-resident fonts in TSPL/ZPL/ESC-POS), which cannot carry a web font --
 * see the lane report. Its screen/print HTML path IS scanned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ALLOWED = new Set(['manrope', 'jetbrains mono']);
const GENERIC = new Set(['sans-serif', 'serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace',
  'cursive', 'fantasy', 'inherit', 'initial', 'unset', 'emoji', 'math']);
const KNOWN = ['Outfit', 'Cabinet Grotesk', 'Geist', 'Inter', 'Roboto', 'Helvetica Neue', 'Helvetica', 'Arial', 'SF Pro',
  '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Menlo', 'Monaco', 'Consolas', 'Courier New', 'Georgia',
  'Times New Roman', 'Urbanist', 'Archivo', 'Instrument Sans', 'DM Mono', 'SFMono-Regular', 'Lufga'];

export function offFaces(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const out: string[] = [];
  for (const m of code.matchAll(/(?:font-family|fontFamily)\s*[:=]\s*(\\?['"`]?)([^;}\n]+?)\1\s*(?:[;},\n]|$)/gi)) {
    for (const f of m[2]!.split(',')) {
      const name = f.trim().replace(/^\\?['"`]|\\?['"`]$/g, '').trim();
      if (!name || /^var\(|[${}[\]()?+]/.test(name)) continue;
      if (!ALLOWED.has(name.toLowerCase()) && !GENERIC.has(name.toLowerCase())) out.push(name);
    }
  }
  for (const fam of KNOWN) {
    const re = new RegExp(`(['"\`\\s,(])${fam.replace(/-/g, '\\-')}(?=['"\`\\s,;)])`, 'g');
    for (const m of code.matchAll(re)) {
      const ls = code.lastIndexOf('\n', m.index) + 1, le = code.indexOf('\n', m.index);
      if (/font|family/i.test(code.slice(ls, le < 0 ? undefined : le))) out.push(fam);
    }
  }
  return out;
}

const ROOTS = ['web', 'web-platform', 'web-vault', 'packages/tokens/src', 'web/ui/src'];
const SKIP = /(^|\/)(node_modules|dist|build|__tests__)(\/|$)|label-render\.js$/;
function files(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (SKIP.test(r)) continue;
      if (e.isDirectory()) walk(r);
      else if (/\.(css|js|mjs|ts|tsx|html)$/.test(e.name)) out.push(r);
    }
  };
  for (const r of ROOTS) if (existsSync(join(ROOT, r))) walk(r);
  return [...new Set(out)];
}

test('no file in the consoles names a typeface other than Manrope or JetBrains Mono', () => {
  const fs = files();
  assert.ok(fs.length >= 60, `only ${fs.length} files scanned`);
  const bad = fs.flatMap((f) => offFaces(readFileSync(join(ROOT, f), 'utf8')).map((n) => `${f}: ${n}`));
  assert.deepEqual(bad, []);
});

test('the label screen/print HTML is Manrope, with the code in JetBrains Mono', () => {
  const src = readFileSync(join(ROOT, 'web/label-render.js'), 'utf8');
  const html = src.slice(src.indexOf('function html('), src.indexOf('function codesHtml('));
  assert.deepEqual(offFaces(html), []);
  assert.match(html, /font-family:Manrope,system-ui,sans-serif/);
  assert.match(html, /e\.mono \? ';font-family:\\'JetBrains Mono\\'/);
  assert.doesNotMatch(src, /Hue Cycle|huecycle/i, 'labels carry no Hue Cycle footer');
});

test('each console root declares both faces from its own origin, and ships no other font file', () => {
  for (const dir of ['web/ui-contract/fonts', 'web-platform/fonts', 'web-vault/fonts']) {
    const css = readFileSync(join(ROOT, dir, 'type.css'), 'utf8');
    assert.match(css, /font-family: 'Manrope';[^}]*src: url\(\/(ui-contract\/)?fonts\/manrope-variable\.woff2\)/, dir);
    assert.match(css, /font-family: 'JetBrains Mono';[^}]*src: url\(\/(ui-contract\/)?fonts\/jetbrains-mono-variable\.woff2\)/, dir);
    const fonts = readdirSync(join(ROOT, dir)).filter((f) => /\.(woff2?|ttf|otf)$/.test(f)).sort();
    assert.deepEqual(fonts, ['jetbrains-mono-variable.woff2', 'manrope-variable.woff2'], dir);
    for (const lic of ['OFL-manrope.txt', 'OFL-jetbrains-mono.txt']) assert.ok(existsSync(join(ROOT, dir, lic)), `${dir}/${lic}`);
  }
  assert.ok(!existsSync(join(ROOT, 'web/fonts')) || readdirSync(join(ROOT, 'web/fonts')).length === 0, 'web/fonts holds old files');
});

test('the scanner fires on each planted shape', () => {
  for (const planted of [
    ".x{font-family:'Outfit',sans-serif}",
    ".x{font:500 12px/1 'Helvetica Neue',sans-serif}",
    "body{font-family:Arial,sans-serif}",
    "<b style=\"font-family:'Comic Neue', system-ui\">",
    "el.style.fontFamily = 'Georgia, serif'",
    ".x{font-family:'Manrope','Inter',sans-serif}",
  ]) assert.ok(offFaces(planted).length > 0, planted);
  assert.deepEqual(offFaces(".x{font-family:'Manrope', system-ui, sans-serif}.c{font:600 11px 'JetBrains Mono',ui-monospace,monospace}"), []);
});
