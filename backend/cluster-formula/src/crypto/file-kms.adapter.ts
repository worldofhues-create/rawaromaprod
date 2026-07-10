/**
 * FileKmsAdapter — the OFFLINE-console `KmsPort`. Identical AES-256-GCM DEK wrapping + KEK-keyed
 * audit HMAC as EnvKmsAdapter, but the 32-byte KEK is read from a FILE (`FORMULA_KEK_FILE`) on
 * removable / encrypted media instead of an env secret. The media is mounted only during unseal
 * windows; the key is read PER OPERATION (never cached in the adapter), so if the media is
 * unmounted every crypto op fails closed and no plaintext recipe can be produced.
 *
 * Because the crypto is byte-identical to EnvKmsAdapter, a DEK wrapped under a given 32-byte key
 * unwraps under either adapter — so an online-sealed formula opens on the offline console when the
 * file holds the same key bytes. Selected over EnvKmsAdapter by the env-driven binding in
 * formula.module.ts (FORMULA_KEK_FILE present → this adapter). The vault services do not change.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@core/backend-kernel';
import type { KmsPort, WrappedKey } from './kms.port.js';

@Injectable()
export class FileKmsAdapter implements KmsPort {
  /** Names the KEK that wrapped a DEK — persisted as FORMULA_VAULT.encryption_key_ref. */
  readonly keyRef = 'file-kek:v1';

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  /** Read + strictly validate the KEK from the mounted media on demand (never cached). */
  private kek(): Buffer {
    const path = this.config.get('FORMULA_KEK_FILE');
    if (!path) {
      throw new Error('Formula vault unavailable: FORMULA_KEK_FILE is not configured.');
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8').trim();
    } catch {
      throw new Error('Formula vault unavailable: the KEK file could not be read (is the media mounted?).');
    }
    const key = Buffer.from(raw, 'base64');
    if (key.toString('base64') !== raw) {
      throw new Error('Formula vault misconfigured: the KEK file is not valid base64.');
    }
    if (key.length !== 32) {
      throw new Error('Formula vault misconfigured: the KEK file must decode to 32 bytes (AES-256).');
    }
    return key;
  }

  wrapDek(dek: Buffer): WrappedKey {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.kek(), iv);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  unwrapDek(wrapped: WrappedKey): Buffer {
    const decipher = createDecipheriv('aes-256-gcm', this.kek(), Buffer.from(wrapped.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(wrapped.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(wrapped.ciphertext, 'base64')),
      decipher.final(),
    ]);
  }

  /** HMAC-SHA256 keyed by the KEK — the audit chain link an attacker can't forge from DB alone. */
  macAudit(data: string): string {
    return createHmac('sha256', this.kek()).update(data, 'utf8').digest('hex');
  }
}
