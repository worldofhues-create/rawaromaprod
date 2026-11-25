/**
 * FEATURE-SWITCHES: the hash chain every switch change is written into, in `platform.audit_events`.
 *
 * `flag_audit` already kept who, when, from, to and why, but it is an ordinary table: a row can be
 * edited or deleted and nothing would say so. The platform schema's `audit_events` has shipped the
 * chain columns since Phase 1 (`chain_seq`, `prev_hash`, `row_hash`, data-kernel `auditTable`) and
 * nothing filled them on this box. A switch change is exactly the kind of act that must be
 * tamper-evident (turning `all.auth` off stops every password sign-in), so each one is appended
 * here as well, in the same transaction as the state it records.
 *
 *   row_hash = sha256(prev_hash || canonical(row))   canonical INCLUDES chain_seq
 *
 * so deleting the tail leaves a gap in `chain_seq`, and editing any row breaks its hash and every
 * hash after it. The main box holds no audit MAC key (the Vault's chain is MAC'd with its KMS key),
 * so this is a plain SHA-256 chain: it proves the rows were not changed after they were written
 * unless someone recomputed every hash after the change, which `verifyFlagChain` would not catch
 * on its own and the outbox event (`platform.flag.changed`, written in the same transaction) would.
 *
 * Pure: no database, no clock. The service hands the previous head in and gets the row back.
 */
import { createHash } from 'node:crypto';

/** One advisory lock serialises every append, so two changes never take the same `chain_seq`. */
export const FLAG_CHAIN_LOCK = 8473625190200001n;

export const FLAG_CHAIN_ACTION = 'flag.update';
export const FLAG_CHAIN_ENTITY = 'flags';

export interface ChainRow {
  chainSeq: bigint;
  /** A Date as written; a driver that reads timestamptz as text hands back the ISO string. */
  occurredAt: Date | string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
}

/** JSON with every object's keys sorted, at any depth: jsonb does not keep key order, so a hash
 *  over JSON.stringify would not recompute from the row as Postgres gives it back. */
export function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The bytes a row's hash covers, in a fixed order. */
export function canonicalChainRow(row: ChainRow): string {
  return stableJson([
    row.chainSeq.toString(), new Date(row.occurredAt).toISOString(), row.actorId, row.action,
    row.entityType, row.entityId, row.before ?? null, row.after ?? null,
  ]);
}

export function chainHash(prevHash: string | null, row: ChainRow): string {
  return createHash('sha256').update((prevHash ?? '') + canonicalChainRow(row)).digest('hex');
}

export interface StoredChainRow extends ChainRow {
  prevHash: string | null;
  rowHash: string | null;
}

export type ChainVerdict = { ok: true; rows: number } | { ok: false; rows: number; firstBadSeq: number; reason: string };

/** Walk the chain from its first row (rows in `chain_seq` order). The first break is named. */
export function verifyFlagChain(rows: readonly StoredChainRow[]): ChainVerdict {
  let prev: string | null = null;
  let expected = 1n;
  for (const r of rows) {
    if (r.chainSeq !== expected) {
      return { ok: false, rows: rows.length, firstBadSeq: Number(r.chainSeq), reason: `chain_seq gap or regression (expected ${expected}, got ${r.chainSeq})` };
    }
    if ((r.prevHash ?? null) !== prev) {
      return { ok: false, rows: rows.length, firstBadSeq: Number(r.chainSeq), reason: 'prev_hash does not name the row before it' };
    }
    if (chainHash(prev, r) !== r.rowHash) {
      return { ok: false, rows: rows.length, firstBadSeq: Number(r.chainSeq), reason: 'row_hash does not recompute: the row was changed after it was written' };
    }
    prev = r.rowHash;
    expected += 1n;
  }
  return { ok: true, rows: rows.length };
}
