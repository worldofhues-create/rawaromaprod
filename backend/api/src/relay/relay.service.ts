/**
 * RelayService — the store-and-forward air-gap crossing. The two consoles never connect; this
 * drains one side's transactional outboxes into a SIGNED, hash-chained package and applies such a
 * package on the other side, deduping by event id. It reads raw across the schema-per-cluster
 * outboxes (the proven second-consumer pattern, like the email notifier) over PG_CLIENT.
 *
 *   exportPackage(direction, commit) — collect allow-listed events past the per-schema cursor →
 *     build manifest (content sha256 + prev-package hash) → Ed25519-sign. commit advances the
 *     cursor + logs the EXPORT package; commit=false is a non-destructive "peek".
 *   importPackage(pkg) — verify content hash + signature + forbidden-type + chain continuity →
 *     dedupe-insert each event into relay_inbox (ON CONFLICT DO NOTHING) → log the IMPORT package.
 *     Idempotent: re-importing the same package is a no-op.
 *
 * Only signed event envelopes cross. Never a DB connection, never the KEK, never a recipe
 * (formula.* is stripped by the contract and the formula schema is never scanned).
 *
 * NOT AVAILABLE (lane F5, RP-DEADTABLES): every public method here depends on
 * platform.relay_cursor, platform.relay_inbox, and/or platform.relay_package — none of which
 * exist in @core/data-platform or @ra/data-reference (the only sources `pnpm db:push` draws the
 * `platform` schema from, per scripts/db-schema-groups.ts) or the Phase-1A Data Dictionary. Any
 * real/dev database would 500 with "relation does not exist" the instant any of these ran — dead
 * calls dressed up as a working air-gap sync. Per CLAUDE.md C3 (no destructive migration;
 * additive schema only if the dictionary process permits it — report if locked), new tables are
 * NOT added here. exportPackage/importPackage/status now throw an honest NotImplementedException.
 * The export/import/status implementation (signing, chain verification, hydration, apply) is
 * removed rather than kept as unreachable code; restore it from integration/fullsystem@db4815f
 * (this file) once the tables exist. relay-contract/relay-crypto/relay-hydration are untouched.
 * Unblocking it needs: `relay_cursor` (direction, source_schema, last_seq, updated_dt — PK
 * direction+source_schema), `relay_inbox` (event dedupe by id + direction), and `relay_package`
 * (package_id, direction, kind, package_hash, prev_hash, event_count, created_dt) added to the
 * Phase-1A dictionary + @ra/data-reference (or @core/data-platform) schema, then db:push.
 */
import { Injectable, NotImplementedException } from '@nestjs/common';
import type { RelayDirection } from './relay-contract.js';

/** The domain row(s) an event carries so the destination can materialize the record. */
export interface RelayEntity {
  primary: Record<string, unknown> | null;
  children: Record<string, Record<string, unknown>[]>;
}
export interface RelayEvent {
  id: string;
  type: string;
  payload: unknown;
  aggregateId: string | null;
  occurredAt: string;
  source: string;
  entity?: RelayEntity | null;
}
export interface RelayManifest {
  packageId: string;
  direction: RelayDirection;
  createdAt: string;
  eventCount: number;
  sources: Record<string, { fromSeq: number; toSeq: number }>;
  prevPackageHash: string | null;
  contentSha256: string;
  algo: 'ed25519';
}
export interface RelayPackage {
  manifest: RelayManifest;
  events: RelayEvent[];
  signature: string;
}

const UNAVAILABLE =
  'Relay (air-gap sync) is not available: its backing tables (platform.relay_cursor, platform.relay_inbox, platform.relay_package) were never added to the Phase-1A Data Dictionary or @core/data-platform / @ra/data-reference schema, so they do not exist in any real database. Ask the data team to add them to the dictionary before this feature can go live.';

@Injectable()
export class RelayService {
  async exportPackage(_direction: RelayDirection, _commit: boolean): Promise<RelayPackage & { committed: boolean }> {
    throw new NotImplementedException(UNAVAILABLE);
  }

  async importPackage(_pkg: RelayPackage): Promise<{
    packageId: string; direction: RelayDirection; eventCount: number; applied: number; skipped: number; materialized: number; status: string; chain: string;
  }> {
    throw new NotImplementedException(UNAVAILABLE);
  }

  async status(): Promise<never> {
    throw new NotImplementedException(UNAVAILABLE);
  }
}
