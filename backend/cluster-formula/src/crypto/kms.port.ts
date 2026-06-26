/**
 * KmsPort — the key-management seam. The vault never touches the KEK (key-encryption key)
 * directly; it asks this port to WRAP a freshly generated per-formula DEK (data-encryption
 * key) and to UNWRAP it on read. Phase-1 binds this to `EnvKmsAdapter` (KEK from the
 * `FORMULA_KEK` app secret); a real KMS/HSM adapter (AWS KMS, on-prem) drops in later with
 * ZERO change to the vault services — that is the in-house-extraction seam.
 *
 * `macAudit` is the tamper-evidence primitive for the hash-chained access log: an
 * HMAC keyed by the KEK, so an attacker who can write Postgres still cannot forge a valid
 * chain without the app secret.
 */

/** A DEK wrapped under the KEK. All fields base64. Stored as the vault row's vault_location. */
export interface WrappedKey {
  /** the wrapped (encrypted) data key */
  ciphertext: string;
  /** the GCM iv used to wrap */
  iv: string;
  /** the GCM auth tag */
  tag: string;
}

export interface KmsPort {
  /** A stable reference identifying which KEK/version wrapped a key → FORMULA_VAULT.encryption_key_ref. */
  readonly keyRef: string;
  /** Wrap a freshly generated 32-byte DEK under the KEK. */
  wrapDek(dek: Buffer): WrappedKey;
  /** Unwrap a previously wrapped DEK. Throws if the wrapper was tampered (GCM tag fails). */
  unwrapDek(wrapped: WrappedKey): Buffer;
  /** Tamper-evidence MAC (hex) for the hash-chained access audit. Keyed by the KEK. */
  macAudit(data: string): string;
}

/** DI token for the active `KmsPort` implementation. */
export const KMS_PORT = Symbol('KMS_PORT');
