/**
 * PB-03 — production boot-time guards, unit-tested WITHOUT booting the full Nest DI container
 * (no Postgres, no AWS KMS network calls):
 *
 *   1. `createFormulaClient` (formula.tokens.ts) refuses to fall back to DATABASE_URL when
 *      APP_ENV=prod and FORMULA_DATABASE_URL is unset — SB-01's "the vault's own connection
 *      must never share the main app role".
 *   2. `resolveKmsAdapter` (formula.module.ts) refuses any adapter other than AwsKmsAdapter
 *      when APP_ENV=prod, and refuses outright (not a silent downgrade) when
 *      FORMULA_KMS_KEY_ID is also missing.
 *
 * `postgres()` (postgres-js) never connects eagerly at construction — passing a URL just
 * builds a lazy client object — so these assertions run with no live Postgres/AWS reachable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { createFormulaClient } from '../formula.tokens.js';
import { resolveKmsAdapter } from '../formula.module.js';
import { AwsKmsAdapter } from '../crypto/aws-kms.adapter.js';
import { EnvKmsAdapter } from '../crypto/env-kms.adapter.js';
import { FileKmsAdapter } from '../crypto/file-kms.adapter.js';

function config(overrides: Record<string, string> = {}): ConfigService {
  return new ConfigService({
    DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_vk_test',
    JWT_SECRET: 'x'.repeat(32),
    ...overrides,
  });
}

/* ── createFormulaClient: FORMULA_DATABASE_URL mandatory in prod ───────────────────────────── */

test('createFormulaClient: throws in prod when FORMULA_DATABASE_URL is unset — never falls back to DATABASE_URL', () => {
  assert.throws(
    () => createFormulaClient(config({ APP_ENV: 'prod' })),
    /FORMULA_DATABASE_URL is required when APP_ENV=prod/,
  );
});

test('createFormulaClient: succeeds in prod when FORMULA_DATABASE_URL IS set (uses the dedicated ra_vault connection, not DATABASE_URL)', () => {
  const sql = createFormulaClient(
    config({ APP_ENV: 'prod', FORMULA_DATABASE_URL: 'postgres://ra_vault@localhost:5432/rawprod_vk_test' }),
  );
  assert.ok(sql);
  void sql.end({ timeout: 0 });
});

test('createFormulaClient: falls back to DATABASE_URL OUTSIDE prod (dev/test convenience) when FORMULA_DATABASE_URL is unset', () => {
  const sql = createFormulaClient(config({ APP_ENV: 'dev' }));
  assert.ok(sql);
  void sql.end({ timeout: 0 });
});

/* ── resolveKmsAdapter: prod accepts ONLY AwsKmsAdapter ─────────────────────────────────────── */

test('resolveKmsAdapter: throws in prod when FORMULA_KMS_KEY_ID is unset — refuses to boot, does not downgrade to env/file KEK', () => {
  assert.throws(
    () => resolveKmsAdapter(config({ APP_ENV: 'prod', FORMULA_KEK: 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=' })),
    /FORMULA_KMS_KEY_ID is required when APP_ENV=prod/,
  );
});

test('resolveKmsAdapter: binds AwsKmsAdapter in prod when FORMULA_KMS_KEY_ID IS set, ignoring a stray FORMULA_KEK', () => {
  const kms = resolveKmsAdapter(
    config({
      APP_ENV: 'prod',
      FORMULA_KMS_KEY_ID: 'arn:aws:kms:ap-south-1:123456789012:key/test-cmk',
      // A leftover dev secret must NOT cause a downgrade — prod only ever constructs AwsKmsAdapter.
      FORMULA_KEK: 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=',
    }),
  );
  assert.ok(kms instanceof AwsKmsAdapter);
});

test('resolveKmsAdapter: binds EnvKmsAdapter outside prod when FORMULA_KEK_FILE is unset', () => {
  const kms = resolveKmsAdapter(config({ APP_ENV: 'dev', FORMULA_KEK: 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=' }));
  assert.ok(kms instanceof EnvKmsAdapter);
});

test('resolveKmsAdapter: binds FileKmsAdapter outside prod when FORMULA_KEK_FILE IS set', () => {
  const kms = resolveKmsAdapter(config({ APP_ENV: 'dev', FORMULA_KEK_FILE: '/tmp/does-not-need-to-exist-for-selection.kek' }));
  assert.ok(kms instanceof FileKmsAdapter);
});
