/**
 * FLOOR-FIX-5 (JT-156) — DevicesService allows kind `scanner`; the base table's check (pfc-floor)
 * refused it. 2026-11-07-scan-scanner-kind.sql widens the check and its rollback narrows it again.
 * Both files are applied here, as written, inside a transaction that is rolled back, so the shared
 * test database is left as it was.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureSchema, testClient, closeTestClient } from '../../../test-support/db.js';
import { DEVICE_KINDS } from '../floor-ops/devices.service.js';

const MIG = join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/migrations');
const up = readFileSync(join(MIG, '2026-11-07-scan-scanner-kind.sql'), 'utf8');
const down = readFileSync(join(MIG, 'rollback/2026-11-07-scan-scanner-kind.down.sql'), 'utf8');
const base = readFileSync(join(MIG, '2026-11-05-pfc-floor.sql'), 'utf8');

before(ensureSchema);
after(closeTestClient);

class Rollback extends Error {}

test('every kind the code allows is allowed by the migrated table; rollback and re-apply both run clean', async () => {
  assert.match(base, /check \(kind in \('label_printer', 'display', 'kiosk', 'scale'\)\)/, 'the base migration is the one that refused scanner');
  const sql = testClient();
  const insert = (tx: typeof sql, kind: string) => tx`insert into platform.device_master (device_id, kind, station, name, status, config)
      values (${randomUUID()}::uuid, ${kind}, 'JT-156', 'probe', 'active', '{}'::jsonb)`;
  await assert.rejects(sql.begin(async (tx) => {
    await tx`create table if not exists public.schema_migrations (id text primary key, applied_at timestamptz default now())`;
    await tx.unsafe(down);
    await tx`savepoint s`;
    await assert.rejects(() => insert(tx as never, 'scanner'), /device_master_kind_check/);
    await tx`rollback to savepoint s`;
    await tx.unsafe(up);
    for (const k of DEVICE_KINDS) await insert(tx as never, k);
    await tx`savepoint s2`;
    await assert.rejects(() => insert(tx as never, 'webcam'), /device_master_kind_check/);
    await tx`rollback to savepoint s2`;
    await tx.unsafe(up); // idempotent: a second apply is clean
    throw new Rollback();
  }), Rollback);
});
