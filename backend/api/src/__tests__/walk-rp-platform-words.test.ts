/**
 * WALK-RP-10: Platform's Sales system link table printed every message type as one run-on word
 * ("Salesordermanualcontinuityconfirmed", "Productionrequirementaccepted"): words() lowercased the
 * PascalCase event type without splitting it, so a platform admin could not read which messages were
 * stuck, and on a phone the run-on word broke mid-word. It now splits at case changes first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web-platform/platform.js'), 'utf8');
const line = js.split('\n').find((l) => l.trimStart().startsWith('function words('))!;
const ctx: Record<string, unknown> = {}; vm.createContext(ctx); vm.runInContext(line + '\nthis.f = words;', ctx);
const words = ctx.f as (s: string) => string;

test('PascalCase and dotted codes read as words', () => {
  assert.equal(words('SalesOrderManualContinuityConfirmed'), 'Sales order manual continuity confirmed');
  assert.equal(words('productionRequirement.accepted'), 'Production requirement accepted');
  assert.equal(words('IN_PROGRESS'), 'In progress');
  assert.equal(words(''), '');
});
