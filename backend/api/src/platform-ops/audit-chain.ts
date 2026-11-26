/**
 * B09 (STUB-075): the Platform console's audit-chain reading and its verify, the PURE half.
 *
 * The main box's one hash chain is `platform.audit_events` where `chain_seq` is set: every switch
 * change is appended there under one advisory lock (cluster-platform flags/flag-chain.ts, which
 * says how `row_hash = sha256(prev_hash || canonical(row))` is made). The Vault's chain is on the
 * Vault box, on its own connection, MAC'd with its KMS key, and is never read here.
 *
 * Walking it needs no key, so a person on the Platform console can ask "has any entry been edited
 * or deleted since it was written?" and get the first break by entry. These functions only READ:
 * nothing here, or in the service that feeds them, writes, repairs or re-hashes a row. A broken
 * chain stays broken and is named.
 *
 * Pure: no database, no clock. The service hands rows in, in `chain_seq` order.
 */
import { chainHash, type StoredChainRow } from '@core/cluster-platform';

export type ChainWalk =
  | { ok: true; rows: number; lastSeq: number | null; lastHash: string | null }
  | { ok: false; rows: number; firstBadSeq: number; reason: string };

/** Where a walk starts: the row before the first one handed in (none for the chain's start). */
export interface ChainStart {
  /** `chain_seq` the first row must carry (1 for the chain's start). */
  readonly expectedSeq: bigint;
  /** `row_hash` of the row before it (null for the chain's start). */
  readonly prevHash: string | null;
}

export const CHAIN_START: ChainStart = Object.freeze({ expectedSeq: 1n, prevHash: null });

/**
 * Walk `rows` (in `chain_seq` order) from `start`. Every row must take the next sequence, name the
 * row before it, and recompute to its own hash; the first that does not is the break. The reasons
 * are sentences a person reads, and carry no row content.
 */
export function walkChain(rows: readonly StoredChainRow[], start: ChainStart = CHAIN_START): ChainWalk {
  let prev = start.prevHash;
  let expected = start.expectedSeq;
  for (const r of rows) {
    if (r.chainSeq !== expected) {
      return { ok: false, rows: rows.length, firstBadSeq: Number(r.chainSeq),
        reason: r.chainSeq > expected
          ? `Entries ${expected} to ${r.chainSeq - 1n} are missing: an entry was deleted.`
          : `Entry ${r.chainSeq} repeats or goes backwards (expected ${expected}).` };
    }
    if ((r.prevHash ?? null) !== prev) {
      return { ok: false, rows: rows.length, firstBadSeq: Number(r.chainSeq), reason: `Entry ${r.chainSeq} does not name the entry before it.` };
    }
    if (chainHash(prev, r) !== r.rowHash) {
      return { ok: false, rows: rows.length, firstBadSeq: Number(r.chainSeq), reason: `Entry ${r.chainSeq} was changed after it was written: its hash does not recompute.` };
    }
    prev = r.rowHash;
    expected += 1n;
  }
  const last = rows.at(-1);
  return { ok: true, rows: rows.length, lastSeq: last ? Number(last.chainSeq) : null, lastHash: last ? last.rowHash : null };
}

/** A month of the chain, as the console's table shows it. Hashes, sequence numbers, counts and
 *  times only: never an actor, an action's content or a before/after value. */
export interface ChainSegment {
  /** `YYYY-MM`, the month in India time (Asia/Kolkata) the entries were written in. */
  readonly month: string;
  readonly entries: number;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly firstHash: string | null;
  readonly lastHash: string | null;
  /** true: walked on this read and intact; false: walked and broken; null: not walked (too long for
   *  a read: the verify walks it). */
  readonly verified: boolean | null;
  readonly firstBadSeq: number | null;
  readonly reason: string | null;
}

/** The longest segment a READ walks; a longer one is left to the verify, which walks in batches. */
export const SEGMENT_WALK_MAX = 20_000;
