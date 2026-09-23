/**
 * VaultService — the crypto engine the rest of the cluster leans on. It is the ONLY place
 * that unwraps a DEK and unseals ingredients, and it refuses to do so without writing an
 * audit row in the SAME transaction. Three guarantees live here:
 *
 *   1. READ-ONLY-WHEN-LOCKED — `decryptVersion` throws unless the version status is APPROVED
 *      (= approved + immutable). Draft recipes never decrypt.
 *   2. NO UN-AUDITED READ — every decrypt writes a hash-chained `formula.audit_events` row in
 *      the same tx; if the audit insert fails the decrypt rolls back.
 *   3. TAMPER-EVIDENT CHAIN — rows are serialized with a transaction-scoped advisory lock
 *      (no forks) and linked by row_hash = KEK-keyed-HMAC(prev_hash || canonical(row)).
 */
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { FORMULA_DB, formulaSchema, type FormulaDb } from './formula.tokens.js';
import { KMS_PORT, type KmsPort, type WrappedKey } from './crypto/kms.port.js';
import { canonicalAudit, unseal } from './crypto/vault-crypto.js';

const { formulaVersion, formulaVault, formulaIngredients, auditEvents } = formulaSchema;

/** The drizzle transaction handle for this cluster's schema (used by the in-tx helpers). */
type Tx = Parameters<Parameters<FormulaDb['transaction']>[0]>[0];

/** A single decrypted ingredient — real material_id; stays inside the cluster boundary. */
export interface DecryptedIngredient {
  materialId: string;
  percentage: number;
  sequenceNo: number | null;
}

/** Audit row fields the caller supplies; hashes/occurredAt are computed here. */
export interface AuditInput {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  requestId?: string | null;
  ip?: string | null;
  /** §109.8 "purpose/reason" — the caller-supplied justification for a plaintext read, shown
   * back on the access-audit screen. Stored in the row's `after` jsonb snapshot column
   * (added here without a schema migration — every cluster's audit_events table already has
   * it). NOT folded into the tamper-evident hash chain (`canonicalAudit` is unchanged): doing
   * so would change every row_hash computation, including any already-written rows, which
   * would break `verifyAuditChain()` retroactively. A version-safe way to add it to the MAC
   * (e.g. keyed by chain_seq cutover) is a deliberate fast-follow, not done here. */
  reason?: string | null;
  /** §109.8 "allow/refuse result". Defaults to 'allow' — callers on a refusal path pass
   * 'refuse' explicitly (see `writeStandaloneAudit`). Same non-hashed `after` treatment. */
  result?: 'allow' | 'refuse';
}

/** Stable bigint key for the advisory lock that serializes audit-chain appends. */
const AUDIT_CHAIN_LOCK = 8473625190100001n;

@Injectable()
export class VaultService {
  constructor(
    @Inject(FORMULA_DB) private readonly db: FormulaDb,
    @Inject(KMS_PORT) private readonly kms: KmsPort,
  ) {}

  /** Unwrap the per-formula DEK from its vault row. Throws if the vault row is missing. */
  async getDekForFormula(formulaId: string | null, tx: Tx): Promise<Buffer> {
    if (!formulaId) throw new NotFoundException('formula version has no parent formula');
    const vault = (
      await tx.select().from(formulaVault).where(eq(formulaVault.formulaId, formulaId)).limit(1)
    )[0];
    if (!vault?.vaultLocation) throw new NotFoundException('formula vault entry missing');
    return this.kms.unwrapDek(parseWrappedKey(vault.vaultLocation), {
      formulaId,
      vaultId: vault.formulaVaultId,
    });
  }

  /**
   * Decrypt every ingredient of an APPROVED version + write the mandatory audit row, all in
   * one transaction. Returns null if the version doesn't exist. Throws if it isn't locked.
   * This is the single chokepoint behind getFloorView / getPickList / the owner HTTP read.
   */
  async decryptVersion(
    formulaVersionId: string,
    audit: AuditInput,
  ): Promise<DecryptedIngredient[] | null> {
    return this.db.transaction(async (tx) => {
      const version = (
        await tx
          .select()
          .from(formulaVersion)
          .where(eq(formulaVersion.formulaVersionId, formulaVersionId))
          .limit(1)
      )[0];
      if (!version) return null;
      // §109.8: APPROVED and LOCKED are both decryptable (LOCKED is APPROVED's further-frozen
      // successor state, not a separate access tier — see ApprovalsService.lockVersion).
      if (version.status !== 'APPROVED' && version.status !== 'LOCKED') {
        throw new ForbiddenException('formula version is not approved/locked — decryption denied');
      }

      const dek = await this.getDekForFormula(version.formulaId, tx);

      const rows = await tx
        .select()
        .from(formulaIngredients)
        .where(eq(formulaIngredients.formulaVersionId, formulaVersionId))
        .orderBy(asc(formulaIngredients.sequenceNo));

      const ingredients = rows.map((r) => {
        const secret = unseal({ encPayload: r.encPayload, encIv: r.encIv, encTag: r.encTag }, dek);
        return {
          materialId: secret.materialId,
          percentage: secret.percentage,
          sequenceNo: r.sequenceNo,
        };
      });

      await this.writeAudit(tx, audit);
      return ingredients;
    });
  }

  /**
   * Append one hash-chained audit row. The tx-scoped advisory lock (held to commit) serializes
   * appends so concurrent readers can't fork the chain; the head is read by the monotonic
   * `chain_seq` (not a mutable timestamp), the next seq is folded INTO the MAC, and row_hash
   * links to the prior row via the KEK-keyed HMAC. Call ONLY inside an open transaction (so the
   * audit commits atomically with its cause).
   */
  async writeAudit(tx: Tx, e: AuditInput): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`);
    const prev = (
      await tx
        .select({ chainSeq: auditEvents.chainSeq, rowHash: auditEvents.rowHash })
        .from(auditEvents)
        .orderBy(desc(auditEvents.chainSeq))
        .limit(1)
    )[0];
    const prevHash = prev?.rowHash ?? null;
    const chainSeq = (prev?.chainSeq ?? 0n) + 1n;
    const occurredAt = new Date();
    const requestId = e.requestId ?? null;
    const ip = e.ip ?? null;
    const canonical = canonicalAudit({
      chainSeq,
      actorId: e.actorId,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      occurredAt: occurredAt.toISOString(),
      requestId,
      ip,
    });
    const rowHash = await this.kms.macAudit((prevHash ?? '') + canonical);

    // Non-hashed metadata (see the AuditInput doc comment for why reason/result stay outside
    // the MAC). Omitted entirely (column stays null) when the caller supplies neither, so an
    // ordinary lifecycle audit row (create/seal/approve) looks exactly as it did before.
    const after =
      e.reason || e.result ? { ...(e.reason ? { reason: e.reason } : {}), result: e.result ?? 'allow' } : null;

    await tx.insert(auditEvents).values({
      actorId: e.actorId,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      after,
      requestId,
      ip,
      occurredAt,
      chainSeq,
      prevHash,
      rowHash,
    });
  }

  /**
   * Write one audit row in its OWN fresh transaction. For a refusal path that happens BEFORE
   * (or independent of) the transaction that would have performed the audited action — e.g.
   * a per-formula authorization failure, or `decryptVersion`'s own transaction rolling back
   * (and taking its would-be audit insert with it) when the version isn't APPROVED. Without
   * this, a refused attempt leaves no trace at all, which is exactly the gap §109.8's
   * "allow/refuse result" exists to close.
   */
  async writeStandaloneAudit(e: AuditInput): Promise<void> {
    await this.db.transaction((tx) => this.writeAudit(tx, e));
  }

  /**
   * Verify the tamper-evidence of the whole formula access-audit chain (audit #6). Walks chain_seq
   * ascending and checks (1) strictly-monotonic, no-gap seq, (2) prev_hash links to the prior row,
   * (3) row_hash recomputes = KEK-HMAC(prev_hash || canonical(row)). A tampered / deleted / reordered
   * row breaks the recompute — a DB-write attacker without the KEK cannot forge a valid chain.
   */
  async verifyAuditChain(): Promise<{ ok: boolean; rows: number; firstBadSeq: number | null; reason: string | null }> {
    const rows = await this.db
      .select({
        chainSeq: auditEvents.chainSeq,
        actorId: auditEvents.actorId,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        occurredAt: auditEvents.occurredAt,
        requestId: auditEvents.requestId,
        ip: auditEvents.ip,
        prevHash: auditEvents.prevHash,
        rowHash: auditEvents.rowHash,
      })
      .from(auditEvents)
      .orderBy(asc(auditEvents.chainSeq));

    let prevHash: string | null = null;
    let expectedSeq = 1n;
    for (const r of rows) {
      const seq = r.chainSeq ?? -1n;
      if (seq !== expectedSeq) {
        return { ok: false, rows: rows.length, firstBadSeq: Number(seq), reason: `chain_seq gap or regression (expected ${expectedSeq}, got ${seq})` };
      }
      if ((r.prevHash ?? null) !== prevHash) {
        return { ok: false, rows: rows.length, firstBadSeq: Number(seq), reason: 'prev_hash does not link to the prior row' };
      }
      const canonical = canonicalAudit({
        chainSeq: seq,
        actorId: r.actorId,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        occurredAt: r.occurredAt.toISOString(),
        requestId: r.requestId,
        ip: r.ip,
      });
      if ((await this.kms.macAudit((r.prevHash ?? '') + canonical)) !== r.rowHash) {
        return { ok: false, rows: rows.length, firstBadSeq: Number(seq), reason: 'row_hash does not recompute — content tampered' };
      }
      prevHash = r.rowHash;
      expectedSeq = seq + 1n;
    }
    return { ok: true, rows: rows.length, firstBadSeq: null, reason: null };
  }
}

/**
 * Parse + validate the wrapped-key blob from FORMULA_VAULT.vault_location. The column is a
 * plain varchar an attacker with DB write could corrupt; we never feed an unchecked shape to
 * the cipher. Validates the three base64 fields exist, and — for the local-AEAD adapters
 * (env/file KEK) — that iv/tag decode to GCM sizes (12 / 16 bytes). AWS KMS ciphertext is
 * opaque and self-describing server-side, so AwsKmsAdapter stores iv/tag as `""`; that empty
 * pair is the one exception to the GCM-size check below (still requires ciphertext to be
 * non-empty — an all-empty blob is still rejected as malformed).
 */
function parseWrappedKey(raw: string): WrappedKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NotFoundException('formula vault key material is corrupt');
  }
  const w = parsed as Partial<WrappedKey>;
  if (typeof w?.ciphertext !== 'string' || typeof w?.iv !== 'string' || typeof w?.tag !== 'string' || w.ciphertext.length === 0) {
    throw new NotFoundException('formula vault key material is malformed');
  }
  const isOpaqueKmsCiphertext = w.iv === '' && w.tag === '';
  if (!isOpaqueKmsCiphertext) {
    if (Buffer.from(w.iv, 'base64').length !== 12 || Buffer.from(w.tag, 'base64').length !== 16) {
      throw new NotFoundException('formula vault key material is malformed');
    }
  }
  return { ciphertext: w.ciphertext, iv: w.iv, tag: w.tag };
}
