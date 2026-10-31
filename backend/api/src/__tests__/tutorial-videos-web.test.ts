/**
 * Training videos card on the Factory Tutorials screen (web/tutorial.js; static checks, no browser):
 * the card renders above the lessons, links only through the configured ALEMBIC_CONSOLE_URL (never a
 * hardcoded address) into ALEMBIC's Tutorial -> Videos, opens in a new tab safely, and the offline
 * shell cache was bumped so installed consoles pick the new tutorial.js up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

test('Tutorials: Training videos card renders first and links via ALEMBIC_CONSOLE_URL only', () => {
  const js = read('web/tutorial.js');
  assert.match(js, /V\.innerHTML = tutorialFilmsCard\(\) \+/);
  assert.match(js, /<h2>Training videos<\/h2>/);
  assert.match(js, /new URL\(ALEMBIC_CONSOLE_URL, location\.href\)/);
  assert.match(js, /searchParams\.set\('screen', 'tutorial'\)/);
  assert.match(js, /target="_blank" rel="noopener"/);
  const card = js.slice(js.indexOf('var TUTORIAL_FILMS'), js.indexOf('function tutorialRenderLibrary'));
  assert.doesNotMatch(card, /https?:\/\//, 'no hardcoded address');
  for (const id of ['rawprod-catalogue-sync', 'rawprod-formula', 'rawprod-approvals-qc', 'rawprod-racks-labels',
    'rawprod-produce-pick', 'rawprod-platform-vault']) assert.ok(card.includes(`'${id}'`), id);
  assert.match(read('web/shell.js'), /var ALEMBIC_CONSOLE_URL = /);
});

test('Tutorials: shell cache bumped — tutorial.js is stale-while-revalidate, so only a new cache name evicts the old copy', () => {
  assert.match(read('web/sw.js'), /const CACHE = 'ra-shell-v102'/);
});
