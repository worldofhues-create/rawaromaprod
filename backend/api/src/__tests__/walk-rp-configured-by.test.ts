/**
 * WALK-RP-9: Platform's Connectors table ("Last set up ... · 01a1a6da-56c0-...") and Pick-to-light
 * ("Last set up ... by 01a1a6da-58a5-...") named the person who set up a secret by their raw user id,
 * so a platform admin could not tell who changed a webhook secret or the controller. Both reads now
 * carry the person's email (or name) from iam.user_master beside the id, and the console shows it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PickLightService } from '../shelf/pick-light.service.js';
import { PlatformOpsService } from '../platform-ops/platform-ops.service.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ID = '01a1a6da-58a5-7d8b-8b0a-850d274e0e6a';

test('pick-to-light status names who set it up', async () => {
  const calls: string[] = [];
  const db = { execute: async (q: { queryChunks?: unknown[] }) => {
    const text = JSON.stringify(q); calls.push(text);
    if (text.includes('pick_light_config')) return [{ mode: 'simulator', controller_url: null, hmac_secret_sealed: null, configured_at: new Date(), configured_by: ID, configured_by_name: 'platform.admin@rawaroma.local' }];
    return [{ pending: 0, parked: 0, last_sent: null }];
  } };
  const s = new PickLightService(db as never); s.onModuleDestroy();
  const st = await s.status() as unknown as Record<string, unknown>;
  assert.equal(st.configuredByName, 'platform.admin@rawaroma.local');
  assert.match(calls.find((c) => c.includes('pick_light_config'))!, /iam\.user_master/);
});

test('connector providers name who set them up', async () => {
  const sql = Object.assign(async () => [{ user_id: ID, name: 'platform.admin@rawaroma.local' }], {});
  const bridgeDb = { select: () => ({ from: async () => [{ id: 'default', enabled: true, webhookUrl: 'x', hmacSecretSealed: 'y', configuredAt: new Date(), configuredBy: ID }] }) };
  const s = new PlatformOpsService(sql as never, bridgeDb as never, {} as never, {} as never);
  const [p] = await s.providers() as unknown as Array<Record<string, unknown>>;
  assert.equal(p!.configuredByName, 'platform.admin@rawaroma.local');
});

test('the Platform console prints the name, never the bare id', () => {
  const js = readFileSync(join(root, 'web-platform/platform.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  assert.doesNotMatch(js, /' · ' \+ p\.configuredBy\)/);
  assert.doesNotMatch(js, /' by ' \+ s\.configuredBy :/);
  assert.match(js, /p\.configuredByName/);
  assert.match(js, /s\.configuredByName/);
});
