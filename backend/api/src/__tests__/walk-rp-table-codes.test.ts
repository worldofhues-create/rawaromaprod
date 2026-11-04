/**
 * WALK-RP-5: rac-console.css (vendored, hash-pinned) sets `.card,.gcard{overflow-wrap:anywhere}`, so a
 * table cell's min-content width is one letter. In a table that already scrolls sideways that bought
 * nothing and broke every batch, order and lot code mid-word on a phone ("RAC-DMW26O / CPE" on
 * Produce next, Put-away and the dashboard at 375 px), so a code read off the screen did not match the
 * label on the drum. The Factory's own stylesheet (uxStyle in web/shell.js) puts cells inside a
 * horizontal scroller back to normal wrapping. Comments are stripped before matching.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
const js = strip(readFileSync(join(root, 'web/shell.js'), 'utf8'));

test('cells inside a scrolling table keep codes whole', () => {
  const s = js.indexOf('function uxStyle(');
  const css = js.slice(s, js.indexOf('document.head.appendChild(c)', s));
  for (const scroller of ['.tscroll', '[style*="overflow-x:auto"]']) {
    const re = new RegExp(scroller.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' (td|th)[^{]*\\{[^}]*overflow-wrap:normal');
    assert.match(css, re, scroller);
  }
});
