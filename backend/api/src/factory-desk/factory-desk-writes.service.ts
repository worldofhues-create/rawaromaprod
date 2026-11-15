/**
 * RP-BE-1 — the writes the RAC OS Factory and Vault consoles need that RawProd had no route for.
 *
 * Every route that calls these is a main-box write, so the global IdempotencyInterceptor (one
 * Idempotency-Key, one write) and WriteAuditInterceptor (one audit_events row in the schema the
 * route's permission names) already apply; nothing here re-implements either. What this file adds is
 * the row the screen needs and the reason the owner's rule asks for: anything that goes against the
 * system's next step (a QC call against the table's proposal, a PO sent back, a recall, a rule
 * changed, a role change asked for, a name revealed behind a code) carries a reason, with who and when.
 *
 * None of these edits a stock figure. A recall places the existing inventory.lot_hold in the same
 * transaction as its review row; stock still moves only through the floor steps and the batch close.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { raiseAlert } from '../floor-ops/floor-alerts.js';
import { holdSubject, resolveRmLot } from '../prodfloor/lot-trace.service.js';
import { FactoryDeskService, siteOf } from './factory-desk.service.js';

type Row = Record<string, unknown>;

export const QC_DECISIONS = ['APPROVE', 'REWORK', 'HOLD_RETEST', 'REJECT', 'HOLD_CAPA'] as const;
export const PROBLEM_KINDS = ['WRONG_IDENTITY', 'SHORT_QUANTITY', 'CONTAINER_DAMAGED', 'SCALE_NOT_READING', 'LABEL_WILL_NOT_SCAN', 'OTHER'] as const;
const PROBLEM_WORDS: Record<(typeof PROBLEM_KINDS)[number], string> = {
  WRONG_IDENTITY: 'Wrong identity on the bin',
  SHORT_QUANTITY: 'Short quantity',
  CONTAINER_DAMAGED: 'Container damaged',
  SCALE_NOT_READING: 'Scale not reading',
  LABEL_WILL_NOT_SCAN: 'Label will not scan',
  OTHER: 'Something else',
};
const PO_AWAITING = ['DRAFT', 'PENDING', 'PENDING_L2_APPROVAL'];
const RULE_KEY = /^[a-z][a-z0-9_.]{1,79}$/;

/** A reason a person typed: at least three characters, at most 500, trimmed. */
export function reasonOf(raw: unknown, what = 'Give a reason.'): string {
  const r = typeof raw === 'string' ? raw.trim() : '';
  if (r.length < 3) throw new BadRequestException(what);
  return r.slice(0, 500);
}

/** A rule value: a number, a boolean, a short string, or null; never an object (a rule is one value). */
function ruleValue(v: unknown): string | number | boolean | null {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.length <= 200) return v;
  throw new BadRequestException('A rule value is a number, yes/no, or a short text.');
}

@Injectable()
export class FactoryDeskWritesService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql, private readonly reads: FactoryDeskService) {}

  /** FAC-BE-17: return a PO awaiting approval to its creator, with a reason. */
  async rejectPo(id: string, body: Row, p: AuthPrincipal) {
    const reason = reasonOf(body?.reason, 'Say why the purchase order goes back to its creator.');
    return this.sql.begin(async (tx) => {
      const [po] = await tx<Row[]>`select status, created_by from procurement.purchase_order where purchase_order_id = ${id}::uuid for update`;
      if (!po) throw new NotFoundException('No such purchase order.');
      if (!PO_AWAITING.includes(String(po.status))) throw new ConflictException(`Only a purchase order awaiting approval can be sent back; this one is ${po.status}.`);
      const [r] = await tx<Row[]>`
        update procurement.purchase_order set status = 'RETURNED', rejected_by = ${p.userId}, rejected_reason = ${reason}, rejected_dt = now(),
               updated_by = ${p.userId}, updated_dt = now()
         where purchase_order_id = ${id}::uuid
        returning purchase_order_id::text as "purchaseOrderId", po_number as "poNumber", status, rejected_by as "rejectedBy",
                  rejected_reason as "rejectedReason", rejected_dt::text as "rejectedDt"`;
      return r!;
    });
  }

  /**
   * FAC-BE-28: the QC person's call on a booked round. `decision` is CONFIRM (take the table's
   * proposal) or one of QC_DECISIONS; a call that differs from the proposal needs a reason and is
   * marked overridesProposal. The call is RECORDED here; it releases, labels and re-queues nothing:
   * the release stays on the existing CoA path (which already speaks to ALEMBIC), so no second
   * "passed" can be sent from this route.
   */
  async decideQc(oilBatchId: string, roundRaw: string, body: Row, p: AuthPrincipal) {
    const roundNo = Number(roundRaw);
    if (!Number.isInteger(roundNo) || roundNo < 1 || roundNo > 999) throw new BadRequestException('Name the round by its number.');
    const asked = String(body?.decision ?? '').trim().toUpperCase();
    if (asked !== 'CONFIRM' && !(QC_DECISIONS as readonly string[]).includes(asked)) {
      throw new BadRequestException(`The call is CONFIRM or one of ${QC_DECISIONS.join(', ')}.`);
    }
    return this.sql.begin(async (tx) => {
      const [r] = await tx<Row[]>`select batch_qc_round_id, decision, decided_dt from quality.batch_qc_round
                                    where oil_batch_id = ${oilBatchId}::uuid and round_no = ${roundNo} for update`;
      if (!r) throw new NotFoundException(`No QC round ${roundNo} is booked for this batch.`);
      if (r.decided_dt) throw new ConflictException('This round already has its call; book a new round to change it.');
      const proposal = (r.decision as string | null) ?? null;
      if (asked === 'CONFIRM' && (!proposal || proposal === 'REVIEW')) {
        throw new ConflictException('The table made no proposal for this round; choose the call and give the reason.');
      }
      const decision = asked === 'CONFIRM' ? proposal! : asked;
      const overrides = decision !== proposal;
      const reason = overrides ? reasonOf(body?.reason, 'Going against the proposal needs a reason.') : (typeof body?.reason === 'string' && body.reason.trim() ? String(body.reason).trim().slice(0, 500) : null);
      const [out] = await tx<Row[]>`
        update quality.batch_qc_round set decided_decision = ${decision}, decided_by = ${p.userId}, decided_dt = now(),
               decision_reason = ${reason}, overrides_proposal = ${overrides}
         where batch_qc_round_id = ${String(r.batch_qc_round_id)}::uuid
        returning batch_qc_round_id::text as "batchQcRoundId", round_no as "roundNo", decision as "proposal", decided_decision as "decision",
                  overrides_proposal as "overridesProposal", decision_reason as "decisionReason", decided_by as "decidedBy", decided_dt::text as "decidedDt"`;
      return out!;
    });
  }

  /** FAC-BE-19: start a recall review from a lot (a raw lot or an oil batch). The lot goes on hold in the same transaction. */
  async startRecall(body: Row, p: AuthPrincipal) {
    const reason = reasonOf(body?.reason, 'Say why this lot is being recalled.');
    const lotRaw = String(body?.lot ?? '').trim();
    if (!lotRaw || lotRaw.length > 60) throw new BadRequestException('Scan or type the lot.');
    const [oil] = await this.sql<Row[]>`select oil_batch_id::text as id, batch_number as ref from production.oil_batch_master where upper(batch_number) = upper(${lotRaw}) limit 2`;
    let subject: { type: 'RM_LOT' | 'OIL_BATCH'; id: string; ref: string };
    if (oil) subject = { type: 'OIL_BATCH', id: String(oil.id), ref: String(oil.ref) };
    else {
      const id = await resolveRmLot(this.sql, lotRaw);
      const [rm] = await this.sql<Row[]>`select batch_number from inventory.rm_batch_master where rm_batch_id = ${id}::uuid`;
      subject = { type: 'RM_LOT', id, ref: String(rm?.batch_number ?? lotRaw) };
    }
    return this.sql.begin(async (tx) => {
      const open = await tx<Row[]>`select recall_no from quality.recall_review where subject_type = ${subject.type} and subject_id = ${subject.id}::uuid and state = 'OPEN'`;
      if (open.length) throw new ConflictException(`Recall ${open[0]!.recall_no} is already open for lot ${subject.ref}.`);
      const [n] = await tx<{ n: string }[]>`select nextval('quality.recall_review_no_seq')::text as n`;
      const recallNo = `RCL-${n!.n.padStart(5, '0')}`;
      await holdSubject(tx, subject.type, subject.id, `Recall ${recallNo}: ${reason}`, 'RECALL', p.userId);
      const [hold] = await tx<Row[]>`select lot_hold_id::text as id from inventory.lot_hold where subject_type = ${subject.type} and subject_id = ${subject.id}::uuid and released_dt is null`;
      const [r] = await tx<Row[]>`
        insert into quality.recall_review (recall_review_id, recall_no, subject_type, subject_id, lot_ref, lot_hold_id, reason, started_by)
        values (${uuidv7()}::uuid, ${recallNo}, ${subject.type}, ${subject.id}::uuid, ${subject.ref}, ${hold?.id ? String(hold.id) : null}, ${reason}, ${p.userId})
        returning recall_review_id::text as "recallReviewId", recall_no as "recallNo", subject_type as "subjectType", lot_ref as "lot",
                  lot_hold_id::text as "lotHoldId", state, reason, started_by as "startedBy", started_dt::text as "startedDt"`;
      return r!;
    });
  }

  /** FAC-BE-13: take a print job out of the queue. Only one not yet printed or sent can be cancelled. */
  async cancelPrintJob(id: string) {
    const [r] = await this.sql<Row[]>`
      update platform.print_job set status = 'cancelled', updated_at = now()
       where print_job_id = ${id}::uuid and status in ('queued', 'failed', 'parked')
      returning print_job_id::text as "printJobId", status`;
    if (r) return r;
    const [j] = await this.sql<Row[]>`select status from platform.print_job where print_job_id = ${id}::uuid`;
    if (!j) throw new NotFoundException('No such print job.');
    throw new ConflictException(`This label is ${j.status}; only a queued, failed or parked label can be taken out of the queue.`);
  }

  /** FAC-BE-08: ask a paired device to run its test. The result is what the device reports, never assumed. */
  async requestDeviceTest(deviceId: string, p: AuthPrincipal) {
    const [d] = await this.sql<Row[]>`select status, revoked_at from platform.device_master where device_id = ${deviceId}::uuid`;
    if (!d) throw new NotFoundException('No such device.');
    if (d.revoked_at || d.status === 'revoked') throw new ConflictException('This device is revoked; pair a new one.');
    const [r] = await this.sql<Row[]>`
      insert into platform.device_test (device_test_id, device_id, requested_by) values (${uuidv7()}::uuid, ${deviceId}::uuid, ${p.userId})
      returning device_test_id::text as "deviceTestId", device_id::text as "deviceId", state, requested_by as "requestedBy", requested_at::text as "requestedAt"`;
    return r!;
  }

  /** FAC-BE-03: save operating rules for a branch. One append-only row per key, all with the one reason. */
  async saveOperatingRules(body: Row, p: AuthPrincipal) {
    const site = siteOf(body?.site);
    const reason = reasonOf(body?.reason, 'Say why the rules change.');
    const values = body?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new BadRequestException('Send the rules as { key: value }.');
    const entries = Object.entries(values as Row);
    if (entries.length === 0 || entries.length > 50) throw new BadRequestException('Send between 1 and 50 rules.');
    for (const [k] of entries) if (!RULE_KEY.test(k)) throw new BadRequestException(`"${k.slice(0, 40)}" is not a rule key.`);
    const clean = entries.map(([k, v]) => [k, ruleValue(v)] as const);
    await this.sql.begin(async (tx) => {
      for (const [k, v] of clean) {
        await tx`insert into platform.operating_rule (operating_rule_id, site, rule_key, value, reason, set_by)
                 values (${uuidv7()}::uuid, ${site}, ${k}, ${JSON.stringify(v)}::text::jsonb, ${reason}, ${p.userId})`; // RELAY-W4: JSON text cast in SQL; tx.json() passed a short text through unquoted on the app's client (22P02, 'Malformed value'), so no text rule could be saved
      }
    });
    return this.reads.operatingRules(site);
  }

  /** FAC-BE-06: save maceration defaults for a branch: { values: [{ productClass, minDays, maxDays }], reason }. */
  async saveMacerationDefaults(siteRaw: unknown, body: Row, p: AuthPrincipal) {
    const site = siteOf(siteRaw);
    const reason = reasonOf(body?.reason, 'Say why the defaults change.');
    const values = Array.isArray(body?.values) ? (body.values as Row[]) : null;
    if (!values || values.length === 0 || values.length > 30) throw new BadRequestException('Send between 1 and 30 product classes.');
    const clean = values.map((v) => {
      const productClass = String(v?.productClass ?? '').trim().slice(0, 40);
      const minDays = Number(v?.minDays);
      const maxDays = Number(v?.maxDays);
      if (!productClass) throw new BadRequestException('Each default names its product class.');
      if (!Number.isInteger(minDays) || !Number.isInteger(maxDays) || minDays < 0 || maxDays < minDays || maxDays > 365) {
        throw new BadRequestException(`${productClass}: days are whole numbers, the most at least the fewest, at most 365.`);
      }
      return { productClass, minDays, maxDays };
    });
    await this.sql.begin(async (tx) => {
      for (const v of clean) {
        await tx`insert into production.maceration_default (maceration_default_id, site, product_class, min_days, max_days, reason, set_by)
                 values (${uuidv7()}::uuid, ${site}, ${v.productClass}, ${v.minDays}, ${v.maxDays}, ${reason}, ${p.userId})`;
      }
    });
    return this.reads.macerationDefaults(site);
  }

  /** FAC-BE-20: ask for a person's role to change. Records the request only; nothing is granted here. */
  async requestRoleChange(body: Row, p: AuthPrincipal) {
    const person = String(body?.person ?? '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(person)) throw new BadRequestException('Choose the person.');
    const toRole = String(body?.toRole ?? '').trim();
    if (!toRole) throw new BadRequestException('Choose the role to ask for.');
    const reason = reasonOf(body?.reason, 'Say why the role should change.');
    const station = typeof body?.station === 'string' && body.station.trim() ? body.station.trim().slice(0, 80) : null;
    const [u] = await this.sql<Row[]>`select 1 from iam.user_master where user_id = ${person}::uuid`;
    if (!u) throw new NotFoundException('No such person.');
    const [role] = await this.sql<Row[]>`select role_code from iam.role_master where role_code = ${toRole}`;
    if (!role) throw new BadRequestException(`There is no role ${toRole.slice(0, 40)}.`);
    const [open] = await this.sql<Row[]>`select 1 from iam.role_change_request where user_id = ${person}::uuid and state = 'REQUESTED'`;
    if (open) throw new ConflictException('A role change is already waiting for this person.');
    const [r] = await this.sql<Row[]>`
      insert into iam.role_change_request (role_change_request_id, user_id, to_role_code, station, reason, requested_by)
      values (${uuidv7()}::uuid, ${person}::uuid, ${toRole}, ${station}, ${reason}, ${p.userId})
      returning role_change_request_id::text as "roleChangeRequestId", user_id::text as "userId", to_role_code as "toRole", station, reason,
                state, requested_by as "requestedBy", requested_dt::text as "requestedDt"`;
    return r!;
  }

  /** FAC-BE-11: a problem from a kiosk task. Raises a station alert for the supervisor in the same step. */
  async raiseProblem(body: Row, p: AuthPrincipal) {
    const station = String(body?.station ?? '').trim().slice(0, 80);
    if (!station) throw new BadRequestException('Name the station.');
    const kind = String(body?.kind ?? '').trim().toUpperCase();
    if (!(PROBLEM_KINDS as readonly string[]).includes(kind)) throw new BadRequestException(`The problem is one of ${PROBLEM_KINDS.join(', ')}.`);
    const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
    if (kind === 'OTHER' && !note) throw new BadRequestException('Say what is wrong.');
    let jobId: string | null = null;
    if (body?.job != null && String(body.job).trim()) {
      const ref = String(body.job).trim().slice(0, 60);
      const [j] = /^[0-9a-f-]{36}$/i.test(ref)
        ? await this.sql<Row[]>`select floor_job_id::text as id from production.floor_job where floor_job_id = ${ref}::uuid`
        : await this.sql<Row[]>`select floor_job_id::text as id from production.floor_job where upper(job_no) = upper(${ref}) limit 1`;
      if (!j) throw new NotFoundException(`No job ${ref} on file.`);
      jobId = String(j.id);
    }
    const id = uuidv7();
    const words = PROBLEM_WORDS[kind as (typeof PROBLEM_KINDS)[number]];
    return this.sql.begin(async (tx) => {
      const raised = await raiseAlert(tx as unknown as Sql, {
        kind: 'floor.problem', station, subjectType: jobId ? 'FLOOR_JOB' : null, subjectId: jobId,
        title: `Problem at ${station}: ${words}`, body: note, dedupeKey: `floor.problem:${id}`,
      }, new Date());
      const [alert] = raised ? await tx<Row[]>`select floor_alert_id::text as id from platform.floor_alert where dedupe_key = ${`floor.problem:${id}`}` : [];
      const [r] = await tx<Row[]>`
        insert into production.floor_problem (floor_problem_id, station, floor_job_id, kind, note, floor_alert_id, raised_by)
        values (${id}::uuid, ${station}, ${jobId}, ${kind}, ${note}, ${alert?.id ? String(alert.id) : null}, ${p.userId})
        returning floor_problem_id::text as "floorProblemId", station, floor_job_id::text as "floorJobId", kind, note,
                  floor_alert_id::text as "floorAlertId", raised_by as "raisedBy", raised_dt::text as "raisedDt"`;
      return { ...r!, alertRaised: Boolean(alert) };
    });
  }

  /**
   * VT-141: the material behind a floor code, for a person who holds masterdata:material:reveal, with
   * a reason recorded before the name is returned. Identity only: no formula, no quantity.
   */
  async revealCode(code: string, body: Row, p: AuthPrincipal) {
    const reason = reasonOf(body?.reason, 'Say why you need the name behind this code.');
    const head = await this.reads.materialForCode(code);
    return this.sql.begin(async (tx) => {
      await tx`insert into masterdata.floor_code_reveal (floor_code_reveal_id, material_id, code, reason, revealed_by)
               values (${uuidv7()}::uuid, ${head.materialId}::uuid, ${head.code}, ${reason}, ${p.userId})`;
      const [m] = await tx<Row[]>`select material_id::text as "materialId", material_code as "materialCode", material_name as "materialName"
                                    from masterdata.material where material_id = ${head.materialId}::uuid`;
      return { code: head.code, ...m!, revealedBy: p.userId };
    });
  }
}
