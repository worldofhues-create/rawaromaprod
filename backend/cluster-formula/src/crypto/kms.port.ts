/**
 * KmsPort — the key-management seam. The vault never touches the KEK (key-encryption key)
 * directly; it asks this port to mint/wrap a per-formula DEK (data-encryption key) and to
 * unwrap it on read. Phase-1 bound this to `EnvKmsAdapter` (KEK from the `FORMULA_KEK` app
 * secret) / `FileKmsAdapter` (KEK on removable media) — dev/test only now. Production binds
 * `AwsKmsAdapter` (PB-03): a real AWS KMS customer-managed key, envelope encryption over the
 * network, ZERO change to the vault services above this seam.
 *
 * Async: every method returns a Promise because the production adapter makes a KMS network
 * call per operation (the env/file adapters resolve synchronously under the hood but still
 * return a Promise so callers don't care which adapter is bound).
 *
 * `macAudit` is the tamper-evidence primitive for the hash-chained access log: an
 * HMAC keyed by a key only the adapter holds, so an attacker who can write Postgres still
 * cannot forge a valid chain without that key.
 */

/** A DEK wrapped under the KEK/CMK. All fields base64. Stored as the vault row's vault_location. */
export interface WrappedKey {
  /** the wrapped (encrypted) data key */
  ciphertext: string;
  /** the GCM iv used to wrap (env/file adapters only — AWS KMS ciphertext is opaque and this is `""`) */
  iv: string;
  /** the GCM auth tag (env/file adapters only — AWS KMS ciphertext is opaque and this is `""`) */
  tag: string;
}

/**
 * Resource-level binding a caller supplies for a DEK operation. The adapter merges in its
 * OWN deployment-scoped tenant id (from config) to form the full AWS KMS `EncryptionContext`
 * — additional authenticated data KMS cryptographically binds to the ciphertext and REQUIRES
 * back on every unwrap (a context that doesn't match byte-for-byte is a refused Decrypt, not
 * a wrong answer). This is what stands in for the launch directive's "tenant+formula+version"
 * binding:
 *
 *   - tenant  → adapter-internal (FORMULA_KMS_TENANT_ID config), not per-call — this
 *               deployment IS one tenant (RAC); a future multi-tenant fork threads a real
 *               tenant id through this same context shape.
 *   - formula → `formulaId` below.
 *   - version → `vaultId` below (the FORMULA_VAULT row's OWN id), NOT a recipe
 *               FORMULA_VERSION id. A DEK is minted ONCE per formula (formula_vault is one
 *               row per formula_master, §109.2) and covers every version's sealed
 *               ingredients — so the context must be identical between the ONE wrap call and
 *               every later unwrap call across however many versions exist. A real
 *               formula_version id varies per decrypt call and would make KMS refuse every
 *               unwrap after the first. `vaultId` is the stable "key version" identity KMS
 *               binds to instead.
 *
 * Env/File adapters accept and ignore this — their AEAD binding is the raw KEK bytes, no
 * native "context" concept — so nothing here changes dev/test behavior.
 */
export interface VaultKeyContext {
  formulaId: string;
  vaultId: string;
}

export interface KmsPort {
  /** A stable reference identifying which KEK/CMK+version wrapped a key → FORMULA_VAULT.encryption_key_ref. */
  readonly keyRef: string;

  /**
   * Mint a BRAND-NEW DEK, wrapped under this adapter's key, bound to `context`. The normal
   * path for creating a formula's vault row. AWS: one `GenerateDataKeyCommand` round trip
   * (KMS mints the key server-side and returns both the plaintext and the wrapped form —
   * nothing but this adapter ever sees the plaintext). Env/File: 32 random bytes generated
   * locally, then wrapped with AES-256-GCM under the KEK (byte-identical crypto to Phase-1).
   */
  generateDek(context: VaultKeyContext): Promise<{ plaintext: Buffer; wrapped: WrappedKey }>;

  /**
   * Wrap an ALREADY-KNOWN plaintext DEK under this adapter's key, bound to `context`. NOT
   * used by ordinary vault services — the DEK for a given formula must never change once
   * ingredients are sealed under it. Exists solely for `scripts/vault-rewrap.ts`: moving an
   * existing formula's DEK from one key source (env/file KEK) to AWS KMS WITHOUT touching its
   * sealed ingredient ciphertext, which was encrypted under this exact DEK and must not
   * change. AWS: `EncryptCommand` on the given bytes (KMS never mints here — it just wraps
   * what it's handed).
   */
  wrapExistingDek(dek: Buffer, context: VaultKeyContext): Promise<WrappedKey>;

  /**
   * Unwrap a previously wrapped DEK, bound to the SAME `context` used to wrap it. AWS:
   * `DecryptCommand`; KMS refuses if `context` doesn't match byte-for-byte what was used at
   * wrap time. Throws (does not return partial/garbage plaintext) if the wrapper was
   * tampered (env/file: GCM tag fails) or the context mismatches (AWS: KMS rejects).
   */
  unwrapDek(wrapped: WrappedKey, context: VaultKeyContext): Promise<Buffer>;

  /** Tamper-evidence MAC (hex) for the hash-chained access audit. */
  macAudit(data: string): Promise<string>;
}

/** DI token for the active `KmsPort` implementation. */
export const KMS_PORT = Symbol('KMS_PORT');
