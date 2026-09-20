/**
 * Environment schema — the single zod contract for every env var the backend reads.
 *
 * Parsed once at boot (`ConfigService` below). Unknown keys are ignored; missing /
 * malformed required keys fail fast with a readable message instead of surfacing as a
 * mysterious runtime error deep in a request. Add a var here before reading it anywhere.
 */
import { z } from 'zod';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['dev', 'staging', 'prod']).default('dev'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /** One Postgres instance; per-schema clients are created from this single URL. */
  DATABASE_URL: z.string().url(),

  /** Optional Redis URL (sessions / rate-limit / BullMQ) — placeholder wiring only here. */
  REDIS_URL: z.string().url().optional(),

  /** JWT signing — symmetric HS256 secret (rotate via env; asymmetric is a drop-in later). */
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900), // 15 min
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(60 * 60 * 24 * 30), // 30 days
  JWT_ISSUER: z.string().default('core'),

  /** Outbox drain cadence (ms). */
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(2000),
  OUTBOX_BATCH: z.coerce.number().int().positive().default(100),

  /**
   * Run the worker (outbox drain + schedulers) IN the api process. Enables the free
   * single-service deploy (one Render dyno = api + worker). Set "true" in prod-free;
   * leave false when running a dedicated worker dyno. (Free infra §8.)
   */
  RUN_WORKER_IN_PROCESS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * Allowed browser origins (comma-separated). REQUIRED in prod (APP_ENV=prod) —
   * an unset value in prod is a boot error, never a reflect-any. In dev, unset =
   * permissive reflect so local portals work without config. (BFF masking §7, LEAK-8.)
   */
  CORS_ORIGINS: z.string().optional(),

  /**
   * Formula Vault's OWN Postgres connection (its own `ra_vault` role — the app role
   * cannot read the formula schema). The role-isolation wall + the in-house extraction
   * seam: later this points at the on-prem DB, no code change. Falls back to DATABASE_URL
   * if unset (Phase-1 single-Neon convenience — set a distinct role in prod).
   */
  FORMULA_DATABASE_URL: z.string().url().optional(),
  /**
   * Vault KEK (key-encryption key), base64 32 bytes, held in the app secret store (never
   * in Postgres). Phase-1 env-secret KMS; a real KMS adapter swaps in later via KmsPort.
   * Optional so the app boots without it; vault encrypt/decrypt throws a clear error until set.
   */
  FORMULA_KEK: z.string().optional(),

  /**
   * OFFLINE console: path to a file holding the 32-byte base64 KEK on removable / encrypted media.
   * When set, the vault binds FileKmsAdapter instead of EnvKmsAdapter — the master key lives on
   * mounted media (read per-op, mount only during unseal), never in an env secret. Optional; unset
   * on the online console (keeps EnvKmsAdapter). Generate with `node scripts/formula-kek-keygen.cjs`.
   */
  FORMULA_KEK_FILE: z.string().optional(),

  /**
   * Which console this deployment is. `online` = cloud/public (orders, sales, sealed blobs, no
   * unseal); `factory` = offline/air-gapped (production, QC, dispatch, the vault + unseal). Gates
   * login by role and disables all outbound email on the factory side (true air gap). UNSET =
   * unified single console (the current deployment) — no role gate, so nothing changes until a
   * console is explicitly declared for the two-console split.
   */
  CONSOLE: z.enum(['online', 'factory']).optional(),

  /**
   * Relay (offline air-gap) Ed25519 signing keys, base64 DER. RELAY_SIGNING_KEY (pkcs8 private)
   * signs exported packages on the source console; RELAY_VERIFY_KEY (spki public) verifies imported
   * packages on the destination console. Both optional so the app boots without them — the relay
   * export/import endpoints throw a clear error until the relevant key is set. Generate a pair with
   * `node scripts/relay-keygen.cjs`. Only signed, integrity-checked event envelopes cross the gap;
   * the two databases never open a connection to each other.
   */
  RELAY_SIGNING_KEY: z.string().optional(),
  RELAY_VERIFY_KEY: z.string().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;
