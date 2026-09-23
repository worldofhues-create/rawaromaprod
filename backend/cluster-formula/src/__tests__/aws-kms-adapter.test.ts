/**
 * PB-03 — AwsKmsAdapter against a MOCKED `@aws-sdk/client-kms` `KMSClient` (no network, no
 * real AWS account required). `FakeKmsClient` below is a tiny in-memory simulator of the
 * THREE behaviors that matter for this adapter's correctness:
 *
 *   1. GenerateDataKey/Encrypt store {plaintext, EncryptionContext} keyed by an opaque
 *      "ciphertext" id; Decrypt looks it up and returns the plaintext ONLY if the caller's
 *      EncryptionContext matches byte-for-byte what was stored — the same authenticated-
 *      encryption-context contract real AWS KMS enforces (a context mismatch is a refused
 *      Decrypt, not "wrong answer" plaintext).
 *   2. A configurable hard failure mode (`shouldFail`) — simulates AccessDenied/throttling/
 *      any SDK-level rejection.
 *   3. A configurable hang mode (`hangUntilAbort`) — never resolves until the caller's
 *      `abortSignal` fires, to exercise AwsKmsAdapter's own `FORMULA_KMS_TIMEOUT_MS` bound.
 *
 * No Postgres needed — these are pure unit tests of the adapter, not the vault flow (that's
 * covered end-to-end with EnvKmsAdapter in vault-lifecycle.test.ts / vault-sod.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { KMSClient } from '@aws-sdk/client-kms';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { AwsKmsAdapter } from '../crypto/aws-kms.adapter.js';
import type { VaultKeyContext } from '../crypto/kms.port.js';

interface StoredKey {
  plaintext: Buffer;
  context: Record<string, string>;
}

class FakeKmsClient {
  private readonly store = new Map<string, StoredKey>();
  private seq = 0;
  readonly sentCommandNames: string[] = [];
  shouldFail = false;
  hangUntilAbort = false;

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    this.sentCommandNames.push(command.constructor.name);

    if (this.hangUntilAbort) {
      return new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    if (this.shouldFail) {
      throw new Error('AccessDeniedException: simulated KMS failure');
    }

    const name = command.constructor.name;
    const context = (command.input.EncryptionContext as Record<string, string> | undefined) ?? {};

    if (name === 'GenerateDataKeyCommand') {
      const plaintext = randomBytes(32);
      const id = this.put({ plaintext, context });
      return { Plaintext: plaintext, CiphertextBlob: Buffer.from(id, 'utf8') };
    }
    if (name === 'EncryptCommand') {
      const plaintext = Buffer.from(command.input.Plaintext as Uint8Array);
      const id = this.put({ plaintext, context });
      return { CiphertextBlob: Buffer.from(id, 'utf8') };
    }
    if (name === 'DecryptCommand') {
      const id = Buffer.from(command.input.CiphertextBlob as Uint8Array).toString('utf8');
      const entry = this.store.get(id);
      if (!entry) {
        throw new Error('InvalidCiphertextException: unknown ciphertext');
      }
      if (JSON.stringify(entry.context) !== JSON.stringify(context)) {
        // Real KMS behavior: a mismatched EncryptionContext is a REFUSED decrypt, never a
        // "here's some plaintext anyway" response.
        throw new Error('InvalidCiphertextException: encryption context does not match');
      }
      return { Plaintext: entry.plaintext };
    }
    throw new Error(`FakeKmsClient: unhandled command ${name}`);
  }

  private put(entry: StoredKey): string {
    const id = `ct-${this.seq++}`;
    this.store.set(id, entry);
    return id;
  }
}

function config(overrides: Record<string, string> = {}): ConfigService {
  return new ConfigService({
    DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_vk_test',
    JWT_SECRET: 'x'.repeat(32),
    FORMULA_KMS_KEY_ID: 'arn:aws:kms:ap-south-1:123456789012:key/test-cmk',
    FORMULA_KMS_TIMEOUT_MS: '4000',
    ...overrides,
  });
}

const ctxA: VaultKeyContext = { formulaId: 'formula-a', vaultId: 'vault-a' };
const ctxB: VaultKeyContext = { formulaId: 'formula-b', vaultId: 'vault-b' };

/* ── construction ────────────────────────────────────────────────────────────────────────── */

test('AwsKmsAdapter: constructor throws clearly when FORMULA_KMS_KEY_ID is not configured', () => {
  assert.throws(
    () => new AwsKmsAdapter(config({ FORMULA_KMS_KEY_ID: '' }), new FakeKmsClient() as unknown as KMSClient),
    /FORMULA_KMS_KEY_ID/,
  );
});

test('AwsKmsAdapter: keyRef names the configured CMK', () => {
  const adapter = new AwsKmsAdapter(config(), new FakeKmsClient() as unknown as KMSClient);
  assert.equal(adapter.keyRef, 'aws-kms:arn:aws:kms:ap-south-1:123456789012:key/test-cmk');
});

/* ── envelope encryption round trip ─────────────────────────────────────────────────────── */

test('AwsKmsAdapter: generateDek → unwrapDek round-trips with the SAME context', async () => {
  const client = new FakeKmsClient();
  const adapter = new AwsKmsAdapter(config(), client as unknown as KMSClient);

  const { plaintext, wrapped } = await adapter.generateDek(ctxA);
  assert.equal(plaintext.length, 32);
  assert.ok(wrapped.ciphertext.length > 0);
  // AWS KMS ciphertext is opaque — iv/tag are a local-AEAD-only concept.
  assert.equal(wrapped.iv, '');
  assert.equal(wrapped.tag, '');

  const unwrapped = await adapter.unwrapDek(wrapped, ctxA);
  assert.ok(unwrapped.equals(plaintext));
  assert.deepEqual(client.sentCommandNames, ['GenerateDataKeyCommand', 'DecryptCommand']);
});

test('AwsKmsAdapter: unwrapDek REFUSES (throws, no plaintext) when the context does not match what generateDek used — fail closed', async () => {
  const client = new FakeKmsClient();
  const adapter = new AwsKmsAdapter(config(), client as unknown as KMSClient);

  const { wrapped } = await adapter.generateDek(ctxA);
  await assert.rejects(() => adapter.unwrapDek(wrapped, ctxB), /fail-closed, no plaintext released/);
});

test('AwsKmsAdapter: wrapExistingDek preserves the EXACT plaintext bytes (the rewrap-tool contract) — unwrap returns byte-identical input, not a new key', async () => {
  const client = new FakeKmsClient();
  const adapter = new AwsKmsAdapter(config(), client as unknown as KMSClient);

  const existingDek = randomBytes(32);
  const wrapped = await adapter.wrapExistingDek(existingDek, ctxA);
  const recovered = await adapter.unwrapDek(wrapped, ctxA);
  assert.ok(recovered.equals(existingDek));
  assert.deepEqual(client.sentCommandNames, ['EncryptCommand', 'DecryptCommand']);
});

/* ── fail closed: SDK error / timeout ───────────────────────────────────────────────────── */

test('AwsKmsAdapter: a KMS SDK error during unwrapDek propagates as a clear failure — no fallback, no partial data', async () => {
  const client = new FakeKmsClient();
  const adapter = new AwsKmsAdapter(config(), client as unknown as KMSClient);
  const { wrapped } = await adapter.generateDek(ctxA);

  client.shouldFail = true;
  await assert.rejects(() => adapter.unwrapDek(wrapped, ctxA), /fail-closed, no plaintext released/);
});

test('AwsKmsAdapter: a KMS call that never resolves is bounded by FORMULA_KMS_TIMEOUT_MS and rejects — fail closed, not an indefinite hang', async () => {
  const client = new FakeKmsClient();
  client.hangUntilAbort = true;
  const adapter = new AwsKmsAdapter(config({ FORMULA_KMS_TIMEOUT_MS: '50' }), client as unknown as KMSClient);

  const started = Date.now();
  await assert.rejects(() => adapter.generateDek(ctxA), /fail-closed, no plaintext released/);
  const elapsed = Date.now() - started;
  // Bounded, not indefinite — generous upper bound for CI jitter, still far below "hangs forever".
  assert.ok(elapsed < 2000, `expected the timeout to bound the call; took ${elapsed}ms`);
});

/* ── audit HMAC key: stable across restarts, never logs plaintext ──────────────────────── */

test('AwsKmsAdapter: macAudit mints an audit HMAC key on first use and logs only the WRAPPED (ciphertext) form, never plaintext', async () => {
  const client = new FakeKmsClient();
  const adapter = new AwsKmsAdapter(config(), client as unknown as KMSClient);

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  let mac: string;
  try {
    mac = await adapter.macAudit('some audit row payload');
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(mac.length, 64); // hex sha256
  assert.equal(warnings.length, 1);
  const warning = warnings[0] ?? '';
  assert.match(warning, /FORMULA_AUDIT_HMAC_WRAPPED=/);
  assert.doesNotMatch(warning, /plaintext/i);
  // The logged value must be the base64 of the FakeKmsClient CIPHERTEXT id (e.g. "ct-0"), never
  // the mac itself or anything 32-bytes-random-shaped (a real plaintext key would base64-encode
  // to 44 chars with `==`/`=` padding typical of 32 raw bytes) — the fake's ciphertext ids are
  // short ASCII, so their base64 form is short too; assert it does NOT equal the mac we got back
  // (the one thing here that IS derived from, but is not itself, the plaintext key).
  const wrappedValue = (warning.split('FORMULA_AUDIT_HMAC_WRAPPED=')[1] ?? '').trim();
  assert.ok(wrappedValue.length > 0);
  assert.notEqual(wrappedValue, mac);
  assert.equal(Buffer.from(wrappedValue, 'base64').toString('utf8').startsWith('ct-'), true);
});

test('AwsKmsAdapter: macAudit is STABLE across a simulated restart — a second adapter given the persisted FORMULA_AUDIT_HMAC_WRAPPED reproduces the SAME mac (so verifyAuditChain does not false-positive after a restart)', async () => {
  const client = new FakeKmsClient(); // shared "KMS" store across both adapter instances
  const adapterBeforeRestart = new AwsKmsAdapter(config(), client as unknown as KMSClient);

  let wrappedAuditKey = '';
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    const match = line.match(/FORMULA_AUDIT_HMAC_WRAPPED=(\S+)/);
    if (match?.[1]) wrappedAuditKey = match[1];
  };
  let macBefore: string;
  try {
    macBefore = await adapterBeforeRestart.macAudit('row-1');
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(wrappedAuditKey.length > 0, 'expected the boot warning to surface the wrapped audit key');

  // "Restart": a FRESH adapter instance, config now carries the persisted wrapped key, same
  // underlying KMS store (so Decrypt can recover it) — exactly the deploy runbook's flow.
  const adapterAfterRestart = new AwsKmsAdapter(
    config({ FORMULA_AUDIT_HMAC_WRAPPED: wrappedAuditKey }),
    client as unknown as KMSClient,
  );
  const macAfter = await adapterAfterRestart.macAudit('row-1');

  assert.equal(macAfter, macBefore, 'the audit HMAC key must survive a restart, or every pre-restart row falsely looks tampered');
});

test('AwsKmsAdapter: generateDek/unwrapDek/wrapExistingDek never call console.log/warn/error — no accidental plaintext logging on the normal DEK path', async () => {
  const client = new FakeKmsClient();
  const adapter = new AwsKmsAdapter(config(), client as unknown as KMSClient);

  const calls: string[] = [];
  const spies: [keyof Console, (...args: unknown[]) => void][] = (['log', 'warn', 'error'] as const).map((m) => [
    m,
    console[m],
  ]) as never;
  for (const m of ['log', 'warn', 'error'] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (console as any)[m] = (...args: unknown[]) => calls.push(`${m}: ${args.map(String).join(' ')}`);
  }
  try {
    const { plaintext, wrapped } = await adapter.generateDek(ctxA);
    await adapter.unwrapDek(wrapped, ctxA);
    await adapter.wrapExistingDek(plaintext, ctxB);
  } finally {
    for (const [m, fn] of spies) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (console as any)[m] = fn;
    }
  }
  assert.deepEqual(calls, []);
});
