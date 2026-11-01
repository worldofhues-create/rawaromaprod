/* The address book of the browser suite's stack. One place, so a spec and the stand-up cannot
 * disagree. BS_* overrides exist for CI, which gets its Postgres from a service container. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const RUN = join(HERE, '..', '.run');

const n = (name, dflt) => Number(process.env[name] || dflt);
export const PORTS = {
  pg: n('BS_PG_PORT', 5544),
  api: n('BS_API_PORT', 4310),
  vaultApi: n('BS_VAULT_API_PORT', 4311),
  factory: n('BS_FACTORY_PORT', 3310),
  platform: n('BS_PLATFORM_PORT', 3311),
  vault: n('BS_VAULT_PORT', 3312),
  // Nothing listens here. ALEMBIC is not in this stack, so outbound bridge events really fail and park,
  // which is what the monitor's replay and discard exist for.
  deadPeer: n('BS_DEAD_PEER_PORT', 4319),
};
export const DB_HOST = process.env.BS_PG_HOST || '127.0.0.1';
export const DB_USER = process.env.BS_PG_USER || process.env.USER || 'postgres';
export const DB_PASS = process.env.BS_PG_PASSWORD || '';
const cred = DB_PASS ? `${DB_USER}:${encodeURIComponent(DB_PASS)}` : DB_USER;
export const dbUrl = (name) => `postgres://${cred}@${DB_HOST}:${PORTS.pg}/${name}`;
export const MAIN_DB = 'rawprod_cov';
export const VAULT_DB = 'rawprod_cov_vault';
export const URLS = {
  factory: `http://127.0.0.1:${PORTS.factory}`,
  platform: `http://127.0.0.1:${PORTS.platform}`,
  vault: `http://127.0.0.1:${PORTS.vault}`,
};
