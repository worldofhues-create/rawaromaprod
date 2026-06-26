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
    return this.kms.unwrapDek(parseWrappedKey(vault.vaultLocation));
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
      if (version.status !== 'APPROVED') {
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
    const rowHash = this.kms.macAudit((prevHash ?? '') + canonical);

    await tx.insert(auditEvents).values({
      actorId: e.actorId,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      requestId,
      ip,
      occurredAt,
      chainSeq,
      prevHash,
      rowHash,
    });
  }
}

/**
 * Parse + validate the wrapped-key blob from FORMULA_VAULT.vault_location. The column is a
 * plain varchar an attacker with DB write could corrupt; we never feed an unchecked shape to
 * the cipher. Validates the three base64 fields exist and the iv/tag decode to GCM sizes
 * (12 / 16 bytes) before use.
 */
function parseWrappedKey(raw: string): WrappedKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NotFoundException('formula vault key material is corrupt');
  }
  const w = parsed as Partial<WrappedKey>;
  if (typeof w?.ciphertext !== 'string' || typeof w?.iv !== 'string' || typeof w?.tag !== 'string') {
    throw new NotFoundException('formula vault key material is malformed');
  }
  if (Buffer.from(w.iv, 'base64').length !== 12 || Buffer.from(w.tag, 'base64').length !== 16) {
    throw new NotFoundException('formula vault key material is malformed');
  }
  return { ciphertext: w.ciphertext, iv: w.iv, tag: w.tag };
}
