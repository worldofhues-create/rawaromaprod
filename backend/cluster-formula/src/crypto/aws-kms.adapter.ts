/**
 * AwsKmsAdapter — the PRODUCTION `KmsPort` (PB-03 / V4 §109.2). Real envelope encryption
 * against an AWS KMS customer-managed key (CMK): `GenerateDataKeyCommand` mints a per-formula
 * DEK (KMS returns both the plaintext, used once then discarded, and the wrapped/ciphertext
 * form, persisted); `DecryptCommand` unwraps it back on read. Every call carries an
 * `EncryptionContext` binding the ciphertext to this deployment's tenant + the owning
 * formula/vault row (see `VaultKeyContext` in kms.port.ts) — KMS refuses to decrypt under a
 * mismatched context, so a wrapped DEK copied onto a different formula's row (or exfiltrated
 * to a different AWS account/key) is inert.
 *
 * Fail CLOSED (§109.6 "Fail closed if KMS is unavailable" / F7): every SDK call is bounded by
 * `FORMULA_KMS_TIMEOUT_MS` (default 4000ms) via `AbortController`; a timeout or any SDK error
 * throws — there is no fallback adapter, no cached plaintext, no partial result. Callers
 * (VaultService, FormulasService) already propagate exceptions as a hard refusal; nothing
 * here ever returns synthesized/degraded data.
 *
 * Never logs plaintext or DEK bytes. The one thing this file ever logs is a KMS CIPHERTEXT
 * blob (opaque, safe — see `loadOrMintAuditKey`), never a plaintext key or formula content.
 *
 * Key policy (deploy runbook, item 5): the CMK's key policy must permit
 * Decrypt/GenerateDataKey/Encrypt ONLY to the Vault service's own IAM role — explicitly
 * excluding ALEMBIC web/API, Aria, Agent, Admin, Content, analytics, search, and generic
 * workers (§109.2).
 */
import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DecryptCommand, EncryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';

/** The AWS SDK v3 KMS client types `EncryptionContext` inline as `Record<string, string>` on
 * each command's input (no exported named type) — named here for readability at call sites. */
type EncryptionContextType = Record<string, string>;
import { ConfigService } from '@core/backend-kernel';
import type { KmsPort, VaultKeyContext, WrappedKey } from './kms.port.js';

/** Fixed, non-secret context for the ONE stable audit-chain HMAC key (see loadOrMintAuditKey). */
const AUDIT_KEY_PURPOSE = 'vault-audit-hmac';

@Injectable()
export class AwsKmsAdapter implements KmsPort {
  private readonly client: KMSClient;
  private readonly keyId: string;
  private readonly tenantId: string;
  private readonly timeoutMs: number;
  /** Lazily loaded/minted once per process, then held in memory only — never persisted,
   * never logged, never re-derived from anything written to Postgres. */
  private auditKeyPromise: Promise<Buffer> | undefined;

  /** Names the CMK that wrapped a DEK — persisted as FORMULA_VAULT.encryption_key_ref. */
  readonly keyRef: string;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    client?: KMSClient,
  ) {
    const keyId = config.get('FORMULA_KMS_KEY_ID');
    if (!keyId) {
      // Belt-and-braces: formula.module.ts already refuses to construct this adapter without
      // a key id in prod, but a caller constructing AwsKmsAdapter directly (e.g. the rewrap
      // script) gets the same fail-closed error, not a confusing later KMS 4xx.
      throw new Error('AwsKmsAdapter requires FORMULA_KMS_KEY_ID to be configured.');
    }
    this.keyId = keyId;
    this.tenantId = config.get('FORMULA_KMS_TENANT_ID') || 'rac';
    this.timeoutMs = config.get('FORMULA_KMS_TIMEOUT_MS') ?? 4000;
    this.keyRef = `aws-kms:${keyId}`;
    // Injectable for tests (a mocked KMSClient with a stubbed `.send`); production DI omits
    // it and gets a real client using the ambient AWS credential/region chain, optionally
    // pinned via FORMULA_KMS_REGION.
    this.client = client ?? new KMSClient({ region: config.get('FORMULA_KMS_REGION') || undefined });
  }

  private buildContext(context: VaultKeyContext): EncryptionContextType {
    return {
      tenant: this.tenantId,
      formula: context.formulaId,
      vault: context.vaultId,
    };
  }

  /** Bound every KMS round trip by a timeout and normalize every failure mode (network,
   * throttling, access-denied, timeout) into one fail-closed error. Never swallows, never
   * falls back — the caller's exception is the vault's refusal. */
  private async run<TOutput>(fn: (abortSignal: AbortSignal) => Promise<TOutput>): Promise<TOutput> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fn(controller.signal);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Formula vault KMS operation failed (fail-closed, no plaintext released): ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async generateDek(context: VaultKeyContext): Promise<{ plaintext: Buffer; wrapped: WrappedKey }> {
    const res = await this.run((abortSignal) =>
      this.client.send(
        new GenerateDataKeyCommand({
          KeyId: this.keyId,
          KeySpec: 'AES_256',
          EncryptionContext: this.buildContext(context),
        }),
        { abortSignal },
      ),
    );
    if (!res.Plaintext || !res.CiphertextBlob) {
      throw new Error('Formula vault KMS operation failed (fail-closed, no plaintext released): GenerateDataKey returned no key material.');
    }
    return {
      plaintext: Buffer.from(res.Plaintext),
      // AWS KMS ciphertext is opaque and self-describing (key id, algorithm, context are all
      // embedded server-side) — iv/tag are a local-AEAD-only concept, left empty here.
      wrapped: { ciphertext: Buffer.from(res.CiphertextBlob).toString('base64'), iv: '', tag: '' },
    };
  }

  async wrapExistingDek(dek: Buffer, context: VaultKeyContext): Promise<WrappedKey> {
    const res = await this.run((abortSignal) =>
      this.client.send(
        new EncryptCommand({
          KeyId: this.keyId,
          Plaintext: dek,
          EncryptionContext: this.buildContext(context),
        }),
        { abortSignal },
      ),
    );
    if (!res.CiphertextBlob) {
      throw new Error('Formula vault KMS operation failed (fail-closed, no plaintext released): Encrypt returned no ciphertext.');
    }
    return { ciphertext: Buffer.from(res.CiphertextBlob).toString('base64'), iv: '', tag: '' };
  }

  async unwrapDek(wrapped: WrappedKey, context: VaultKeyContext): Promise<Buffer> {
    const res = await this.run((abortSignal) =>
      this.client.send(
        new DecryptCommand({
          CiphertextBlob: Buffer.from(wrapped.ciphertext, 'base64'),
          // Pin the expected key: refuses ciphertext wrapped under a DIFFERENT CMK even if
          // someone could contrive a matching EncryptionContext.
          KeyId: this.keyId,
          EncryptionContext: this.buildContext(context),
        }),
        { abortSignal },
      ),
    );
    if (!res.Plaintext) {
      throw new Error('Formula vault KMS operation failed (fail-closed, no plaintext released): Decrypt returned no plaintext (context mismatch or corrupt ciphertext).');
    }
    return Buffer.from(res.Plaintext);
  }

  /**
   * Recover (or, on first boot, mint) the ONE stable HMAC key that signs the audit hash
   * chain. Must be STABLE across restarts — `VaultService.verifyAuditChain()` recomputes
   * every row's MAC with whatever key `macAudit` currently uses, so a key that changes
   * between processes makes every pre-restart row look tampered (a diagnostics
   * false-positive, not a real security hole, but confusing and must be avoided).
   *
   * `FORMULA_AUDIT_HMAC_WRAPPED` holds the KMS ciphertext (opaque, safe to store as an
   * ordinary config value — see the deploy runbook) from a ONE-TIME GenerateDataKey call.
   * Every boot calls Decrypt on it to recover the same plaintext key into memory (never
   * persisted, never logged). If unset (first boot / not yet provisioned), this mints a new
   * one and logs ONLY the wrapped ciphertext with an instruction to persist it — the
   * plaintext itself never appears in a log line.
   */
  private async loadOrMintAuditKey(): Promise<Buffer> {
    const context: EncryptionContextType = { purpose: AUDIT_KEY_PURPOSE, tenant: this.tenantId };
    const wrapped = this.config.get('FORMULA_AUDIT_HMAC_WRAPPED');
    if (wrapped) {
      const res = await this.run((abortSignal) =>
        this.client.send(
          new DecryptCommand({
            CiphertextBlob: Buffer.from(wrapped, 'base64'),
            KeyId: this.keyId,
            EncryptionContext: context,
          }),
          { abortSignal },
        ),
      );
      if (!res.Plaintext) {
        throw new Error(
          'Formula vault KMS operation failed (fail-closed, no plaintext released): could not recover the audit HMAC key (FORMULA_AUDIT_HMAC_WRAPPED did not decrypt).',
        );
      }
      return Buffer.from(res.Plaintext);
    }

    const res = await this.run((abortSignal) =>
      this.client.send(
        new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: 'AES_256', EncryptionContext: context }),
        { abortSignal },
      ),
    );
    if (!res.Plaintext || !res.CiphertextBlob) {
      throw new Error(
        'Formula vault KMS operation failed (fail-closed, no plaintext released): GenerateDataKey returned no key material for the audit HMAC key.',
      );
    }
    // eslint-disable-next-line no-console -- deliberate operator-facing boot warning; logs the
    // WRAPPED (ciphertext) form only, never the plaintext key it decrypts to.
    console.warn(
      '[vault] FORMULA_AUDIT_HMAC_WRAPPED is unset — minted a new audit-chain HMAC key via AWS KMS. ' +
        'Persist it as a config value (it is opaque KMS ciphertext, safe to store) before the next ' +
        'restart, or verifyAuditChain() will report every row written before that restart as a ' +
        'chain mismatch: FORMULA_AUDIT_HMAC_WRAPPED=' +
        Buffer.from(res.CiphertextBlob).toString('base64'),
    );
    return Buffer.from(res.Plaintext);
  }

  private auditKey(): Promise<Buffer> {
    if (!this.auditKeyPromise) {
      this.auditKeyPromise = this.loadOrMintAuditKey().catch((err) => {
        // Do not cache a rejected promise — a transient KMS outage during the FIRST audit
        // write shouldn't permanently wedge every later attempt in the same process.
        this.auditKeyPromise = undefined;
        throw err;
      });
    }
    return this.auditKeyPromise;
  }

  async macAudit(data: string): Promise<string> {
    const key = await this.auditKey();
    return createHmac('sha256', key).update(data, 'utf8').digest('hex');
  }
}
