/**
 * MacerationService (lane pf-c, plan section 8) — the admin toggle per formula, the timers, the
 * freeze step, extensions, admin-only early release, and the alarms. The state machine itself is
 * enforced in the kernel's maceration gate (backend-kernel/src/events/maceration-gate.ts), inside
 * the oil-batch transition, dispatch, reservation and FG-rack transactions.
 *
 *   settings      production.maceration_setting per formula: required, min/max days, freeze step.
 *   runs          every open run: "Day 23 of 45", freeze done?, minimum reached?, over the maximum?
 *   freezeDone    the freeze / chill-filter step, named to the person.
 *   extend        more days, with a reason (logged). Shortening is an early release, not an edit.
 *   early release PROM-2: Stop, second person. QC or production REQUESTS it with a reason code from
 *                 the away-from-caution list and a reason (production:maceration:release_early_request);
 *                 a DIFFERENT person holding production:maceration:release_early, signed in within
 *                 the last five minutes (@FreshAuth on the route), approves or declines. Before PROM-2
 *                 one admin with a reason released it. QC 2 still gates.
 *   rule          PROM-2: the branch rule `maceration.rest` in force (default 45 days, no maximum set).
 *                 A formula setting may lengthen the rest, never shorten it.
 *   sweepAlarms   minimum reached -> an alarm at the production station and a CRM notice to
 *                 ALEMBIC (QcStatusChanged, status MACERATION_COMPLETE); past the maximum -> alarm.
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { bridge as bridgeContracts } from '@core/contracts';
import { emitBridgeOutbound, macerationProgress, PG_CLIENT, restRuleInForce, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import type { Sql } from 'postgres';
import { clearAlert, raiseAlert } from './floor-alerts.js';
import { FLOOR_CLOCK } from './floor.tokens.js';
import { drizzleExec, iso, systemClock, type Clock, UUID_RE } from './floor-util.js';

/** The station that hears the maceration alarm (the TV display shows it too). */
export const MACERATION_STATION = 'Production';

/** system-led-operations.md 3.3: a reason's text has at least eight non-space characters. */
export const MIN_REASON_CHARS = 8;

@Injectable()
export class MacerationService {
  private readonly clock: Clock;
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql, @Optional() @Inject(FLOOR_CLOCK) clock?: Clock) {
    this.clock = clock ?? systemClock;
  }

  /** WALK2-RP-15: what a maceration setting is chosen by. The screen read the Vault formula directory, which
   *  an admin (who sets maceration) may not read, so the picker said "Missing permission". A setting is per
   *  product, and the main box knows each product's linked formula: products with one, by code and name. */
  async settingProducts() {
    const rows = await this.sql`
      select formula_id::text as formula_id, product_code, product_name from packaging.product_master
       where formula_id is not null order by product_code nulls last, product_name`;
    return rows.map((r) => ({ formulaId: String(r.formula_id), productCode: (r.product_code as string) ?? null, productName: (r.product_name as string) ?? null }));
  }

  async settings() {
    const rows = await this.sql`select * from production.maceration_setting order by updated_at desc`;
    return rows.map((r) => this.shapeSetting(r));
  }

  async putSetting(formulaId: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    if (!UUID_RE.test(formulaId)) throw new BadRequestException('formulaId must be an id.');
    const required = body.required === true;
    const minDays = Number(body.minDays), maxDays = Number(body.maxDays);
    if (!Number.isInteger(minDays) || minDays < 1 || minDays > 365) throw new BadRequestException('minDays must be a whole number of days, 1 to 365.');
    if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 365) throw new BadRequestException('maxDays must be a whole number of days, 1 to 365.');
    if (minDays > maxDays) throw new BadRequestException('minDays cannot be more than maxDays.');
    // PROM-2: the branch rule is the floor. A formula may rest longer, never shorter.
    const rule = await restRuleInForce(drizzleExec(this.sql));
    if (required && minDays < rule.value.minDays) {
      throw new BadRequestException(`The branch rule is ${rule.value.minDays} days; a shorter rest for one batch is an early release.`);
    }
    const freezeRequired = body.freezeRequired === true;
    const note = typeof body.freezeNote === 'string' ? body.freezeNote.trim().slice(0, 300) || null : null;
    const [r] = await this.sql`
      insert into production.maceration_setting (formula_id, required, min_days, max_days, freeze_required, freeze_note, updated_by, updated_at)
      values (${formulaId}::uuid, ${required}, ${minDays}, ${maxDays}, ${freezeRequired}, ${note}, ${principal.userId}::uuid, ${this.clock().toISOString()}::timestamptz)
      on conflict (formula_id) do update set required = excluded.required, min_days = excluded.min_days, max_days = excluded.max_days,
        freeze_required = excluded.freeze_required, freeze_note = excluded.freeze_note, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      returning *`;
    return this.shapeSetting(r!);
  }

  /** PROM-2: the branch rule in force, for the Maceration and Rules screens. */
  async rule() {
    const r = await restRuleInForce(drizzleExec(this.sql));
    return {
      key: 'maceration.rest', minDays: r.value.minDays, maxDays: r.value.maxDays, maxLabel: r.value.maxDays === null ? 'No maximum set' : `${r.value.maxDays} days`,
      appliesTo: r.value.appliesTo, earlyRelease: r.value.earlyRelease, version: r.version, source: r.source, explain: r.explain,
    };
  }

  async runs(opts: { open?: boolean } = {}) {
    const rows = await this.sql`
      select mr.*, ob.batch_number, ob.status as batch_status from production.maceration_run mr
        left join production.oil_batch_master ob on ob.oil_batch_id = mr.oil_batch_id
       ${opts.open === false ? this.sql`` : this.sql`where mr.status = 'MACERATING'`}
       order by mr.started_at
       limit 500`;
    return rows.map((r) => this.shapeRun(r));
  }

  async run(id: string) {
    const [r] = await this.sql`
      select mr.*, ob.batch_number, ob.status as batch_status from production.maceration_run mr
        left join production.oil_batch_master ob on ob.oil_batch_id = mr.oil_batch_id where mr.maceration_run_id = ${id}::uuid`;
    if (!r) throw new NotFoundException('That maceration run was not found.');
    const events = await this.sql`select event, note, performed_by, created_at from production.maceration_event where maceration_run_id = ${id}::uuid order by created_at`;
    return { ...this.shapeRun(r), events: events.map((e) => ({ event: String(e.event), note: e.note ?? null, performedBy: e.performed_by ?? null, at: iso(e.created_at) })) };
  }

  private async openForUpdate(tx: Sql, id: string) {
    const [r] = await tx`select * from production.maceration_run where maceration_run_id = ${id}::uuid for update`;
    if (!r) throw new NotFoundException('That maceration run was not found.');
    if (r.status !== 'MACERATING') throw new ConflictException(`That run is ${String(r.status).toLowerCase()}.`);
    return r;
  }
  private async log(tx: Sql, id: string, ev: string, note: string | null, principal: AuthPrincipal) {
    await tx`insert into production.maceration_event (maceration_event_id, maceration_run_id, event, note, performed_by, created_at)
             values (${uuidv7()}::uuid, ${id}::uuid, ${ev}, ${note}, ${principal.userId}::uuid, ${this.clock().toISOString()}::timestamptz)`;
  }
  private reason(v: unknown, what: string) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) throw new BadRequestException(`${what} needs a reason.`);
    return s.slice(0, 500);
  }
  /** A reason code from the away-from-caution list, and text of at least eight non-space characters. */
  private codedReason(body: Record<string, unknown>, what: string) {
    const code = String(body.reasonCode ?? '');
    if (!(bridgeContracts.AWAY_FROM_CAUTION_REASON_CODES as readonly string[]).includes(code)) {
      throw new BadRequestException(`${what} needs a reason code: ${bridgeContracts.AWAY_FROM_CAUTION_REASON_CODES.join(', ')}.`);
    }
    const why = this.reason(body.reason, what);
    if (why.replace(/\s/g, '').length < MIN_REASON_CHARS) throw new BadRequestException(`${what}: say why in at least ${MIN_REASON_CHARS} characters.`);
    return { code, why };
  }

  async freezeDone(id: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    await this.sql.begin(async (tx) => {
      const r = await this.openForUpdate(tx as unknown as Sql, id);
      if (!r.freeze_required) throw new ConflictException('This run has no freeze step.');
      if (r.freeze_done_at) throw new ConflictException('The freeze step is already recorded.');
      await tx`update production.maceration_run set freeze_done_at = ${this.clock().toISOString()}::timestamptz, freeze_done_by = ${principal.userId}::uuid, updated_at = ${this.clock().toISOString()}::timestamptz where maceration_run_id = ${id}::uuid`;
      await this.log(tx as unknown as Sql, id, 'FREEZE_DONE', typeof body.note === 'string' ? body.note.slice(0, 500) : null, principal);
    });
    return this.run(id);
  }

  async extend(id: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    const days = Number(body.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new BadRequestException('days must be a whole number, 1 to 365.');
    const why = this.reason(body.reason, 'Extending maceration');
    await this.sql.begin(async (tx) => {
      const r = await this.openForUpdate(tx as unknown as Sql, id);
      if (r.max_days != null && Number(r.min_days) + Number(r.extend_days) + days > Number(r.max_days)) {
        throw new BadRequestException(`That goes past this product's maximum of ${r.max_days} days.`);
      }
      await tx`update production.maceration_run set extend_days = extend_days + ${days}, alarm_at = null, updated_at = ${this.clock().toISOString()}::timestamptz where maceration_run_id = ${id}::uuid`;
      await this.log(tx as unknown as Sql, id, 'EXTENDED', `+${days} days: ${why}`, principal);
    });
    return this.run(id);
  }

  /**
   * PROM-2: an early release is requested, never taken. The request names a reason code and a
   * reason; nothing about the run's timer changes until a second person approves.
   */
  async requestEarlyRelease(id: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    const { code, why } = this.codedReason(body, 'An early release');
    await this.sql.begin(async (tx) => {
      const r = await this.openForUpdate(tx as unknown as Sql, id);
      if (r.early_release_at) throw new ConflictException('This run is already released early.');
      if (r.early_release_requested_at) throw new ConflictException('An early release is already waiting for a second person on this run.');
      const p = macerationProgress(r as never, this.clock());
      if (p.minReached) throw new ConflictException('The rest is complete: no early release is needed. QC 2 is next.');
      const now = this.clock().toISOString();
      await tx`update production.maceration_run set early_release_requested_at = ${now}::timestamptz, early_release_by = ${principal.userId}::uuid,
                 early_release_reason_code = ${code}, early_release_reason = ${why}, updated_at = ${now}::timestamptz where maceration_run_id = ${id}::uuid`;
      await this.log(tx as unknown as Sql, id, 'EARLY_RELEASE_REQUESTED', `${code}: ${why}`, principal);
      const [b] = await tx`select batch_number from production.oil_batch_master where oil_batch_id = ${r.oil_batch_id}`;
      await raiseAlert(tx as unknown as Sql, {
        kind: 'maceration_early_release', station: MACERATION_STATION, subjectType: 'oil_batch', subjectId: String(r.oil_batch_id),
        title: `Early release asked: ${b?.batch_number ?? 'batch'}`,
        body: `Day ${p.day} of ${p.needDays}. A second person approves or declines it.`,
        dedupeKey: `maceration_early_release:${id}`,
      }, this.clock());
    });
    return this.run(id);
  }

  /** Stop, second person: never the person who asked; a fresh sign-in is checked on the route. */
  async approveEarlyRelease(id: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null;
    await this.sql.begin(async (tx) => {
      const r = await this.openForUpdate(tx as unknown as Sql, id);
      if (r.early_release_at) throw new ConflictException('This run is already released early.');
      if (!r.early_release_requested_at) throw new ConflictException('Nobody has asked for an early release of this run.');
      if (String(r.early_release_by) === principal.userId) throw new ForbiddenException('You asked for this early release, so someone else must approve it.');
      const now = this.clock().toISOString();
      await tx`update production.maceration_run set early_release_at = ${now}::timestamptz, early_release_approved_by = ${principal.userId}::uuid,
                 updated_at = ${now}::timestamptz where maceration_run_id = ${id}::uuid`;
      await this.log(tx as unknown as Sql, id, 'RELEASED_EARLY', `approved by a second person (${r.early_release_reason_code})${note ? `: ${note}` : ''}`, principal);
    });
    await clearAlert(this.sql, `maceration_early_release:${id}`, this.clock());
    return this.run(id);
  }

  /** Declining (or withdrawing) is toward caution: a reason, no second person. */
  async declineEarlyRelease(id: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    const why = this.reason(body.reason, 'Declining an early release');
    await this.sql.begin(async (tx) => {
      const r = await this.openForUpdate(tx as unknown as Sql, id);
      if (r.early_release_at) throw new ConflictException('This run is already released early.');
      if (!r.early_release_requested_at) throw new ConflictException('Nobody has asked for an early release of this run.');
      await tx`update production.maceration_run set early_release_requested_at = null, early_release_by = null, early_release_reason_code = null,
                 early_release_reason = null, updated_at = ${this.clock().toISOString()}::timestamptz where maceration_run_id = ${id}::uuid`;
      await this.log(tx as unknown as Sql, id, 'EARLY_RELEASE_DECLINED', why, principal);
    });
    await clearAlert(this.sql, `maceration_early_release:${id}`, this.clock());
    return this.run(id);
  }

  async sweepAlarms() {
    const now = this.clock();
    const raised: string[] = [];
    const open = await this.sql`
      select mr.*, ob.batch_number, ob.production_order_id from production.maceration_run mr
        left join production.oil_batch_master ob on ob.oil_batch_id = mr.oil_batch_id
       where mr.status = 'MACERATING'`;
    for (const r of open) {
      const p = macerationProgress(r as never, now);
      const id = String(r.maceration_run_id);
      if (p.minReached && !r.alarm_at) {
        await this.sql.begin(async (tx) => {
          const [claimed] = await tx`update production.maceration_run set alarm_at = ${now.toISOString()}::timestamptz where maceration_run_id = ${id}::uuid and alarm_at is null returning maceration_run_id`;
          if (!claimed) return;
          await raiseAlert(tx as unknown as Sql, {
            kind: 'maceration_complete', station: MACERATION_STATION, subjectType: 'oil_batch', subjectId: String(r.oil_batch_id),
            title: `Maceration complete: ${r.batch_number ?? 'batch'}, in QC`,
            body: `${p.needDays} days reached.${r.freeze_required && !r.freeze_done_at ? ' Freeze / chill-filter step still to do.' : ''} QC 2 next.`,
            dedupeKey: `maceration_complete:${id}`,
          }, now);
          // The CRM notice: ALEMBIC hears the QC status change for the order this batch serves.
          await emitBridgeOutbound(drizzleExec(tx as unknown as Sql), 'QcStatusChanged', (r.production_order_id as string | null) ?? null, {
            stage: 'maceration', status: 'MACERATION_COMPLETE', oil_batch_id: String(r.oil_batch_id), batch_number: r.batch_number ?? null,
          });
          raised.push(id);
        });
      }
      if (p.overMax) {
        await raiseAlert(this.sql, {
          kind: 'maceration_overdue', station: MACERATION_STATION, subjectType: 'oil_batch', subjectId: String(r.oil_batch_id),
          title: `Maceration past its maximum: ${r.batch_number ?? 'batch'}`,
          body: `Over ${p.maxDays ?? 0} days. Run QC 2 or decide the batch.`,
          dedupeKey: `maceration_overdue:${id}`,
        }, now);
      }
    }
    return { alarms: raised };
  }

  private shapeSetting(r: Record<string, unknown>) {
    return {
      formulaId: String(r.formula_id), required: !!r.required, minDays: Number(r.min_days), maxDays: Number(r.max_days),
      freezeRequired: !!r.freeze_required, freezeNote: (r.freeze_note as string | null) ?? null, updatedAt: iso(r.updated_at),
    };
  }

  private shapeRun(r: Record<string, unknown>) {
    const p = macerationProgress(r as never, this.clock());
    const freezeOk = !r.freeze_required || !!r.freeze_done_at;
    return {
      macerationRunId: String(r.maceration_run_id),
      oilBatchId: String(r.oil_batch_id),
      batchNumber: (r.batch_number as string | null) ?? null,
      batchStatus: (r.batch_status as string | null) ?? null,
      status: String(r.status),
      startedAt: iso(r.started_at),
      day: p.day,
      needDays: p.needDays,
      minDays: Number(r.min_days),
      maxDays: p.maxDays,
      extendDays: Number(r.extend_days),
      maxLabel: p.maxDays === null ? 'No maximum set' : `${p.maxDays} days`,
      label: `Day ${p.maxDays === null ? p.day : Math.min(p.day, p.maxDays + 1)} of ${p.needDays}`,
      endsAt: new Date(new Date(iso(r.started_at)!).getTime() + p.needDays * 86_400_000).toISOString(),
      minReached: p.minReached,
      overMax: p.overMax,
      freezeRequired: !!r.freeze_required,
      freezeDoneAt: iso(r.freeze_done_at),
      releasedEarlyAt: iso(r.early_release_at),
      earlyReleaseReason: (r.early_release_reason as string | null) ?? null,
      earlyReleaseReasonCode: (r.early_release_reason_code as string | null) ?? null,
      earlyReleaseRequestedAt: iso(r.early_release_requested_at),
      earlyReleaseRequestedBy: (r.early_release_by as string | null) ?? null,
      earlyReleaseApprovedBy: (r.early_release_approved_by as string | null) ?? null,
      ruleDays: r.rule_days == null ? null : Number(r.rule_days),
      ruleVersion: r.rule_version == null ? null : Number(r.rule_version),
      ruleSource: (r.rule_source as string | null) ?? null,
      daysRested: r.days_rested == null ? null : Number(r.days_rested),
      restShort: r.rest_short == null ? null : !!r.rest_short,
      restartCount: Number(r.restart_count),
      /** Ready for QC 2: time served (or released early) and the freeze step done. */
      readyForQc2: (p.minReached || !!r.early_release_at) && freezeOk,
      alarmAt: iso(r.alarm_at),
    };
  }
}
