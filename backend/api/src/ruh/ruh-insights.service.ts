/**
 * RuhInsightsService — the insight store (platform.ruh_insight) behind the Ruh panel on every
 * console, and its mirror to ALEMBIC (C3, via RuhSignalService's durable queue).
 *
 *   sync        the watch engine's result for the kinds it just checked: a new finding opens an
 *               insight, a changed one is updated in place, a finding that is gone closes its
 *               insight ("cleared") — and each of those, for a mirrored kind, queues a C3 signal or
 *               resolve in the same transaction. A person's "done"/"dismiss" is respected: the same
 *               finding does not reopen until it clears and comes back, or gets more serious.
 *   list        the caller's insights (their roles; owner sees all), most serious first, with a
 *               `rev` so a console polls cheaply ("nothing after rev N").
 *   act         snooze / done / dismiss, by someone the insight is for; audited.
 *   override    a person continued past a Ruh warning: an URGENT insight for the admins, an audit
 *               row, and a C3 signal carrying `override` (ALEMBIC emails every active admin).
 *
 * Raw SQL on the shared pool, written for the Drizzle-wrapped client too (timestamps bound as ISO
 * text and read back as Date | string; jsonb sent as text).
 */
import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { isoOf } from '../pg-timestamp.js';
import {
  OVERRIDE_AUDIENCE, SEES_ALL_ROLES, SEVERITY_RANK, absoluteLink, toC3Signal,
  type C3Override, type C3Signal, type ConsoleLinks, type InsightDraft, type Risk, type RuhConsole, type RuhSeverity, type RuhSubject,
} from './ruh.contract.js';
import { RuhSettingsService, linksOf } from './ruh-settings.service.js';
import { RuhSignalService } from './ruh-signal.service.js';

type Q = Sql | TransactionSql;

/** Serialises concurrent syncs (the worker, a "Run now"). */
const SYNC_LOCK = 61_806_2026;

export interface InsightRow {
  id: string;
  kind: string;
  severity: RuhSeverity;
  audienceRoles: string[];
  console: RuhConsole;
  subject: RuhSubject;
  title: string;
  body: string;
  deepLink: string | null;
  prediction: unknown;
  source: 'detector' | 'override';
  dedupeKey: string;
  mirror: boolean;
  status: 'open' | 'snoozed' | 'done' | 'dismissed';
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  rev: number;
}

interface RawRow {
  ruh_insight_id: string; kind: string; severity: string; audience_roles: string[] | string; console: string;
  subject: unknown; title: string; body: string; deep_link: string | null; prediction: unknown; source: string;
  dedupe_key: string; mirror: boolean; status: string; snoozed_until: Date | string | null;
  created_at: Date | string; updated_at: Date | string; rev: string | number; resolved_at: Date | string | null;
}

const COLS = `ruh_insight_id::text, kind, severity, audience_roles, console, subject, title, body, deep_link, prediction,
  source, dedupe_key, mirror, status, snoozed_until, created_at, updated_at, rev, resolved_at`;

function pgArray(v: string[] | string): string[] {
  if (Array.isArray(v)) return v;
  const inner = String(v).replace(/^\{|\}$/g, '');
  return inner ? inner.split(',').map((s) => s.replace(/^"|"$/g, '')) : [];
}
const textArray = (roles: readonly string[]) => `{${roles.map((r) => `"${r.replace(/["\\{},]/g, '')}"`).join(',')}}`;
const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

function rowOf(r: RawRow): InsightRow {
  return {
    id: r.ruh_insight_id, kind: r.kind, severity: r.severity as RuhSeverity, audienceRoles: pgArray(r.audience_roles),
    console: r.console as RuhConsole, subject: (r.subject ?? { type: 'none' }) as RuhSubject, title: r.title, body: r.body,
    deepLink: r.deep_link, prediction: r.prediction ?? null, source: r.source as InsightRow['source'], dedupeKey: r.dedupe_key,
    mirror: !!r.mirror, status: r.status as InsightRow['status'], snoozedUntil: r.snoozed_until ? isoOf(r.snoozed_until) : null,
    createdAt: isoOf(r.created_at), updatedAt: isoOf(r.updated_at), rev: Number(r.rev),
  };
}

/** JSON with sorted keys (jsonb hands objects back in its own key order). */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** Did a re-detection change anything a person (or ALEMBIC) would see? */
export function contentChanged(row: InsightRow, d: InsightDraft): boolean {
  return row.severity !== d.severity || row.title !== d.title || row.body !== d.body || row.deepLink !== d.deepLink
    || canonical(row.prediction ?? null) !== canonical(d.prediction ?? null)
    || row.audienceRoles.join(',') !== d.audienceRoles.join(',');
}

export interface SyncResult { opened: number; updated: number; cleared: number }

@Injectable()
export class RuhInsightsService {
  private readonly logger = new Logger(RuhInsightsService.name);

  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    private readonly settings: RuhSettingsService,
    private readonly signals: RuhSignalService,
  ) {}

  /** The C3 form of an insight, or null when it may not leave this box (vaultSafe refused it). */
  private signalFor(d: InsightDraft, links: ConsoleLinks, override?: C3Override): C3Signal | null {
    try {
      return toC3Signal(d, links, override);
    } catch (err) {
      this.logger.error(`ruh signal for ${d.kind} not sent: ${(err as Error).message}`);
      return null;
    }
  }

  private async queueSignal(tx: Q, d: InsightDraft, links: ConsoleLinks, override?: C3Override): Promise<void> {
    let signal = this.signalFor(d, links, override);
    if (!signal && override) {
      // Every override reaches the admins. If the typed reason itself is what may not leave the
      // Vault, the reason stays in the Vault's audit trail and the alert says where to read it.
      const withheld = 'The reason is kept in the Vault audit trail.';
      signal = this.signalFor({ ...d, body: d.body.replace(/Reason given: “[\s\S]*?”\./, withheld) }, links, { ...override, reason: withheld });
    }
    if (signal) await this.signals.enqueueSignal(tx, signal);
  }

  private sees(principal: AuthPrincipal, audience: readonly string[]): boolean {
    const roles = principal.roles ?? [];
    return roles.some((r) => SEES_ALL_ROLES.includes(r)) || audience.some((a) => roles.includes(a));
  }

  /* ── the watch engine's write ───────────────────────────────────────────────────────── */

  /** Apply one detector pass for `kinds` (only those: a detector that failed this tick keeps its insights). */
  async sync(kinds: readonly string[], drafts: readonly InsightDraft[], nowIso: string = new Date().toISOString()): Promise<SyncResult> {
    if (kinds.length === 0) return { opened: 0, updated: 0, cleared: 0 };
    const s = await this.settings.get();
    const links = linksOf(s);
    const mirrorOn = s['signals.enabled'];
    const result: SyncResult = { opened: 0, updated: 0, cleared: 0 };
    const unique = new Map<string, InsightDraft>();
    for (const d of drafts) if (kinds.includes(d.kind)) unique.set(d.dedupeKey, d);

    await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${SYNC_LOCK})`;
      // Snoozes that ran out come back.
      await tx`update platform.ruh_insight set status = 'open', snoozed_until = null, rev = nextval('platform.ruh_insight_rev_seq'), updated_at = now()
                where status = 'snoozed' and snoozed_until <= ${nowIso}::timestamptz`;
      const current = ((await tx.unsafe(
        `select ${COLS} from platform.ruh_insight
          where kind = any($1::text[]) and source = 'detector'
            and (status in ('open', 'snoozed') or resolved_at is null)
          order by created_at desc`, [textArray(kinds)],
      )) as unknown as RawRow[]).map(rowOf);
      const live = new Map<string, InsightRow>();
      const decided = new Map<string, InsightRow>();
      for (const r of current) {
        if (r.status === 'open' || r.status === 'snoozed') live.set(r.dedupeKey, r);
        else if (!decided.has(r.dedupeKey)) decided.set(r.dedupeKey, r);
      }

      for (const d of unique.values()) {
        const row = live.get(d.dedupeKey);
        if (row) {
          if (contentChanged(row, d)) {
            const escalated = SEVERITY_RANK[d.severity] > SEVERITY_RANK[row.severity] && d.severity === 'urgent';
            await tx`
              update platform.ruh_insight
                 set severity = ${d.severity}, title = ${d.title}, body = ${d.body}, deep_link = ${d.deepLink},
                     prediction = ${json(d.prediction)}::text::jsonb, audience_roles = ${textArray(d.audienceRoles)}::text[],
                     subject = ${json(d.subject)}::text::jsonb, mirror = ${d.mirror},
                     status = case when ${escalated} then 'open' else status end,
                     snoozed_until = case when ${escalated} then null else snoozed_until end,
                     last_detected_at = ${nowIso}::timestamptz, rev = nextval('platform.ruh_insight_rev_seq'), updated_at = now()
               where ruh_insight_id = ${row.id}::uuid`;
            if (d.mirror && mirrorOn && (row.severity !== d.severity || row.title !== d.title || row.body !== d.body)) {
              await this.queueSignal(tx, d, links);
            }
            result.updated++;
          } else {
            await tx`update platform.ruh_insight set last_detected_at = ${nowIso}::timestamptz where ruh_insight_id = ${row.id}::uuid`;
          }
          continue;
        }
        const was = decided.get(d.dedupeKey);
        if (was && SEVERITY_RANK[d.severity] <= SEVERITY_RANK[was.severity]) {
          // A person already decided on this finding and it has not got worse: leave it with them.
          await tx`update platform.ruh_insight set last_detected_at = ${nowIso}::timestamptz where ruh_insight_id = ${was.id}::uuid`;
          continue;
        }
        if (was) await tx`update platform.ruh_insight set resolved_at = ${nowIso}::timestamptz where ruh_insight_id = ${was.id}::uuid`;
        await this.insert(tx, d, 'detector', nowIso);
        if (d.mirror && mirrorOn) await this.queueSignal(tx, d, links);
        result.opened++;
      }

      // Findings that are gone: close them (and tell ALEMBIC), and let a decided one reopen next time.
      for (const r of live.values()) {
        if (unique.has(r.dedupeKey)) continue;
        await tx`
          update platform.ruh_insight
             set status = 'done', resolved_at = ${nowIso}::timestamptz, acted_by = null, acted_at = ${nowIso}::timestamptz,
                 act_note = 'Cleared: Ruh no longer sees this.', snoozed_until = null,
                 rev = nextval('platform.ruh_insight_rev_seq'), updated_at = now()
           where ruh_insight_id = ${r.id}::uuid`;
        if (r.mirror) await this.signals.enqueueResolve(tx, r.dedupeKey);
        result.cleared++;
      }
      for (const r of decided.values()) {
        if (unique.has(r.dedupeKey)) continue;
        await tx`update platform.ruh_insight set resolved_at = ${nowIso}::timestamptz where ruh_insight_id = ${r.id}::uuid`;
      }
    });
    return result;
  }

  private async insert(q: Q, d: InsightDraft, source: 'detector' | 'override', nowIso: string): Promise<string> {
    const [row] = (await q`
      insert into platform.ruh_insight
        (kind, severity, audience_roles, console, subject, title, body, deep_link, prediction, source, dedupe_key, mirror,
         status, last_detected_at)
      values (${d.kind}, ${d.severity}, ${textArray(d.audienceRoles)}::text[], ${d.console}, ${json(d.subject)}::text::jsonb,
              ${d.title}, ${d.body}, ${d.deepLink}, ${json(d.prediction)}::text::jsonb, ${source}, ${d.dedupeKey}, ${d.mirror},
              'open', ${nowIso}::timestamptz)
      returning ruh_insight_id::text as id`) as unknown as Array<{ id: string }>;
    return row!.id;
  }

  /* ── the consoles' read ─────────────────────────────────────────────────────────────── */

  async list(principal: AuthPrincipal, opts: { since?: number | null; console?: RuhConsole | null; limit?: number } = {}) {
    const [m] = (await this.sql`select coalesce(max(rev), 0) as rev from platform.ruh_insight`) as unknown as Array<{ rev: string | number }>;
    const rev = Number(m?.rev ?? 0);
    if (opts.since != null && rev <= opts.since) return { unchanged: true as const, rev };
    const roles = principal.roles ?? [];
    const all = roles.some((r) => SEES_ALL_ROLES.includes(r));
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 200) || 200, 1), 500);
    const rows = ((await this.sql.unsafe(
      `select ${COLS} from platform.ruh_insight
        where status in ('open', 'snoozed')
          and ($1::boolean or audience_roles && $2::text[])
          and ($3::text is null or console = $3::text)
        order by case severity when 'urgent' then 3 when 'warn' then 2 when 'suggest' then 1 else 0 end desc, created_at desc
        limit ${limit}`, [all, textArray(roles), opts.console ?? null],
    )) as unknown as RawRow[]).map(rowOf);
    const s = await this.settings.get();
    const links = linksOf(s);
    const now = Date.now();
    const items = rows.map((r) => {
      const snoozed = r.status === 'snoozed' && r.snoozedUntil !== null && Date.parse(r.snoozedUntil) > now;
      return {
        id: r.id, kind: r.kind, severity: r.severity, title: r.title, body: r.body, console: r.console,
        deepLink: r.deepLink, href: absoluteLink(r.console, r.deepLink, links), prediction: r.prediction, subject: r.subject,
        source: r.source, status: snoozed ? 'snoozed' : 'open', snoozedUntil: snoozed ? r.snoozedUntil : null,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
      };
    });
    const counts = { urgent: 0, warn: 0, suggest: 0, info: 0 };
    for (const i of items) if (i.status === 'open') counts[i.severity] += 1;
    const top = (['urgent', 'warn', 'suggest', 'info'] as const).find((k) => counts[k] > 0) ?? null;
    return { unchanged: false as const, rev, items, counts, top };
  }

  /* ── a person's decision ────────────────────────────────────────────────────────────── */

  async act(principal: AuthPrincipal, id: string, action: 'snooze' | 'done' | 'dismiss', opts: { minutes?: number; note?: string | null } = {}) {
    return this.sql.begin(async (tx) => {
      const [raw] = (await tx.unsafe(`select ${COLS} from platform.ruh_insight where ruh_insight_id = $1::uuid for update`, [id])) as unknown as RawRow[];
      if (!raw) throw new NotFoundException('That Ruh note no longer exists.');
      const row = rowOf(raw);
      if (!this.sees(principal, row.audienceRoles)) throw new ForbiddenException('This Ruh note is for another role.');
      if (row.status !== 'open' && row.status !== 'snoozed') throw new ConflictException(`This Ruh note is already ${row.status}.`);
      const note = opts.note ? String(opts.note).trim().slice(0, 500) || null : null;
      if (action === 'snooze') {
        const minutes = Math.min(Math.max(Math.trunc(opts.minutes ?? 240) || 240, 5), 7 * 24 * 60);
        const until = new Date(Date.now() + minutes * 60_000).toISOString();
        await tx`update platform.ruh_insight set status = 'snoozed', snoozed_until = ${until}::timestamptz, acted_by = ${principal.userId}::uuid,
                   acted_at = now(), act_note = ${note}, rev = nextval('platform.ruh_insight_rev_seq'), updated_at = now()
                 where ruh_insight_id = ${id}::uuid`;
      } else {
        await tx`update platform.ruh_insight set status = ${action === 'done' ? 'done' : 'dismissed'}, snoozed_until = null,
                   acted_by = ${principal.userId}::uuid, acted_at = now(), act_note = ${note},
                   rev = nextval('platform.ruh_insight_rev_seq'), updated_at = now()
                 where ruh_insight_id = ${id}::uuid`;
        if (row.mirror) await this.signals.enqueueResolve(tx, row.dedupeKey);
      }
      await tx`
        insert into platform.audit_events (actor_id, action, entity_type, entity_id, before, after)
        values (${principal.userId}::uuid, ${`ruh.insight.${action === 'snooze' ? 'snoozed' : action === 'done' ? 'done' : 'dismissed'}`},
                'ruh_insight', ${id}::uuid, ${json({ status: row.status, kind: row.kind })}::text::jsonb,
                ${json({ status: action === 'snooze' ? 'snoozed' : action === 'done' ? 'done' : 'dismissed', note, minutes: action === 'snooze' ? opts.minutes ?? 240 : undefined })}::text::jsonb)`;
      const [after] = (await tx.unsafe(`select ${COLS} from platform.ruh_insight where ruh_insight_id = $1::uuid`, [id])) as unknown as RawRow[];
      return rowOf(after!);
    });
  }

  /* ── an override of a Ruh warning ───────────────────────────────────────────────────── */

  async recordOverride(input: {
    principal: AuthPrincipal;
    guard: string;
    actionLabel: string;
    reason: string;
    risks: readonly Risk[];
    console: RuhConsole;
    deepLink: string | null;
    subject: RuhSubject;
    route: string;
    actorEmail?: string | null;
  }, q?: Q): Promise<{ insightId: string; dedupeKey: string }> {
    const run = async (tx: Q) => {
      const email = input.actorEmail !== undefined ? input.actorEmail : await this.emailOf(tx, input.principal.userId);
      const who = email ?? 'Someone';
      const dedupeKey = `override:${randomUUID()}`;
      const s = await this.settings.get();
      const draft: InsightDraft = {
        kind: 'ruh.override',
        severity: 'urgent',
        audienceRoles: [...OVERRIDE_AUDIENCE],
        console: input.console,
        subject: input.subject,
        title: `${who} continued past a Ruh warning: ${input.actionLabel}`,
        body: `Reason given: “${input.reason}”. Ruh had warned: ${input.risks.map((r) => r.title).join('; ')}.`,
        deepLink: input.deepLink,
        prediction: null,
        dedupeKey,
        mirror: true,
      };
      const insightId = await this.insert(tx, draft, 'override', new Date().toISOString());
      await tx`
        insert into platform.audit_events (actor_id, action, entity_type, entity_id, after)
        values (${input.principal.userId}::uuid, 'ruh.override', ${input.subject.type},
                ${input.subject.id && /^[0-9a-f-]{36}$/i.test(input.subject.id) ? input.subject.id : null}::uuid,
                ${json({ guard: input.guard, route: input.route, reason: input.reason, risks: input.risks, insightId })}::text::jsonb)`;
      const override: C3Override = {
        actorEmail: email, action: input.actionLabel, reason: input.reason,
        risks: input.risks.map((r) => ({ code: r.code, title: r.title, detail: r.detail })),
      };
      // An override always reaches ALEMBIC (it emails the admins), whatever signals.enabled says.
      await this.queueSignal(tx, draft, linksOf(s), override);
      return { insightId, dedupeKey };
    };
    return q ? run(q) : this.sql.begin(run);
  }

  async emailOf(q: Q, userId: string): Promise<string | null> {
    const [u] = (await q`select email from iam.user_master where user_id = ${userId}::uuid limit 1`) as unknown as Array<{ email: string | null }>;
    return u?.email ?? null;
  }
}
