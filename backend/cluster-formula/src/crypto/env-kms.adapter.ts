/**
 * EnvKmsAdapter — DEV/TEST `KmsPort` backed by the `FORMULA_KEK` app secret (base64, 32
 * bytes), held in the process secret store, NEVER in Postgres. Wraps/unwraps DEKs with
 * AES-256-GCM under that KEK and derives the audit HMAC key from it.
 *
 * PB-03: production now REFUSES this adapter (see formula.module.ts) — a real KMS/HSM is
 * mandatory. This stays bound in dev/test/CI, where provisioning an AWS KMS key per
 * developer/branch is unnecessary friction and the file's own crypto is unchanged from
 * Phase-1, so every existing dev/test fixture keeps working byte-for-byte.
 *
 * The KEK is OPTIONAL at boot (config schema) so the app starts without vault secrets in
 * dev/CI; every crypto operation lazily asserts the KEK is present and exactly 32 bytes,
 * throwing a clear, non-leaky error otherwise. `context` (tenant+formula+"version" binding,
 * see kms.port.ts) is accepted but ignored — this adapter's AEAD binding is the raw KEK
 * bytes, not a KMS encryption context.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@core/backend-kernel';
import type { KmsPort, VaultKeyContext, WrappedKey } from './kms.port.js';

@Injectable()
export class EnvKmsAdapter implements KmsPort {
  /** Names the KEK that wrapped a DEK — persisted as FORMULA_VAULT.encryption_key_ref. */
  readonly keyRef = 'env-kek:v1';

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  /** Decode + strictly validate the KEK on demand. Throws if unset, not strict base64, or not 32 bytes. */
  private kek(): Buffer {
    const raw = this.config.get('FORMULA_KEK');
    if (!raw) {
      throw new Error('Formula vault unavailable: FORMULA_KEK is not configured.');
    }
    const key = Buffer.from(raw, 'base64');
    // Reject silently-tolerated malformed base64 (whitespace, bad chars): the canonical
    // re-encoding must round-trip, else the configured key is not what was intended.
    if (key.toString('base64') !== raw) {
      throw new Error('Formula vault misconfigured: FORMULA_KEK is not valid base64.');
    }
    if (key.length !== 32) {
      throw new Error('Formula vault misconfigured: FORMULA_KEK must decode to 32 bytes (AES-256).');
    }
    return key;
  }

  private wrap(dek: Buffer): WrappedKey {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.kek(), iv);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  async generateDek(_context: VaultKeyContext): Promise<{ plaintext: Buffer; wrapped: WrappedKey }> {
    const plaintext = randomBytes(32);
    return { plaintext, wrapped: this.wrap(plaintext) };
  }

  async wrapExistingDek(dek: Buffer, _context: VaultKeyContext): Promise<WrappedKey> {
    return this.wrap(dek);
  }

  async unwrapDek(wrapped: WrappedKey, _context: VaultKeyContext): Promise<Buffer> {
    const decipher = createDecipheriv('aes-256-gcm', this.kek(), Buffer.from(wrapped.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(wrapped.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(wrapped.ciphertext, 'base64')),
      decipher.final(),
    ]);
  }

  /** HMAC-SHA256 keyed by the KEK — the audit chain link an attacker can't forge from DB alone. */
  async macAudit(data: string): Promise<string> {
    return createHmac('sha256', this.kek()).update(data, 'utf8').digest('hex');
  }
}
