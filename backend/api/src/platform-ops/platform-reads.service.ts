/**
 * PlatformReadsService (B09, STUB-075): four of the five readings the RAC OS Platform console asked
 * for and RawProd did not have. Each was answered "The Factory does not send this" by the RAC OS
 * relay until now (RAC OS apps/api/src/rawprod-relay/allow-list.ts RELAY_NOT_SENT).
 *
 *   vaultHealth()   GET /v1/platform/vault-health. The main box's link to the Vault: whether this box
 *                   has one configured, whether the Vault answered its own `GET /health` over it
 *                   (vault-bridge/vault-health.controller.ts, on the Vault box), what it said, and
 *                   how long it took. Never the Vault's address and never the bridge key.
 *   outbox()        GET /v1/bridge/outbox?state=parked|all&q=&cursor=&limit=. The RawProd -> RAC OS
 *                   events, parked ones first (the dead-letter list bridge.controller.ts already
 *                   serves at /v1/bridge/outbox/parked) or all of them, newest first. Type, the id of
 *                   what it is about, times, attempts and why it parked, as a code. Never the
 *                   payload, and the stored error only when it is RawProd's own `http_<status>:
 *                   <CODE>` form (contract.ts describeFailure); a network error is reduced to the
 *                   word "network", since a socket error can carry a host name.
 *   auditChain()    GET /v1/platform/audit-chain?cursor=&limit=. The main box's hash chain
 *                   (platform.audit_events, chain_seq set) by month, newest first: entries, first and
 *                   last sequence, time and hash, and the walk of each month on this read.
 *   verifyChain()   POST /v1/platform/audit-chain/verify. Walks the whole chain from entry 1 in
 *                   batches and reports the first break. It recomputes and compares; it NEVER
 *                   repairs, re-hashes or deletes anything (audit-chain.ts).
 *
 * All four read only, and every list is paged. None reads a business row, a person's name or
 * email, or a formula: the chain is read for its hashes, sequence numbers and times; its actor and
 * its before/after values are hashed here and never returned.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';
import { ConfigService, PG_CLIENT } from '@core/backend-kernel';
import type { StoredChainRow } from '@core/cluster-platform';
import { CHAIN_START, SEGMENT_WALK_MAX, walkChain, type ChainSegment, type ChainStart } from './audit-chain.js';

/** How long the main box waits for the Vault's `/health` before calling the link down. */
export const VAULT_HEALTH_TIMEOUT_MS = 3_000;
/** A page of the outbox list, as RawProd's other lists page (limit, and an offset cursor). */
export const OUTBOX_PAGE_DEFAULT = 12;
export const OUTBOX_PAGE_MAX = 100;
export const CHAIN_PAGE_DEFAULT = 12;
export const CHAIN_PAGE_MAX = 60;
/** The verify walks the chain this many entries at a time, so a long chain never sits in memory. */
export const VERIFY_BATCH = 1_000;

export interface VaultLink {
  /** This box has VAULT_API_INTERNAL_URL set. */
  configured: boolean;
  /** The Vault answered (null when there is no link to try). */
  reachable: boolean | null;
  /** The Vault's own verdict from its `/health`: 'ok' | 'degraded', or null when it gave none. */
  status: 'ok' | 'degraded' | null;
  /** The Vault's dependencies as it reported them, up or down (its formula database today). */
  deps: Record<string, 'up' | 'down'>;
  httpStatus: number | null;
  latencyMs: number | null;
  at: string;
  note: string;
}

export type OutboxState = 'parked' | 'waiting' | 'delivered' | 'discarded';
export interface OutboxEvent {
  id: string;
  type: string;
  aggregateId: string | null;
  occurredAt: string;
  publishedAt: string | null;
  state: OutboxState;
  attempts: number;
  parkedAt: string | null;
  parkedReason: string | null;
  lastHttpStatus: number | null;
  /** `http_<status>: <CODE>`, `network`, or null: never free text. */
  lastError: string | null;
}
export interface OutboxPage {
  state: 'parked' | 'all';
  events: OutboxEvent[];
  /** Events matching this state and search, across every page. */
  total: number;
  /** Parked events, whatever the search. */
  parkedTotal: number;
  nextCursor: string | null;
}

export interface ChainPage {
  chain: 'platform.audit_events';
  algorithm: 'sha256';
  /** Chained entries in all. */
  rows: number;
  headSeq: number | null;
  headHash: string | null;
  segments: ChainSegment[];
  /** Months in all. */
  total: number;
  nextCursor: string | null;
  /** When every month on this page was walked, the time of this read; otherwise null. */
  verifiedAt: string | null;
  note: string;
}

export type ChainVerdict =
  | { ok: true; rows: number; headSeq: number | null; verifiedAt: string; note: string }
  | { ok: false; rows: number; firstBadSeq: number; reason: string; month: string | null; verifiedAt: string; note: string };

const CHAIN_NOTE =
  'Each entry carries the hash of the one before, so an edited or deleted entry breaks the chain from there on. ' +
  'Deleting the newest entries leaves no break: the switch change each one records is also an outbox event to RAC OS. ' +
  'The Vault keeps its own chain on its own box; it is not read here.';

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
/** A whole number in [min, max], or `dflt` when the input is not one. */
export function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : typeof v === 'number' && Number.isInteger(v) ? v : NaN;
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
}
/** The stored delivery error, only in RawProd's own coded form (bridge/contract.ts describeFailure). */
export function safeDeliveryError(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null;
  if (/^http_\d{3}(: [A-Za-z0-9_]{1,64})?$/.test(v)) return v;
  if (v.startsWith('network')) return 'network';
  return null;
}
/** A search over event types: letters, digits and . _ - only, so it is never a pattern. */
export function outboxSearch(q: unknown): string | null {
  if (typeof q !== 'string') return null;
  const t = q.trim().slice(0, 80);
  return /^[A-Za-z0-9._-]+$/.test(t) ? t : null;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

@Injectable()
export class PlatformReadsService {
  /** The transport for the Vault's `/health`; a test replaces it. */
  fetchImpl: Fetch = (url, init) => fetch(url, init);
  /** The clock; a test replaces it. */
  now: () => Date = () => new Date();

  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    private readonly config: ConfigService,
  ) {}

  async vaultHealth(): Promise<VaultLink> {
    const at = this.now().toISOString();
    const base = this.config.get('VAULT_API_INTERNAL_URL');
    const none = { status: null, httpStatus: null, latencyMs: null, at };
    if (!base) {
      return { configured: false, reachable: null, ...none, deps: {},
        note: 'This box has no link to the Vault configured (VAULT_API_INTERNAL_URL is not set), so it cannot ask it.' };
    }
    const t0 = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${String(base).replace(/\/+$/, '')}/health`, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(VAULT_HEALTH_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = (err as { name?: string } | null)?.name === 'TimeoutError';
      return { configured: true, reachable: false, ...none, deps: {},
        note: timedOut ? `The Vault did not answer within ${VAULT_HEALTH_TIMEOUT_MS / 1000} s.` : 'The Vault could not be reached from this box.' };
    }
    const latencyMs = Date.now() - t0;
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    /* the Vault's answer, inside its own envelope or bare */
    const rep = (body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body) as Record<string, unknown> | null;
    const status = rep && (rep.status === 'ok' || rep.status === 'degraded') ? rep.status : null;
    const deps: Record<string, 'up' | 'down'> = {};
    if (rep && rep.deps && typeof rep.deps === 'object') {
      for (const [k, v] of Object.entries(rep.deps as Record<string, unknown>)) {
        if (/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(k) && (v === 'up' || v === 'down')) deps[k] = v;
      }
    }
    const note = !res.ok ? `The Vault answered ${res.status}.`
      : status === 'ok' ? 'The Vault answered: every dependency it checks is up.'
        : status === 'degraded' ? 'The Vault answered, and something it depends on is down.'
          : 'The Vault answered without a verdict.';
    return { configured: true, reachable: true, status: res.ok ? status : null, deps, httpStatus: res.status, latencyMs, at, note };
  }

  async outbox(input: { state?: unknown; q?: unknown; cursor?: unknown; limit?: unknown }): Promise<OutboxPage> {
    const sql = this.sql;
    const state: 'parked' | 'all' = input.state === 'all' ? 'all' : 'parked';
    const limit = clampInt(input.limit, OUTBOX_PAGE_DEFAULT, 1, OUTBOX_PAGE_MAX);
    const offset = clampInt(input.cursor, 0, 0, 1_000_000);
    const q = outboxSearch(input.q);
    const parked = sql`d.parked_at is not null and d.discarded_at is null and o.published_at is null`;
    const where = state === 'parked'
      ? (q ? sql`where ${parked} and position(lower(${q}) in lower(o.type)) > 0` : sql`where ${parked}`)
      : (q ? sql`where position(lower(${q}) in lower(o.type)) > 0` : sql``);
    const order = state === 'parked' ? sql`order by d.parked_at, o.occurred_at, o.id` : sql`order by o.occurred_at desc, o.id desc`;
    const rows = await sql<Array<{
      id: string; type: string | null; aggregate_id: string | null; occurred_at: Date; published_at: Date | null;
      attempts: number | null; parked_at: Date | null; parked_reason: string | null; last_error: string | null;
      last_http_status: number | null; discarded_at: Date | null;
    }>>`
      select o.id::text as id, o.type, o.aggregate_id::text as aggregate_id, o.occurred_at, o.published_at,
             coalesce(d.attempts, o.attempts) as attempts, d.parked_at, d.parked_reason, d.last_error,
             d.last_http_status, d.discarded_at
        from bridge.outbox o left join bridge.outbox_delivery d on d.outbox_id = o.id
        ${where} ${order}
       limit ${limit + 1} offset ${offset}`;
    const [counted] = await sql<Array<{ total: number }>>`
      select count(*)::int as total from bridge.outbox o left join bridge.outbox_delivery d on d.outbox_id = o.id ${where}`;
    const [parkedRow] = await sql<Array<{ parked_total: number }>>`
      select count(*)::int as parked_total from bridge.outbox o join bridge.outbox_delivery d on d.outbox_id = o.id where ${parked}`;
    const page = rows.slice(0, limit);
    return {
      state,
      events: page.map((r) => ({
        id: r.id, type: r.type ?? '', aggregateId: r.aggregate_id, occurredAt: iso(r.occurred_at)!, publishedAt: iso(r.published_at),
        state: r.published_at ? 'delivered' : r.discarded_at ? 'discarded' : r.parked_at ? 'parked' : 'waiting',
        attempts: Number(r.attempts ?? 0), parkedAt: iso(r.parked_at), parkedReason: r.parked_reason,
        lastHttpStatus: r.last_http_status == null ? null : Number(r.last_http_status), lastError: safeDeliveryError(r.last_error),
      })),
      total: Number(counted?.total ?? 0), parkedTotal: Number(parkedRow?.parked_total ?? 0),
      nextCursor: rows.length > limit ? String(offset + limit) : null,
    };
  }

  /** `chain_seq` from..to of the chain, in order, as the walk reads them. */
  private async chainRows(from: bigint, to: bigint | null, max: number): Promise<StoredChainRow[]> {
    const rows = await this.sql<Array<{
      chain_seq: string; occurred_at: Date; actor_id: string | null; action: string; entity_type: string;
      entity_id: string | null; before: unknown; after: unknown; prev_hash: string | null; row_hash: string | null;
    }>>`
      select chain_seq::text as chain_seq, occurred_at, actor_id::text as actor_id, action, entity_type, entity_id::text as entity_id,
             before, after, prev_hash, row_hash
        from platform.audit_events
       where chain_seq is not null and chain_seq >= ${from.toString()}::bigint
             ${to === null ? this.sql`` : this.sql`and chain_seq <= ${to.toString()}::bigint`}
       order by chain_seq
       limit ${max}`;
    return rows.map((r) => ({ chainSeq: BigInt(r.chain_seq), occurredAt: r.occurred_at, actorId: r.actor_id, action: r.action,
      entityType: r.entity_type, entityId: r.entity_id, before: r.before, after: r.after, prevHash: r.prev_hash, rowHash: r.row_hash }));
  }

  /** Where a walk of the entries from `seq` starts: the hash of entry seq-1, which must exist. */
  private async startAt(seq: bigint): Promise<ChainStart | { missing: true }> {
    if (seq <= 1n) return CHAIN_START;
    const [prev] = await this.sql<Array<{ row_hash: string | null }>>`
      select row_hash from platform.audit_events where chain_seq = ${(seq - 1n).toString()}::bigint`;
    return prev ? { expectedSeq: seq, prevHash: prev.row_hash } : { missing: true };
  }

  async auditChain(input: { cursor?: unknown; limit?: unknown }): Promise<ChainPage> {
    const sql = this.sql;
    const limit = clampInt(input.limit, CHAIN_PAGE_DEFAULT, 1, CHAIN_PAGE_MAX);
    const offset = clampInt(input.cursor, 0, 0, 100_000);
    const [head] = await sql<Array<{ rows: number; head_seq: string | null }>>`
      select count(*)::int as rows, max(chain_seq)::text as head_seq from platform.audit_events where chain_seq is not null`;
    const headSeq = head?.head_seq ? Number(head.head_seq) : null;
    const [headRow] = headSeq === null ? [] : await sql<Array<{ row_hash: string | null }>>`
      select row_hash from platform.audit_events where chain_seq = ${String(head!.head_seq)}::bigint`;
    const groups = await sql<Array<{
      month: string; entries: number; first_seq: string; last_seq: string; first_at: Date; last_at: Date;
      first_hash: string | null; last_hash: string | null; total: number;
    }>>`
      with seg as (
        select to_char(occurred_at at time zone 'Asia/Kolkata', 'YYYY-MM') as month, count(*)::int as entries,
               min(chain_seq) as first_seq, max(chain_seq) as last_seq, min(occurred_at) as first_at, max(occurred_at) as last_at
          from platform.audit_events where chain_seq is not null group by 1)
      select seg.month, seg.entries, seg.first_seq::text as first_seq, seg.last_seq::text as last_seq, seg.first_at, seg.last_at,
             (select a.row_hash from platform.audit_events a where a.chain_seq = seg.first_seq) as first_hash,
             (select a.row_hash from platform.audit_events a where a.chain_seq = seg.last_seq) as last_hash,
             count(*) over ()::int as total
        from seg order by seg.month desc limit ${limit} offset ${offset}`;
    const segments: ChainSegment[] = [];
    for (const g of groups) {
      const first = BigInt(g.first_seq), last = BigInt(g.last_seq);
      let verified: boolean | null = null, firstBadSeq: number | null = null, reason: string | null = null;
      if (g.entries <= SEGMENT_WALK_MAX) {
        const start = await this.startAt(first);
        if ('missing' in start) {
          verified = false; firstBadSeq = Number(first); reason = `Entry ${first - 1n} is missing: an entry was deleted.`;
        } else {
          const walk = walkChain(await this.chainRows(first, last, SEGMENT_WALK_MAX + 1), start);
          verified = walk.ok;
          if (!walk.ok) { firstBadSeq = walk.firstBadSeq; reason = walk.reason; }
        }
      }
      segments.push({ month: g.month, entries: Number(g.entries), firstSeq: Number(first), lastSeq: Number(last),
        firstAt: iso(g.first_at)!, lastAt: iso(g.last_at)!, firstHash: g.first_hash, lastHash: g.last_hash, verified, firstBadSeq, reason });
    }
    const total = groups[0]?.total ?? (offset === 0 ? 0 : (await sql<Array<{ n: number }>>`
      select count(distinct to_char(occurred_at at time zone 'Asia/Kolkata', 'YYYY-MM'))::int as n from platform.audit_events where chain_seq is not null`)[0]!.n);
    return {
      chain: 'platform.audit_events', algorithm: 'sha256', rows: Number(head?.rows ?? 0), headSeq, headHash: headRow?.row_hash ?? null,
      segments, total: Number(total), nextCursor: offset + segments.length < Number(total) ? String(offset + segments.length) : null,
      verifiedAt: segments.length > 0 && segments.every((s) => s.verified !== null) ? this.now().toISOString() : null,
      note: CHAIN_NOTE,
    };
  }

  async verifyChain(): Promise<ChainVerdict> {
    let start: ChainStart = CHAIN_START;
    let rows = 0;
    let headSeq: number | null = null;
    for (;;) {
      /* from the lowest entry on the first batch, so a deleted entry 1 is a gap the walk names */
      const batch = await this.chainRows(rows === 0 ? 0n : start.expectedSeq, null, VERIFY_BATCH);
      if (batch.length === 0) break;
      const walk = walkChain(batch, start);
      if (!walk.ok) {
        const seen = rows + batch.findIndex((r) => Number(r.chainSeq) === walk.firstBadSeq) + 1;
        const bad = batch.find((r) => Number(r.chainSeq) === walk.firstBadSeq);
        const month = bad ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date(bad.occurredAt)) : null;
        return { ok: false, rows: seen, firstBadSeq: walk.firstBadSeq, reason: walk.reason, month, verifiedAt: this.now().toISOString(), note: CHAIN_NOTE };
      }
      rows += walk.rows;
      headSeq = walk.lastSeq;
      start = { expectedSeq: BigInt(walk.lastSeq!) + 1n, prevHash: walk.lastHash };
      if (batch.length < VERIFY_BATCH) break;
    }
    return { ok: true, rows, headSeq, verifiedAt: this.now().toISOString(), note: CHAIN_NOTE };
  }
}
