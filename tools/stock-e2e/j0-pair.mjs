/* STOCK-E2E-2, RawProd step J0: pair the bridge with Alembic as production's is paired: the owner enters the
 * shared secret and Alembic's inbound address (both from <runDir>/bridge.json, written by Alembic's set-up
 * step) on PUT /v1/bridge/config. Usage: node j0-pair.mjs <runDir>. Prints statuses only. */
import { readFileSync } from 'node:fs';
import { client } from './lib.mjs';
const [run] = process.argv.slice(2);
const C = client({ keysFile: `${run}/keys.json`, run });
const pair = JSON.parse(readFileSync(`${run}/bridge.json`, 'utf8'));
const cfg = await C.rp('owner', 'PUT', '/v1/bridge/config', { enabled: true, hmacSecret: pair.secret, webhookUrl: pair.webhookUrl });
console.log('bridgeConfig', JSON.stringify({ status: cfg.status, enabled: cfg.body?.enabled ?? null, hasSecret: cfg.body?.hasSecret ?? null, err: cfg.error?.message?.slice(0, 200) ?? null }));
const me = await C.rp('owner', 'GET', '/v1/me');
console.log('ownerSignedInThroughAlembic', JSON.stringify({ status: me.status, roles: me.body?.roles ?? me.body?.user?.roles ?? null }));
