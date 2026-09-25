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

  /**
   * The MAIN schema Postgres instance (iam/platform/masterdata/… — every cluster EXCEPT
   * formula, which never shares this connection). Required to boot `main.ts` (AppModule) and
   * `worker.ts` (WorkerModule) — `DrizzleModule`'s `PG_CLIENT` factory throws a clear boot
   * error if it's unset when actually instantiated.
   *
   * OPTIONAL here (not `.optional()` was the old, PB-03-blocking shape) specifically so
   * `vault-main.ts` (`VaultAppModule`) can boot on the isolated Vault EC2, which by design
   * (V4 §109.1) has no network path to this database at all and must never be handed its
   * credential — see `vault-main.ts`'s header comment. `VaultAppModule` never imports
   * `DrizzleModule`/`BackendKernelModule.forRoot()`, so this being unset there is inert; every
   * OTHER deployable that needs it (main.ts/worker.ts) still fails fast via the DrizzleModule
   * guard, exactly as before.
   */
  DATABASE_URL: z.string().url().optional(),

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
   * seam: later this points at the on-prem DB, no code change.
   *
   * PB-03 / V4 §109.1, §7.2: MANDATORY when APP_ENV=prod — production NEVER falls back to
   * DATABASE_URL (formula.tokens.ts createFormulaClient throws a clear boot error instead).
   * Optional outside prod purely for dev/CI convenience (falls back to DATABASE_URL there).
   *
   * Read ONLY by processes that compose FormulaModule: vault-main.ts (the Vault box), the migrate
   * runner and single-process scripts/tests. main.ts and worker.ts never read it — the main app box
   * reaches the Vault over VAULT_API_INTERNAL_URL only (vault-port.ts), so a value set there is inert.
   */
  FORMULA_DATABASE_URL: z.string().url().optional(),
  /**
   * Vault KEK (key-encryption key), base64 32 bytes, held in the app secret store (never
   * in Postgres). DEV/TEST ONLY as of PB-03 — production refuses EnvKmsAdapter/FileKmsAdapter
   * entirely (formula.module.ts) and requires FORMULA_KMS_KEY_ID (AwsKmsAdapter) instead.
   * Optional so the app boots without it; vault encrypt/decrypt throws a clear error until set.
   */
  FORMULA_KEK: z.string().optional(),

  /**
   * OFFLINE console (FUTURE_OPTIONAL, dev/test only as of PB-03): path to a file holding the
   * 32-byte base64 KEK on removable / encrypted media. When set outside prod, the vault binds
   * FileKmsAdapter instead of EnvKmsAdapter. Generate with `node scripts/formula-kek-keygen.cjs`.
   */
  FORMULA_KEK_FILE: z.string().optional(),

  /**
   * PB-03 / V4 §109.2: the AWS KMS customer-managed key (CMK) id/ARN the Formula Vault wraps
   * every DEK under. MANDATORY when APP_ENV=prod — formula.module.ts refuses to boot without
   * it (production accepts ONLY AwsKmsAdapter; FORMULA_KEK/FORMULA_KEK_FILE are ignored in
   * prod even if set). Unused outside prod unless a developer opts into exercising the real
   * adapter locally.
   */
  FORMULA_KMS_KEY_ID: z.string().optional(),
  /** Region for the AWS KMS client. Optional — unset lets the AWS SDK's ambient region chain resolve it. */
  FORMULA_KMS_REGION: z.string().optional(),
  /** Deployment-scoped tenant id folded into every KMS EncryptionContext (see kms.port.ts VaultKeyContext). Default "rac" (this deployment IS the one tenant). */
  FORMULA_KMS_TENANT_ID: z.string().optional(),
  /** Fail-closed bound (ms) on every AWS KMS round trip (§109.6 / F7). */
  FORMULA_KMS_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  /**
   * Opaque AWS KMS ciphertext (base64) wrapping the STABLE audit-chain HMAC key — see
   * aws-kms.adapter.ts `loadOrMintAuditKey`. Safe to store as an ordinary config value (it is
   * KMS-wrapped ciphertext, not a key). Optional: unset on first boot mints one and logs the
   * wrapped form for an operator to persist here.
   */
  FORMULA_AUDIT_HMAC_WRAPPED: z.string().optional(),

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

  /**
   * PB-04 / SB-02 — ALEMBIC->RawProd signed identity assertion (FINAL_OS §2.4, §9). The
   * ONLY online staff identity rail for launch: a colleague signs in once on ALEMBIC
   * (email OTP) and ALEMBIC mints a short-lived, single-use, Ed25519-signed assertion
   * this deployment verifies at `POST /auth/alembic-assertion` and maps to an EXISTING
   * `iam.user_master` row by email -- no auto-provisioning, ever (see auth.service.ts).
   *
   * `ALEMBIC_ASSERTION_VERIFY_KEY` is the PUBLIC half only (base64 DER, spki) of the
   * keypair `ops/scripts/rawprod-assertion-keygen.cjs` generates in the ALEMBIC
   * repository -- the private half never leaves ALEMBIC's own config. Optional so the
   * app boots without it; the route throws a clear 503 until it is set, the same
   * "refuse rather than silently degrade" rule FORMULA_KEK/RELAY_VERIFY_KEY follow.
   */
  ALEMBIC_ASSERTION_VERIFY_KEY: z.string().optional(),
  ALEMBIC_ASSERTION_ISSUER: z.string().default('alembic'),
  ALEMBIC_ASSERTION_AUDIENCE: z.string().default('rawprod'),
  /**
   * S3 security review item 3 — comma-separated list of the RawProd console target(s) THIS
   * deployment serves (`factory`, `platform`, `vault`). An assertion whose `target` claim is
   * not in this list is refused, even if everything else about it verifies — closes a
   * cross-console token-reuse path (an assertion minted for `platform` presented to the
   * standalone Vault box, or vice versa). The shared factory+platform deployment (one process,
   * both hostnames per infra/aws/nginx/rawprod-main.conf) sets `factory,platform`; the
   * standalone Vault EC2 (infra/aws/nginx/vault.conf) sets `vault` alone. Optional/unset skips
   * the check (dev/test default — the same "boots without it" posture ALEMBIC_ASSERTION_VERIFY_KEY
   * itself takes).
   */
  RAWPROD_ASSERTION_EXPECTED_TARGETS: z.string().optional(),
  /**
   * S3 security review item 3 — this RawProd deployment's own tenant/org id. When set, an
   * assertion's `tenant_id` AND `org_id` claims must both equal it exactly. Optional/unset
   * skips the check (dev/test default; RAC is presently this deployment's one tenant, so a
   * production config should set this to that tenant's id once it is provisioned).
   */
  ALEMBIC_ASSERTION_TENANT_ID: z.string().optional(),
  /**
   * LANE D1 — what this RawProd deployment IS: `production` (default; production never sets
   * it) or `demo`, the separate showcase environment that runs the same release artifact
   * against its own database. An ALEMBIC assertion is accepted only when its `env` claim
   * equals this value, and the `showcase` role can hold a session only when this is `demo`.
   * In a demo deployment `ALEMBIC_ASSERTION_TENANT_ID` names the demo ALEMBIC tenant, which
   * is the demo tenant/org mapping. Nothing in a request can change it.
   */
  RAWPROD_ENVIRONMENT: z.enum(['production', 'demo']).default('production'),

  /**
   * PB-04 / SB-02 — password sign-in is RETIRED for launch (FINAL_OS §2.4/§9,
   * owner ruling: "RawProd password login must be removed from prod; ALEMBIC OTP +
   * signed assertion"). `AuthService.login`/`setPassword` refuse UNCONDITIONALLY
   * whenever `APP_ENV=prod`, regardless of this flag -- it cannot re-enable the rail
   * in production. Outside prod it is the explicit, default-OFF escape hatch for a
   * suite that still needs the password path (`TEST_DATABASE_URL` runs, local dev
   * without an ALEMBIC box to hand): set it `true` deliberately, never as a default.
   */
  PASSWORD_LOGIN_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * Build identity for the running process — Platform Ops' "Deployment / build" screen
   * (P0_UI_PARITY_PUBLIC_GREEN_ADDENDUM.md §6). Populated by the deploy platform at build/
   * deploy time (e.g. a CI step exporting the commit it built, or Render's
   * RENDER_GIT_COMMIT — read as a fallback at the call site, not hardcoded here). Both
   * optional; unset reports null rather than a fabricated value — "no fake data" (§6/§13).
   */
  GIT_SHA: z.string().optional(),
  BUILD_TIME: z.string().optional(),

  /**
   * PB-03 remainder (V4 §109.1) — true on the standalone Vault EC2's `vault-main.ts`
   * (`VaultAppModule`) ONLY. Read directly off `process.env` (not via an injected
   * `ConfigService`) by `@ra/cluster-formula`'s `formula.module.ts` at MODULE-DECORATION time
   * — before Nest's DI container exists — to decide, once per process, whether to mount the
   * formula plaintext HTTP routes (CatalogController/FormulasController/ApprovalsController;
   * vault mode only) and whether `MASTERDATA_LOOKUP` resolves locally off the shared main
   * `PG_CLIENT` (main mode; `ClusterMasterdataModule`) or off the material catalogue the main box
   * pushes over the signed internal channel (vault mode; `MaterialCatalogue` — zero main-DB
   * credential on the Vault box, and no call back into the main box). Also
   * exposed here (typed, via `ConfigService`) so `vault-main.ts` can assert it's true and
   * `main.ts` can assert it's NOT true, as a boot-time sanity check that the right entrypoint
   * is running the right module.
   */
  VAULT_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * PB-03 remainder — the shared secret for the ONE internal, service-to-service signed
   * channel between the main app box and the standalone Vault EC2 (an HMAC-SHA256 over
   * method+path+timestamp+body, `internal-bridge-signing.ts`; §109's "signed internal
   * channel"). ONE direction only, main → vault: `VaultApiClient` / `VaultSecurityAuditClient`
   * (`@ra/cluster-formula`) calling `VAULT_API_INTERNAL_URL` — every formula read the main box
   * needs (a coded manufacturing instruction, a production order's coded pick list, formula codes
   * and statuses for its screens, the access audit), its security-audit writes, and the material
   * catalogue it PUSHES for the Vault console's picker; the main box has no formula-database
   * connection. The Vault never calls the main box (lane fread-rp retired the vault → main
   * `MaterialFactsClient` and `MAIN_API_INTERNAL_URL`: no deployment ever had that path).
   * Both boxes also derive the keyed material-reference key from it (material-ref.ts).
   * Distributed to both boxes via SSM (never baked into an AMI/image or committed). Optional
   * so every OTHER deployable (main.ts/worker.ts outside this bridge) boots without it;
   * `InternalBridgeGuard` fails CLOSED (401) on every request when it's unset, same "refuse
   * rather than silently degrade" rule every other optional security secret here follows.
   * L1: when set it must be >= 32 chars (an HMAC key shorter than that is guessable).
   */
  INTERNAL_BRIDGE_KEY: z.string().min(32).optional(),
  /** L1: the interface vault-main.ts binds. Default 0.0.0.0 (see vault-bind-host.ts) — the
   *  app box reaches the vault's port ACROSS hosts, so loopback would break it; set this to the
   *  vault EC2's private IP to bind only the private interface. */
  VAULT_BIND_HOST: z.string().min(1).optional(),
  /** Vault API's own base URL, reachable from the app box's SG-scoped private path (SG rule
   *  vault-app ← app-box, one port — see `scripts/apply-vault-port-sg-rule.sh`) — the target
   *  `VaultApiClient` (main mode) calls for every formula read — coded manufacturing
   *  instruction and a production order's coded pick list — and security-audit writes. */
  VAULT_API_INTERNAL_URL: z.string().url().optional(),
  /** How often the main box's worker checks that the Vault holds its current material catalogue
   *  (a digest probe) and pushes it when not (`MaterialCatalogueSyncService`). Also the longest a
   *  restarted Vault's material picker waits for its catalogue. */
  VAULT_CATALOGUE_SYNC_MS: z.coerce.number().int().min(1000).default(15_000),
});

export type AppConfig = z.infer<typeof configSchema>;
