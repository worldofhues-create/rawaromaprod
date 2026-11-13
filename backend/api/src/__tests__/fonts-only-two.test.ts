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
 * label-render.js is checked by its own test below: its HTML is Manrope with codes in JetBrains
 * Mono, and its PDF embeds Manrope (FONT-RP-5, pfc-label-render.test.ts). Deliberately kept: the
 * printer languages (TSPL/ZPL/EPL/ESC-POS) print in the printer's resident fonts, which no
 * command can make Manrope.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ALLOWED = new Set(['manrope', 'jetbrains mono', 'rozha one', 'noto nastaliq urdu']); // BRAND-9: the brand handoff's four
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
  assert.match(html, /e\.mono(?: \|\| RAC_CODE_RE\.test\(e\.s\))? \? ';font-family:\\'JetBrains Mono\\'/ /* SHELL-FLUKE-0: the rac-codes merge adds the RAC-code test */);
  assert.doesNotMatch(src, /Hue Cycle|huecycle/i, 'labels carry no Hue Cycle footer');
  assert.doesNotMatch(src, /\/BaseFont \/(Helvetica|Times|Courier)|Subtype \/Type1/, 'the label PDF names no built-in font');
});

test('each console root declares both faces from its own origin, and ships no other font file', () => {
  for (const dir of ['web/ui-contract/fonts', 'web-platform/fonts', 'web-vault/fonts']) {
    const css = readFileSync(join(ROOT, dir, 'type.css'), 'utf8');
    for (const [fam, file] of [['Manrope', 'manrope-latin'], ['Manrope', 'manrope-latin-ext'], ['JetBrains Mono', 'jetbrains-mono-latin'],
      ['Rozha One', 'rozha-one-latin'], ['Rozha One', 'rozha-one-devanagari'], ['Noto Nastaliq Urdu', 'noto-nastaliq-urdu-latin'], ['Noto Nastaliq Urdu', 'noto-nastaliq-urdu-arabic']])
      assert.match(css, new RegExp(`font-family:'${fam}';[^}]*src:url\\(/(ui-contract/)?fonts/${file}\\.woff2\\)`), `${dir}: ${fam} ${file}`);
    const fonts = readdirSync(join(ROOT, dir)).filter((f) => /\.(woff2?|ttf|otf)$/.test(f)).sort();
    assert.deepEqual(fonts, ['jetbrains-mono-latin.woff2', 'manrope-latin-ext.woff2', 'manrope-latin.woff2', 'noto-nastaliq-urdu-arabic.woff2',
      'noto-nastaliq-urdu-latin.woff2', 'rozha-one-devanagari.woff2', 'rozha-one-latin.woff2'], dir);
    assert.doesNotMatch(readFileSync(join(ROOT, dir.split('/')[0]!, dir.startsWith('web/') ? 'index.html' : 'index.html'), 'utf8'), /rel="preload"[^>]*(rozha|noto)/, 'Rozha / Noto never preloaded');
    for (const lic of ['OFL-manrope.txt', 'OFL-jetbrains-mono.txt', 'OFL-rozha-one.txt', 'OFL-noto-nastaliq-urdu.txt']) assert.ok(existsSync(join(ROOT, dir, lic)), `${dir}/${lic}`);
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
    ".x{font-family:'Tiro Devanagari Hindi',serif}", // BRAND-9: a fifth family
  ]) assert.ok(offFaces(planted).length > 0, planted);
  assert.deepEqual(offFaces(".x{font-family:'Rozha One',serif}.u{font-family:'Noto Nastaliq Urdu',serif}"), []);
  assert.deepEqual(offFaces(".x{font-family:'Manrope', system-ui, sans-serif}.c{font:600 11px 'JetBrains Mono',ui-monospace,monospace}"), []);
});
