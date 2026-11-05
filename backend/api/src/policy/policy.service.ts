/**
 * PROD-A-1 — PolicyService: the shared rules engine every lane codes against (production-floor plan
 * §12.0; contract in .claude/prodfloor/BRIEF.md).
 *
 *   evaluate(key, ctx, at?) -> { value, ruleId, version, explain }
 *       The version in force at `at` (default: now), a single-record override first when the case
 *       names a record (ctx.record_type + ctx.record_id), then the scope ladder (policy-engine.ts).
 *       Throws PolicyUnresolved when no rule matches and there is no default: the caller HOLDS.
 *   decide(...)    evaluate and keep the decision with the version it used.
 *   test(...)      the admin's "try a sample case" — on the draft being edited, nothing saved.
 *   publish(...)   the next version, with who and why. Versions are never edited.
 *   override(...)  one record, admin/owner only, with a reason; shows as OVERRIDDEN.
 */
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { evaluateRules, validateBody, describeRule, type PolicyBody } from './policy-engine.js';

/** The policies the plan names (§12.0). Other lanes evaluate these keys; nothing else exists. */
export const POLICY_KEYS = ['receiving.shortfall', 'floor.queue', 'procurement.payment_terms', 'planning.cover', 'qc.rework'] as const;

/** Only these roles may override a policy on one record (§12.0). */
export const OVERRIDE_ROLES = ['owner', 'admin'];

export class PolicyUnresolved extends Error {
  readonly code = 'POLICY_UNRESOLVED';
  constructor(readonly key: string, readonly version: number, readonly explain: string) {
    super(`Policy ${key} v${version} has no rule for this case and no default: hold and ask.`);
    this.name = 'PolicyUnresolved';
  }
}

export interface PolicyResult {
  value: unknown;
  ruleId: string | null;
  version: number;
  explain: string;
  overridden?: { overrideId: string; reason: string; by: string };
}

interface VersionRow {
  policy_key: string;
  version: number;
  body: PolicyBody;
  reason: string;
  created_by: string;
  created_dt: string;
}

function parseBody(v: unknown): PolicyBody {
  return (typeof v === 'string' ? JSON.parse(v) : v) as PolicyBody;
}

@Injectable()
export class PolicyService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  private async versionAt(key: string, at?: Date): Promise<VersionRow> {
    const exists = await this.sql`select 1 from platform.policy where policy_key = ${key}`;
    if (!exists.length) throw new NotFoundException(`No policy "${key}".`);
    const rows = await this.sql<VersionRow[]>`
      select policy_key, version, body, reason, created_by, created_dt::text as created_dt
        from platform.policy_version
       where policy_key = ${key} and created_dt <= ${(at ?? new Date()).toISOString()}::timestamptz
       order by version desc limit 1`;
    if (!rows[0]) throw new PolicyUnresolved(key, 0, 'No version of this policy was in force at that time');
    return { ...rows[0], body: parseBody(rows[0].body) };
  }

  async evaluate(key: string, ctx: Record<string, unknown>, at?: Date): Promise<PolicyResult> {
    const v = await this.versionAt(key, at);
    const recordType = ctx.record_type == null ? null : String(ctx.record_type);
    const recordId = ctx.record_id == null ? null : String(ctx.record_id);
    if (recordType && recordId) {
      // PROD-B-8: an ISO string, not a Date: once any cluster wraps PG_CLIENT in Drizzle its Date serializer is
      // replaced and a Date parameter throws (TypeError: "string" argument ... Received an instance of Date).
      const when = (at ?? new Date()).toISOString();
      const [o] = await this.sql<{ override_id: string; value: unknown; reason: string; created_by: string }[]>`
        select override_id, value, reason, created_by from platform.policy_override
         where policy_key = ${key} and record_type = ${recordType} and record_id = ${recordId}
           and created_dt <= ${when}::timestamptz and (revoked_dt is null or revoked_dt > ${when}::timestamptz)
         order by created_dt desc limit 1`;
      if (o) {
        // jsonb arrives parsed (the Drizzle wrapper only passes dates through as text).
        const value = o.value;
        return {
          value, ruleId: `override:${o.override_id}`, version: v.version,
          explain: `OVERRIDDEN on ${recordType} ${recordId}: ${o.reason}`,
          overridden: { overrideId: o.override_id, reason: o.reason, by: o.created_by },
        };
      }
    }
    const e = evaluateRules(v.body, ctx);
    if (!e.resolved) throw new PolicyUnresolved(key, v.version, e.explain);
    return { value: e.value, ruleId: e.ruleId, version: v.version, explain: e.explain };
  }

  /** Evaluate and record the decision with the version it used. A HOLD is recorded too. */
  async decide(key: string, ctx: Record<string, unknown>, principal: AuthPrincipal | null, at?: Date): Promise<PolicyResult> {
    const recordType = ctx.record_type == null ? null : String(ctx.record_type);
    const recordId = ctx.record_id == null ? null : String(ctx.record_id);
    try {
      const r = await this.evaluate(key, ctx, at);
      await this.sql`insert into platform.policy_decision (policy_key, version, rule_id, record_type, record_id, ctx, value, explain, decided_by)
        values (${key}, ${r.version}, ${r.ruleId}, ${recordType}, ${recordId}, ${this.sql.json(ctx as never)}, ${this.sql.json((r.value ?? null) as never)}, ${r.explain}, ${principal?.userId ?? 'system'})`;
      return r;
    } catch (e) {
      if (e instanceof PolicyUnresolved) {
        await this.sql`insert into platform.policy_decision (policy_key, version, rule_id, record_type, record_id, ctx, value, explain, decided_by)
          values (${key}, ${e.version}, ${null}, ${recordType}, ${recordId}, ${this.sql.json(ctx as never)}, ${null}, ${'HOLD: ' + e.explain}, ${principal?.userId ?? 'system'})`;
      }
      throw e;
    }
  }

  async list() {
    return this.sql`
      select p.policy_key as "key", p.title, p.description, v.version, v.body, v.reason, v.created_by as "createdBy", v.created_dt::text as "createdDt",
             (select count(*)::int from platform.policy_override o where o.policy_key = p.policy_key and o.revoked_dt is null) as "activeOverrides"
        from platform.policy p
        join lateral (select * from platform.policy_version pv where pv.policy_key = p.policy_key order by version desc limit 1) v on true
       order by p.policy_key`;
  }

  async history(key: string) {
    await this.versionAt(key);
    const versions = await this.sql`
      select version, body, reason, created_by as "createdBy", created_dt::text as "createdDt"
        from platform.policy_version where policy_key = ${key} order by version desc`;
    const overrides = await this.sql`
      select override_id as "overrideId", record_type as "recordType", record_id as "recordId", value, reason,
             created_by as "createdBy", created_dt::text as "createdDt", revoked_by as "revokedBy", revoked_dt::text as "revokedDt", revoke_reason as "revokeReason"
        from platform.policy_override where policy_key = ${key} order by created_dt desc limit 200`;
    const decisions = await this.sql`
      select decision_id as "decisionId", version, rule_id as "ruleId", record_type as "recordType", record_id as "recordId", explain,
             decided_by as "decidedBy", decided_dt::text as "decidedDt"
        from platform.policy_decision where policy_key = ${key} order by decided_dt desc limit 50`;
    return { key, versions, overrides, decisions };
  }

  /** Try a case against a draft body (nothing saved), or against the version in force. */
  async test(key: string, draft: unknown, ctx: Record<string, unknown>) {
    const current = await this.versionAt(key);
    const body = draft === undefined || draft === null ? current.body : (draft as PolicyBody);
    const problems = validateBody(body);
    if (problems.length) return { valid: false, problems, resolved: false, explain: problems.join(' ') };
    const e = evaluateRules(body, ctx ?? {});
    const trace = body.rules.map((r, i) => ({ ruleId: r.id, text: describeRule(r, i), scope: r.scope }));
    return e.resolved
      ? { valid: true, problems: [], resolved: true, value: e.value, ruleId: e.ruleId, explain: e.explain, trace }
      : { valid: true, problems: [], resolved: false, hold: true, explain: e.explain, trace };
  }

  async publish(key: string, body: unknown, reason: string, principal: AuthPrincipal) {
    const why = String(reason ?? '').trim();
    if (!why) throw new BadRequestException('Say why the rules are changing.');
    const problems = validateBody(body);
    if (problems.length) throw new BadRequestException(problems.join(' '));
    await this.versionAt(key);
    return this.sql.begin(async (tx) => {
      // Serialise publishers on this policy so two saves cannot both become version N+1.
      await tx`select 1 from platform.policy where policy_key = ${key} for update`;
      const [row] = await tx<{ next: number }[]>`
        select coalesce(max(version), 0) + 1 as next from platform.policy_version where policy_key = ${key}`;
      const next = row!.next;
      await tx`insert into platform.policy_version (policy_key, version, body, reason, created_by)
        values (${key}, ${next}, ${tx.json(body as never)}, ${why}, ${principal.userId})`;
      return { key, version: next };
    });
  }

  private assertOverrider(principal: AuthPrincipal) {
    const roles = (principal.roles ?? []).map((r) => r.toLowerCase());
    if (!roles.some((r) => OVERRIDE_ROLES.includes(r))) {
      throw new ForbiddenException('Only an admin or the owner may override a rule on one record.');
    }
  }

  async override(key: string, recordType: string, recordId: string, value: unknown, reason: string, principal: AuthPrincipal) {
    this.assertOverrider(principal);
    const why = String(reason ?? '').trim();
    if (!why) throw new BadRequestException('An override needs a reason.');
    if (!String(recordType ?? '').trim() || !String(recordId ?? '').trim()) throw new BadRequestException('Name the record this override is for.');
    if (value === undefined) throw new BadRequestException('Give the value this record should use.');
    await this.versionAt(key);
    try {
      const [row] = await this.sql<{ override_id: string }[]>`
        insert into platform.policy_override (policy_key, record_type, record_id, value, reason, created_by)
        values (${key}, ${recordType}, ${recordId}, ${this.sql.json(value as never)}, ${why}, ${principal.userId})
        returning override_id`;
      return { overrideId: row!.override_id, status: 'OVERRIDDEN' };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new BadRequestException('That record already has an override on this policy. Revoke it first.');
      throw e;
    }
  }

  async revokeOverride(overrideId: string, reason: string, principal: AuthPrincipal) {
    this.assertOverrider(principal);
    const why = String(reason ?? '').trim();
    if (!why) throw new BadRequestException('Say why the override is being withdrawn.');
    const rows = await this.sql`update platform.policy_override set revoked_by = ${principal.userId}, revoked_dt = now(), revoke_reason = ${why}
      where override_id = ${overrideId} and revoked_dt is null returning override_id`;
    if (!rows.length) throw new NotFoundException('No active override with that id.');
    return { overrideId, status: 'REVOKED' };
  }
}
