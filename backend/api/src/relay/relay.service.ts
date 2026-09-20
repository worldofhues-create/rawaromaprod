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
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { sha256Hex, signCanonical, verifyCanonical } from './relay-crypto.js';
import {
  RELAY_SOURCE_SCHEMAS,
  allowedTypes,
  isForbiddenAcrossGap,
  isRelayDirection,
  type RelayDirection,
} from './relay-contract.js';
import { RELAY_HYDRATION } from './relay-hydration.js';

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

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

@Injectable()
export class RelayService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  private signingKey(): string {
    const k = process.env.RELAY_SIGNING_KEY;
    if (!k) throw new BadRequestException('RELAY_SIGNING_KEY is not configured — run scripts/relay-keygen.cjs and set it.');
    return k;
  }
  private verifyKey(): string {
    const k = process.env.RELAY_VERIFY_KEY;
    if (!k) throw new BadRequestException('RELAY_VERIFY_KEY is not configured — run scripts/relay-keygen.cjs and set it.');
    return k;
  }

  /* ── export ───────────────────────────────────────────────────────── */

  async exportPackage(direction: RelayDirection, commit: boolean): Promise<RelayPackage & { committed: boolean }> {
    const signingKey = this.signingKey();
    const types = allowedTypes(direction);
    const inList = types.map((t) => `'${t.replace(/'/g, "''")}'`).join(',');

    const curRows = (await this.sql`
      select source_schema, last_seq::text as last_seq
        from platform.relay_cursor where direction = ${direction}`) as Array<{ source_schema: string; last_seq: string }>;
    const cursor: Record<string, string> = {};
    curRows.forEach((r) => { cursor[r.source_schema] = r.last_seq; });

    const events: RelayEvent[] = [];
    const sources: Record<string, { fromSeq: number; toSeq: number }> = {};
    if (inList) {
      for (const s of RELAY_SOURCE_SCHEMAS) {
        const from = cursor[s] ?? '0';
        const rows = (await this.sql.unsafe(
          `select id, type, payload::text as payload, aggregate_id::text as aggregate_id,
                  occurred_at::text as occurred_at, seq::text as seq
             from ${s}.outbox
            where type in (${inList}) and seq > ${from}
            order by seq asc limit 500`,
        )) as Array<{ id: string; type: string; payload: string; aggregate_id: string | null; occurred_at: string; seq: string }>;
        if (!rows.length) continue;
        sources[s] = { fromSeq: Number(from), toSeq: Number(rows[rows.length - 1]!.seq) };
        for (const r of rows) {
          if (isForbiddenAcrossGap(r.type)) continue; // belt-and-suspenders; formula.* never leaves
          const ev: RelayEvent = { id: r.id, type: r.type, payload: safeJson(r.payload), aggregateId: r.aggregate_id, occurredAt: r.occurred_at, source: s };
          ev.entity = await this.hydrateEvent(ev); // carry the domain row(s) so the far side can materialize
          events.push(ev);
        }
      }
    }

    const prevRow = (await this.sql`
      select package_hash from platform.relay_package
       where direction = ${direction} and kind = 'EXPORT'
       order by created_dt desc limit 1`) as Array<{ package_hash: string }>;
    const prevPackageHash = prevRow[0]?.package_hash ?? null;

    const contentSha256 = sha256Hex(JSON.stringify(events));
    const manifest: RelayManifest = {
      packageId: randomUUID(),
      direction,
      createdAt: new Date().toISOString(),
      eventCount: events.length,
      sources,
      prevPackageHash,
      contentSha256,
      algo: 'ed25519',
    };
    const canonical = JSON.stringify(manifest);
    const signature = signCanonical(signingKey, canonical);
    const packageHash = sha256Hex(canonical);

    let committed = false;
    if (commit && events.length > 0) {
      // ONE transaction (audit G/#11): advance the cursors AND record the EXPORT package together,
      // so a crash between them can't advance the watermark past events that were never packaged.
      await this.sql.begin(async (tx) => {
        for (const [s, r] of Object.entries(sources)) {
          await tx`
            insert into platform.relay_cursor (direction, source_schema, last_seq, updated_dt)
            values (${direction}, ${s}, ${r.toSeq}, now())
            on conflict (direction, source_schema) do update set last_seq = ${r.toSeq}, updated_dt = now()`;
        }
        await tx`
          insert into platform.relay_package (package_id, direction, kind, package_hash, prev_hash, event_count)
          values (${manifest.packageId}, ${direction}, 'EXPORT', ${packageHash}, ${prevPackageHash}, ${events.length})
          on conflict (package_id, kind) do nothing`;
      });
      committed = true;
    }
    return { manifest, events, signature, committed };
  }

  /* ── import ───────────────────────────────────────────────────────── */

  async importPackage(pkg: RelayPackage): Promise<{
    packageId: string; direction: RelayDirection; eventCount: number; applied: number; skipped: number; materialized: number; status: string; chain: string;
  }> {
    const verifyKey = this.verifyKey();
    if (!pkg || typeof pkg !== 'object' || !pkg.manifest || !Array.isArray(pkg.events) || typeof pkg.signature !== 'string') {
      throw new BadRequestException('malformed package (need { manifest, events, signature }).');
    }
    const { manifest, events, signature } = pkg;
    if (!isRelayDirection(manifest.direction)) throw new BadRequestException(`unknown direction: ${manifest.direction}`);

    // 1) integrity — content hash must match the manifest.
    const contentSha256 = sha256Hex(JSON.stringify(events));
    if (contentSha256 !== manifest.contentSha256) throw new BadRequestException('content hash mismatch — package tampered or corrupted.');

    // 2) authenticity — Ed25519 signature over the canonical manifest.
    const canonical = JSON.stringify(manifest);
    if (!verifyCanonical(verifyKey, canonical, signature)) throw new BadRequestException('signature verification failed.');

    // 3) contract — no secret/forbidden events may cross.
    const bad = events.find((e) => isForbiddenAcrossGap(e.type));
    if (bad) throw new BadRequestException(`forbidden event type across the gap: ${bad.type}`);

    // 4) idempotency — a package already imported is a no-op (re-import safe).
    const already = await this.sql`
      select 1 from platform.relay_package
       where package_id = ${manifest.packageId} and kind = 'IMPORT' limit 1`;
    if (already.length) {
      return { packageId: manifest.packageId, direction: manifest.direction, eventCount: events.length, applied: 0, skipped: events.length, materialized: 0, status: 'already-imported', chain: 'ok' };
    }

    // 5) chain continuity vs our last import for this direction.
    const lastRow = (await this.sql`
      select package_hash from platform.relay_package
       where direction = ${manifest.direction} and kind = 'IMPORT'
       order by created_dt desc limit 1`) as Array<{ package_hash: string }>;
    const lastImportHash = lastRow[0]?.package_hash ?? null;
    let chain: 'ok' | 'bootstrapped' = 'bootstrapped';
    if (lastImportHash) {
      if (manifest.prevPackageHash !== lastImportHash) {
        throw new BadRequestException('chain break — prevPackageHash does not match the last imported package (gap or reorder).');
      }
      chain = 'ok';
    } else if (manifest.prevPackageHash) {
      // First import for this direction must be the genesis package (audit G/#11): starting
      // mid-chain means continuity back to the origin can't be verified.
      throw new BadRequestException('first import must be the genesis package (prevPackageHash null) — cannot bootstrap mid-chain.');
    }

    // 6+7) apply — in ONE transaction: dedupe-insert each event into the inbox ledger AND
    // materialize its carried entity (idempotent upsert by pk), then record the import in the
    // chain. All-or-nothing, so a failed apply rolls back and the package can be re-imported safely.
    const packageHash = sha256Hex(canonical);
    let applied = 0;
    let skipped = 0;
    let materialized = 0;
    await this.sql.begin(async (tx) => {
      for (const e of events) {
        const res = await tx`
          insert into platform.relay_inbox (event_id, package_id, event_type, direction)
          values (${e.id}, ${manifest.packageId}, ${e.type}, ${manifest.direction})
          on conflict (event_id) do nothing returning event_id`;
        if (res.length) {
          applied++;
          materialized += await this.applyEntity(tx as unknown as Sql, e);
        } else {
          skipped++;
        }
      }
      await tx`
        insert into platform.relay_package (package_id, direction, kind, package_hash, prev_hash, event_count)
        values (${manifest.packageId}, ${manifest.direction}, 'IMPORT', ${packageHash}, ${lastImportHash}, ${events.length})
        on conflict (package_id, kind) do nothing`;
    });

    return { packageId: manifest.packageId, direction: manifest.direction, eventCount: events.length, applied, skipped, materialized, status: 'imported', chain };
  }

  /* ── hydrate (export) / apply (import) ────────────────────────────── */

  /** Fetch the domain row(s) an event carries so the destination can rebuild the record. */
  private async hydrateEvent(ev: RelayEvent): Promise<RelayEntity | null> {
    const spec = RELAY_HYDRATION[ev.type];
    if (!spec || !ev.aggregateId) return null;
    const primary = (
      await this.sql.unsafe(
        `select * from ${spec.schema}.${spec.table} where "${spec.pk}" = $1 limit 1`,
        [ev.aggregateId],
      )
    )[0] as Record<string, unknown> | undefined;
    const children: Record<string, Record<string, unknown>[]> = {};
    if (spec.children) {
      for (const c of spec.children) {
        children[`${c.schema}.${c.table}`] = (await this.sql.unsafe(
          `select * from ${c.schema}.${c.table} where "${c.fk}" = $1`,
          [ev.aggregateId],
        )) as unknown as Record<string, unknown>[];
      }
    }
    return { primary: primary ?? null, children };
  }

  /** Materialize a carried entity on the destination: upsert primary then children. Returns rows written. */
  private async applyEntity(tx: Sql, ev: RelayEvent): Promise<number> {
    const spec = RELAY_HYDRATION[ev.type];
    if (!spec || !ev.entity) return 0;
    let n = 0;
    if (ev.entity.primary) { await this.upsertRow(tx, spec.schema, spec.table, spec.pk, ev.entity.primary); n++; }
    if (spec.children) {
      for (const c of spec.children) {
        for (const row of ev.entity.children?.[`${c.schema}.${c.table}`] ?? []) {
          await this.upsertRow(tx, c.schema, c.table, c.pk, row);
          n++;
        }
      }
    }
    return n;
  }

  /** Generic idempotent upsert of a full row by primary key (identifiers come from the registry + DB columns, not user input). */
  private async upsertRow(tx: Sql, schema: string, table: string, pk: string, row: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(row);
    if (!cols.length) return;
    const colList = cols.map((c) => `"${c}"`).join(', ');
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    const upd = cols.filter((c) => c !== pk).map((c) => `"${c}" = excluded."${c}"`).join(', ');
    await tx.unsafe(
      `insert into ${schema}.${table} (${colList}) values (${ph}) on conflict ("${pk}") ${upd ? `do update set ${upd}` : 'do nothing'}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cols.map((c) => row[c]) as any[],
    );
  }

  /* ── status ───────────────────────────────────────────────────────── */

  async status() {
    const cursors = (await this.sql`
      select direction, source_schema, last_seq::text as last_seq, updated_dt
        from platform.relay_cursor order by direction, source_schema`) as Array<Record<string, unknown>>;
    const inbox = (await this.sql`
      select direction, count(*)::int as count from platform.relay_inbox group by direction`) as Array<Record<string, unknown>>;
    const packages = (await this.sql`
      select direction, kind, count(*)::int as count, max(created_dt) as last
        from platform.relay_package group by direction, kind order by direction, kind`) as Array<Record<string, unknown>>;

    // pending-to-export per direction (how much is waiting to cross).
    const pending: Record<string, number> = {};
    for (const direction of ['online-to-offline', 'offline-to-online'] as RelayDirection[]) {
      const types = allowedTypes(direction);
      const inList = types.map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
      const cur: Record<string, string> = {};
      (cursors as Array<{ direction: string; source_schema: string; last_seq: string }>)
        .filter((c) => c.direction === direction)
        .forEach((c) => { cur[c.source_schema] = c.last_seq; });
      let total = 0;
      if (inList) {
        for (const s of RELAY_SOURCE_SCHEMAS) {
          const from = cur[s] ?? '0';
          const row = (await this.sql.unsafe(
            `select count(*)::int as c from ${s}.outbox where type in (${inList}) and seq > ${from}`,
          )) as Array<{ c: number }>;
          total += row[0]?.c ?? 0;
        }
      }
      pending[direction] = total;
    }
    return { cursors, inbox, packages, pending };
  }
}
