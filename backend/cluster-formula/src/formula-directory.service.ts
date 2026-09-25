/**
 * FormulaDirectoryService — the Vault's answers to the main app box's NON-recipe formula reads,
 * which that box used to make by joining `formula.*` tables that do not exist in its database
 * (dashboard runs, the finished-good trace, the formula-access audit). Served to the main box over
 * the signed internal channel (`vault-port-internal.controller.ts`), and on the Vault box itself
 * for the Vault console's access-audit screen.
 *
 * WHAT CROSSES, AND WHAT NEVER DOES:
 *   - formula CODE, version number and lifecycle status, and a formula event's TYPE and time. The
 *     dashboards already show the code to every caller (the chain-of-custody "formula" stage).
 *   - never the formula NAME. The main box used to show `formula_master.formula_name` only to a
 *     caller holding `formula:actual:read` — the Vault plaintext permission that only
 *     formulator/vault_approver hold (scripts/ra-roles.ts VAULT_PLAINTEXT_PERMISSION, §107: "no
 *     implicit formula plaintext ... Vault authority is separately granted"), and the dashboard's
 *     own rule is "identity lives at the vault, the floor sees anonymised codes". Product identity
 *     is therefore Vault-authority data: it stays in the Vault console, and the main box shows the
 *     code instead. The Vault cannot check the end user's permission on this channel (it trusts
 *     the signed caller), so a name the main box may only show to some callers is not sent at all.
 *   - never an event's REMARKS (free text an approver typed while reviewing a recipe — it can
 *     name materials or amounts), never composition, percentages or material identities.
 *   - the access audit (`accessAudit`) returns the hash-chained `formula.audit_events` rows the
 *     Vault console's audit screen shows. It is gated by `formula:actual:read` wherever it is
 *     served (the Vault route, and the main box's route before it calls the Vault). The actor's
 *     email is not known here (it lives in the main database's `iam.user_master`); the main box
 *     adds it, the Vault console shows the actor id.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { FORMULA_DB, formulaSchema, type FormulaDb } from './formula.tokens.js';

const { formulaMaster, formulaVersion, formulaEventHist, auditEvents } = formulaSchema;

/** A formula version as the main box may label it. No name. */
export interface FormulaVersionLabel {
  formulaVersionId: string;
  formulaId: string | null;
  formulaCode: string | null;
  versionNumber: number | null;
  status: string | null;
}

/** A formula as the main box may label it. No name. */
export interface FormulaLabel {
  formulaId: string;
  formulaCode: string | null;
}

export interface FormulaLabelsQuery {
  formulaVersionIds: string[];
  formulaIds: string[];
  /** Also return the dashboard's "recent" block (the first formula codes + the latest events). */
  recent?: boolean;
}

export interface FormulaLabels {
  versions: FormulaVersionLabel[];
  formulas: FormulaLabel[];
  recent: {
    /** Up to RECENT_FORMULA_CODES formula codes, in code order (the dashboard's formula stage). */
    formulaCodes: string[];
    /** Up to RECENT_EVENTS formula lifecycle events, newest first: type + time only. */
    events: Array<{ eventType: string | null; eventDt: string | null }>;
  } | null;
}

/** One row of the Vault's access audit, as both audit screens show it. */
export interface AccessAuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorId: string | null;
  /** The actor's email: null on the Vault (no user directory there); the main box fills it. */
  actor: string | null;
  ip: string | null;
  requestId: string | null;
  occurredAt: string;
  reason: string | null;
  result: string;
}

export interface AccessAuditPage {
  items: AccessAuditRow[];
  nextCursor: string | null;
}

export const RECENT_FORMULA_CODES = 3;
export const RECENT_EVENTS = 5;
/** Upper bound on ids per labels call (the dashboard asks for at most a dozen). */
export const MAX_LABEL_IDS = 200;

/** Upper bound on the offset cursor (it crosses the signed channel as at most 9 digits). */
export const MAX_AUDIT_OFFSET = 999_999_999;

/** The bounds the main box's AuditService always applied (limit 1..500, an offset cursor where
 *  anything unparseable reads as 0), shared by both boxes' routes. */
export function accessAuditBounds(limit?: number, cursor?: string | null): { limit: number; offset: number } {
  const lim = Math.min(Math.max(1, Math.trunc(Number(limit) || 100)), 500);
  const offset = Math.min(Math.max(0, parseInt(cursor || '0', 10) || 0), MAX_AUDIT_OFFSET);
  return { limit: lim, offset };
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

@Injectable()
export class FormulaDirectoryService {
  constructor(@Inject(FORMULA_DB) private readonly db: FormulaDb) {}

  async labels(query: FormulaLabelsQuery): Promise<FormulaLabels> {
    const versionIds = [...new Set(query.formulaVersionIds)].slice(0, MAX_LABEL_IDS);
    const formulaIds = [...new Set(query.formulaIds)].slice(0, MAX_LABEL_IDS);

    const versions = versionIds.length
      ? await this.db
          .select({
            formulaVersionId: formulaVersion.formulaVersionId,
            formulaId: formulaVersion.formulaId,
            formulaCode: formulaMaster.formulaCode,
            versionNumber: formulaVersion.versionNumber,
            status: formulaVersion.status,
          })
          .from(formulaVersion)
          .leftJoin(formulaMaster, eq(formulaMaster.formulaId, formulaVersion.formulaId))
          .where(inArray(formulaVersion.formulaVersionId, versionIds))
      : [];

    const formulas = formulaIds.length
      ? await this.db
          .select({ formulaId: formulaMaster.formulaId, formulaCode: formulaMaster.formulaCode })
          .from(formulaMaster)
          .where(inArray(formulaMaster.formulaId, formulaIds))
      : [];

    let recent: FormulaLabels['recent'] = null;
    if (query.recent) {
      const codes = await this.db
        .select({ formulaCode: formulaMaster.formulaCode })
        .from(formulaMaster)
        .orderBy(formulaMaster.formulaCode)
        .limit(RECENT_FORMULA_CODES);
      const events = await this.db
        .select({ eventType: formulaEventHist.eventType, eventDt: formulaEventHist.eventDt })
        .from(formulaEventHist)
        .orderBy(desc(formulaEventHist.eventDt))
        .limit(RECENT_EVENTS);
      recent = {
        formulaCodes: codes.map((c) => c.formulaCode).filter((c): c is string => !!c),
        events: events.map((e) => ({ eventType: e.eventType ?? null, eventDt: iso(e.eventDt) })),
      };
    }

    return {
      versions: versions.map((v) => ({ ...v, formulaCode: v.formulaCode ?? null })),
      formulas,
      recent,
    };
  }

  /**
   * The access audit, newest first, offset-paged exactly as the main box's route always was. The
   * caller's reason and allow/refuse result come from the row's `after` snapshot
   * (VaultService.writeAudit; not part of the hash chain).
   */
  async accessAudit(limit?: number, cursor?: string | null): Promise<AccessAuditPage> {
    const { limit: lim, offset } = accessAuditBounds(limit, cursor);
    const rows = await this.db
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        actorId: auditEvents.actorId,
        ip: auditEvents.ip,
        requestId: auditEvents.requestId,
        occurredAt: auditEvents.occurredAt,
        reason: sql<string | null>`${auditEvents.after} ->> 'reason'`,
        result: sql<string>`coalesce(${auditEvents.after} ->> 'result', 'allow')`,
      })
      .from(auditEvents)
      .orderBy(desc(auditEvents.occurredAt))
      .limit(lim)
      .offset(offset);
    const items: AccessAuditRow[] = rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId ?? null,
      actorId: r.actorId ?? null,
      actor: null,
      ip: r.ip ?? null,
      requestId: r.requestId ?? null,
      occurredAt: iso(r.occurredAt) ?? '',
      reason: r.reason ?? null,
      result: r.result ?? 'allow',
    }));
    return { items, nextCursor: items.length === lim ? String(offset + lim) : null };
  }
}
