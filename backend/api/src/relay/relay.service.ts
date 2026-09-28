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
 * NOT AVAILABLE on this deployment. The tables now exist (scripts/migrations/0018_adhoc_relay_
 * tables.sql, on production since 2026-09-24), but the export/import/status implementation
 * (signing, chain verification, hydration, apply) was removed by lane F5 (RP-DEADTABLES,
 * 2026-09-23) while they did not, and production crosses between RawProd and ALEMBIC through the
 * signed bridge instead. Restoring air-gap sync means restoring that implementation from
 * integration/fullsystem@db4815f (this file) and re-reviewing it — a feature decision, not a
 * wiring fix — so the methods keep refusing, now with plain user copy (lane platform-roles,
 * 2026-09-28). relay-contract/relay-crypto/relay-hydration are untouched.
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

const UNAVAILABLE = "Air-gap sync isn't available on this deployment.";

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
