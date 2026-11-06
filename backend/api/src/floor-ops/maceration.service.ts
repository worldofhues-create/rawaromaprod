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
 *   releaseEarly  admin only (production:maceration:release_early), with a reason. QC 2 still gates.
 *   sweepAlarms   minimum reached -> an alarm at the production station and a CRM notice to
 *                 ALEMBIC (QcStatusChanged, status MACERATION_COMPLETE); past the maximum -> alarm.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { emitBridgeOutbound, macerationProgress, PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import type { Sql } from 'postgres';
import { raiseAlert } from './floor-alerts.js';
import { FLOOR_CLOCK } from './floor.tokens.js';
import { drizzleExec, iso, systemClock, type Clock, UUID_RE } from './floor-util.js';

/** The station that hears the maceration alarm (the TV display shows it too). */
export const MACERATION_STATION = 'Production';

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
      if (Number(r.min_days) + Number(r.extend_days) + days > Number(r.max_days)) {
        throw new BadRequestException(`That goes past this product's maximum of ${r.max_days} days.`);
      }
      await tx`update production.maceration_run set extend_days = extend_days + ${days}, alarm_at = null, updated_at = ${this.clock().toISOString()}::timestamptz where maceration_run_id = ${id}::uuid`;
      await this.log(tx as unknown as Sql, id, 'EXTENDED', `+${days} days: ${why}`, principal);
    });
    return this.run(id);
  }

  /** Admin only (the controller's permission). QC 2 still gates the release. */
  async releaseEarly(id: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    const why = this.reason(body.reason, 'An early release');
    await this.sql.begin(async (tx) => {
      const r = await this.openForUpdate(tx as unknown as Sql, id);
      if (r.early_release_at) throw new ConflictException('This run is already released early.');
      const now = this.clock().toISOString();
      await tx`update production.maceration_run set early_release_at = ${now}::timestamptz, early_release_by = ${principal.userId}::uuid, early_release_reason = ${why}, updated_at = ${now}::timestamptz where maceration_run_id = ${id}::uuid`;
      await this.log(tx as unknown as Sql, id, 'RELEASED_EARLY', why, principal);
    });
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
          body: `Over ${p.maxDays} days. Run QC 2 or decide the batch.`,
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
      label: `Day ${Math.min(p.day, p.maxDays + 1)} of ${p.needDays}`,
      endsAt: new Date(new Date(iso(r.started_at)!).getTime() + p.needDays * 86_400_000).toISOString(),
      minReached: p.minReached,
      overMax: p.overMax,
      freezeRequired: !!r.freeze_required,
      freezeDoneAt: iso(r.freeze_done_at),
      releasedEarlyAt: iso(r.early_release_at),
      earlyReleaseReason: (r.early_release_reason as string | null) ?? null,
      restartCount: Number(r.restart_count),
      /** Ready for QC 2: time served (or released early) and the freeze step done. */
      readyForQc2: (p.minReached || !!r.early_release_at) && freezeOk,
      alarmAt: iso(r.alarm_at),
    };
  }
}
