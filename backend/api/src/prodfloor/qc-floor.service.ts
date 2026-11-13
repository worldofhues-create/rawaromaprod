/**
 * PROD-B-6 — QC checkpoints (versioned) and the batch QC rounds + reworks (plan 7, 12.7).
 *
 *   checkpoints  publish() writes a NEW quality.qc_checkpoint_set version for a product, with a
 *                reason; nothing is edited in place. production.product_qc_spec.qc_checkpoint_set_id
 *                points at the current set. A batch pins the set it was first tested on (round 1)
 *                and keeps it, so a later spec change never rewrites what an old batch was held to.
 *                Checkpoints may name a quality.qc_parameter_master row, whose new columns (check
 *                type, instrument, critical/photo defaults) fill what the checkpoint leaves out.
 *   rounds       every round is a full QC on every checkpoint of the pinned set; the decision comes
 *                from qc-decision.ts, never from the client. REJECT / HOLD_RETEST / HOLD_CAPA / REVIEW
 *                hold the batch (inventory.lot_hold); a CAPA opens where the table says so;
 *                FAULTY_RAW_LOT also holds the named raw lot. A retest must be a different inspector.
 *   rework       only after a REWORK decision, once per decision, within the adjustment envelope;
 *                each one is a genealogy event when material from a lot went in. The next round
 *                is refused until the rework is recorded.
 *   PROM-3       every round is named QC1 or QC2 BY THE SERVER (before maceration: QC 1; once the rest
 *                has ended: QC 2; while resting: refused), and records what it compared with: the
 *                product's ACTIVE retained reference (a REFERENCE checkpoint's result must carry that
 *                bottle's sample code) or NO_REFERENCE_YET for a product that has none. With
 *                qc.reference_required on, a set without a REFERENCE checkpoint cannot be published,
 *                an expired reference holds QC, and QC 2 cannot approve without a retained sample of
 *                the batch. Approving against a missing or failed comparison is a Block: a reason is
 *                not a test result (system-led-operations.md 3.4).
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { PG_CLIENT, macerationProgress, referenceRuleInForce, restEndedAt, type AuthPrincipal } from '@core/backend-kernel';
import { drizzleExec } from '../floor-ops/floor-util.js';
import { referenceFor } from './reference-standard.service.js';
import { PolicyService, evaluateOrHold, reworkFrom } from './policy-port.js';
import { decideQc, type Checkpoint, type QcResult } from './qc-decision.js';
import { toBaseUnits } from './receiving-rule.js';
import { holdSubject, resolveRmLot } from './lot-trace.service.js';

type Row = Record<string, unknown>;
const TYPES = ['PASS_FAIL', 'RANGE', 'REFERENCE'];
const HOLDING = ['REJECT', 'HOLD_RETEST', 'HOLD_CAPA', 'REVIEW'];
/** Decisions after which no round of any stage is taken (the batch is decided). */
const FINAL = ['REJECT', 'REVIEW', 'HOLD_CAPA'];
export type QcStage = 'QC1' | 'QC2';

@Injectable()
export class QcFloorService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql, private readonly policy: PolicyService) {}

  /* ── checkpoint configurator ─────────────────────────────────────────────────────── */

  async checkpoints(productId: string) {
    const sets = await this.sql`select qc_checkpoint_set_id::text as "setId", version, reason, published_by as "publishedBy", published_dt as "publishedDt"
                                  from quality.qc_checkpoint_set where product_id = ${productId} order by version desc`;
    const current = sets[0] ? await this.setCheckpoints(this.sql, String(sets[0].setId)) : [];
    const pinned = await this.sql`select s.version, count(distinct r.oil_batch_id)::int as batches from quality.batch_qc_round r
                                    join quality.qc_checkpoint_set s on s.qc_checkpoint_set_id = r.qc_checkpoint_set_id
                                   where s.product_id = ${productId} group by s.version order by s.version desc`;
    return { productId, current: sets[0] ?? null, checkpoints: current, versions: sets, batchesPerVersion: pinned };
  }

  private async setCheckpoints(q: Sql | TransactionSql, setId: string): Promise<Checkpoint[]> {
    const rows = await q`select qc_checkpoint_id::text as id, name, check_type, min_value::float8 as min, max_value::float8 as max, critical, photo_required, instrument, reference_text, seq
                           from quality.qc_checkpoint where qc_checkpoint_set_id = ${setId} order by seq`;
    return rows.map((r) => ({ id: String(r.id), name: String(r.name), checkType: r.check_type as Checkpoint['checkType'], min: r.min as number | null, max: r.max as number | null,
      critical: !!r.critical, photoRequired: !!r.photo_required, instrument: (r.instrument as string) ?? null, referenceText: (r.reference_text as string) ?? null } as Checkpoint));
  }

  async publish(productId: string, body: Row, principal: AuthPrincipal) {
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Say why the checkpoints change: old batches keep the version they were tested on.');
    const list = Array.isArray(body.checkpoints) ? (body.checkpoints as Row[]) : [];
    if (!list.length) throw new BadRequestException('A product needs at least one checkpoint.');
    if ((await this.referenceRequired(this.sql, { productId })) && !list.some((c) => String(c.checkType ?? '').toUpperCase() === 'REFERENCE')) {
      throw new BadRequestException('A product sold with the reference promise needs a comparison to its retained reference: add a REFERENCE checkpoint.');
    }
    return this.sql.begin(async (tx) => {
      const prod = await tx`select 1 from packaging.product_master where product_id = ${productId}`;
      if (!prod.length) throw new NotFoundException('Product not found.');
      await tx`select pg_advisory_xact_lock(hashtext(${'qc_checkpoint_set:' + productId}))`;
      const next = Number((await tx`select coalesce(max(version), 0)::int + 1 as v from quality.qc_checkpoint_set where product_id = ${productId}`)[0]!.v);
      const set = (await tx`insert into quality.qc_checkpoint_set (product_id, version, reason, published_by) values (${productId}, ${next}, ${reason}, ${principal.userId})
                             returning qc_checkpoint_set_id::text as id`)[0]!;
      for (let i = 0; i < list.length; i++) {
        const c = list[i]!;
        let param: Row | undefined;
        if (c.qcParameterId) {
          param = (await tx`select check_type, instrument, critical_default, photo_required_default, parameter_name from quality.qc_parameter_master where qc_parameter_id = ${String(c.qcParameterId)}`)[0];
          if (!param) throw new BadRequestException(`Checkpoint ${i + 1}: that QC parameter does not exist.`);
        }
        const name = String(c.name ?? param?.parameter_name ?? '').trim();
        const type = String(c.checkType ?? param?.check_type ?? '').toUpperCase();
        if (!name) throw new BadRequestException(`Checkpoint ${i + 1} needs a name.`);
        if (!TYPES.includes(type)) throw new BadRequestException(`"${name}": the type must be pass/fail, a numeric range, or a comparison to the reference.`);
        const min = c.min == null || c.min === '' ? null : Number(c.min), max = c.max == null || c.max === '' ? null : Number(c.max);
        if (type === 'RANGE' && (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max) || min > max)) throw new BadRequestException(`"${name}": a range needs a minimum no greater than its maximum.`);
        await tx`insert into quality.qc_checkpoint (qc_checkpoint_set_id, seq, qc_parameter_id, name, check_type, min_value, max_value, reference_text, critical, photo_required, instrument)
                 values (${set.id}, ${i + 1}, ${(c.qcParameterId as string) ?? null}, ${name}, ${type}, ${type === 'RANGE' ? min : null}, ${type === 'RANGE' ? max : null},
                         ${(c.referenceText as string) ?? null}, ${c.critical != null ? c.critical === true : param?.critical_default === true},
                         ${c.photoRequired != null ? c.photoRequired === true : param?.photo_required_default === true}, ${(c.instrument as string) ?? (param?.instrument as string) ?? null})`;
      }
      await tx`update production.product_qc_spec set qc_checkpoint_set_id = ${set.id}, updated_by = ${principal.userId}, updated_dt = now() where product_id = ${productId}`;
      return { productId, setId: set.id, version: next };
    });
  }

  /** Extend a QC parameter with the configurator's defaults (12: "extended rather than replaced"). */
  async updateParameter(id: string, body: Row, principal: AuthPrincipal) {
    const type = body.checkType == null ? null : String(body.checkType).toUpperCase();
    if (type && !TYPES.includes(type)) throw new BadRequestException('The type must be PASS_FAIL, RANGE or REFERENCE.');
    const r = await this.sql`update quality.qc_parameter_master set check_type = coalesce(${type}, check_type), instrument = coalesce(${(body.instrument as string) ?? null}, instrument),
        critical_default = coalesce(${body.criticalDefault == null ? null : body.criticalDefault === true}, critical_default),
        photo_required_default = coalesce(${body.photoRequiredDefault == null ? null : body.photoRequiredDefault === true}, photo_required_default),
        updated_by = ${principal.userId}, updated_dt = now()
      where qc_parameter_id = ${id} returning qc_parameter_id::text as "qcParameterId", parameter_name as "parameterName", check_type as "checkType", instrument, critical_default as "criticalDefault", photo_required_default as "photoRequiredDefault"`;
    if (!r[0]) throw new NotFoundException('QC parameter not found.');
    return r[0];
  }

  /* ── QC rounds and rework ─────────────────────────────────────────────────────────── */

  private async referenceRequired(q: Sql | TransactionSql, ctx: { productId?: string | null; oilBatchId?: string | null }) {
    return (await referenceRuleInForce(drizzleExec(q as Sql), ctx)).value.required;
  }

  /**
   * PROM-3: which QC this round is, decided here and never by the caller. Before maceration it is QC 1;
   * once the rest has ended (days served, or a second person's early release) it is QC 2; while the
   * batch rests, or after it was released, no round is taken.
   */
  private async stageFor(q: Sql | TransactionSql, oilBatchId: string, now: Date): Promise<{ stage: QcStage; restEndedAt: Date | null } | { stage: null; note: string }> {
    const [open] = await q`select started_at, min_days, extend_days, max_days, early_release_at from production.maceration_run
                            where oil_batch_id = ${oilBatchId} and status = 'MACERATING'`;
    if (open) {
      const ended = restEndedAt(open as never, now);
      if (!ended) {
        const p = macerationProgress(open as never, now);
        return { stage: null, note: `The batch is resting (day ${p.day} of ${p.needDays}): QC 2 is taken when the rest ends.` };
      }
      return { stage: 'QC2', restEndedAt: ended };
    }
    const [closed] = await q`select 1 from production.maceration_run where oil_batch_id = ${oilBatchId} and status = 'CLOSED' limit 1`;
    if (closed) return { stage: null, note: 'This batch finished its rest and was released; no further round is taken here.' };
    return { stage: 'QC1', restEndedAt: null };
  }

  /** The QC context a screen needs: the next stage, the reference to compare with, the retained sample. */
  private async qcContext(oilBatchId: string, productId: string | null) {
    const now = new Date();
    const next = await this.stageFor(this.sql, oilBatchId, now);
    const required = await this.referenceRequired(this.sql, { productId, oilBatchId });
    const ref = productId ? await referenceFor(this.sql, productId, now) : null;
    const [pending] = productId ? await this.sql`select reference_standard_id::text as "referenceStandardId", reference_code as "referenceCode", proposed_by as "proposedBy"
                                                    from quality.reference_standard where product_id = ${productId} and status = 'PENDING'` : [];
    const [kept] = await this.sql`select sample_code as "sampleCode", retained_dt as "retainedAt" from quality.qc_sample_retention
                                   where oil_batch_id = ${oilBatchId} order by retained_dt desc nulls last limit 1`;
    return {
      stage: next.stage ? { next: next.stage, canRecord: true, note: next.stage === 'QC1' ? 'QC 1: before maceration.' : 'QC 2: the rest has ended.' } : { next: null, canRecord: false, note: next.note },
      reference: {
        required,
        active: ref?.kind === 'active' ? ref.ref : null,
        expired: ref?.kind === 'expired' ? ref.ref : null,
        pending: pending ?? null,
        note: !productId ? 'Choose the product to see its retained reference.'
          : ref?.kind === 'active' ? `Compare with ${ref.ref.referenceCode} (sample ${ref.ref.sampleCode ?? 'code not on file'}).`
          : ref?.kind === 'expired' ? `The retained reference ${ref.ref.referenceCode} has expired: QC is held until QC establishes a new one.`
          : 'This product has no retained reference yet: the round is recorded as compared with none, and an approved batch may be proposed as the reference.',
      },
      retainedSample: kept ?? null,
    };
  }

  async batch(oilBatchId: string) {
    const b = (await this.sql`select oil_batch_id::text as "oilBatchId", batch_number as "batchNumber", produced_qty::text as "producedQty", status from production.oil_batch_master where oil_batch_id = ${oilBatchId}`)[0];
    if (!b) throw new NotFoundException('Batch not found.');
    const rounds = await this.sql`select r.round_no as "roundNo", r.stage, r.reference_basis as "referenceBasis",
        (select reference_code from quality.reference_standard x where x.reference_standard_id = r.reference_standard_id) as "referenceCode", r.decision, r.defect_type as "defectType", r.reasons, r.rework_no as "reworkNo", r.inspector_id as "inspectorId",
        r.created_dt as "createdDt", s.version as "specVersion", pm.product_code as "specProductCode", r.qc_capa_id::text as "capaId" from quality.batch_qc_round r
        join quality.qc_checkpoint_set s on s.qc_checkpoint_set_id = r.qc_checkpoint_set_id
        /* RAC-CODES-RP-3: the spec's product, so a RAC product's spec version is named by its code. */
        left join packaging.product_master pm on pm.product_id = s.product_id where r.oil_batch_id = ${oilBatchId} order by r.round_no`;
    const reworks = await this.sql`select rework_no as "reworkNo", adjustment_mg::text as "adjustmentMg", note, created_by as "createdBy", created_dt as "createdDt" from quality.batch_rework where oil_batch_id = ${oilBatchId} order by rework_no`;
    const pin = (await this.sql`select qc_checkpoint_set_id::text as id from quality.batch_qc_round where oil_batch_id = ${oilBatchId} order by round_no limit 1`)[0];
    const hold = (await this.sql`select lot_hold_id::text as "lotHoldId", reason, held_dt as "heldDt" from inventory.lot_hold where subject_type = 'OIL_BATCH' and subject_id = ${oilBatchId} and released_dt is null`)[0] ?? null;
    const pinnedProduct = pin ? String((await this.sql`select product_id::text as p from quality.qc_checkpoint_set where qc_checkpoint_set_id = ${String(pin.id)}`)[0]!.p) : null;
    return { batch: b, rounds, reworks, hold, checkpoints: pin ? await this.setCheckpoints(this.sql, String(pin.id)) : null, productId: pinnedProduct,
      ...(await this.qcContext(oilBatchId, pinnedProduct)) };
  }

  /** PROM-3: the QC context for a product not yet pinned (the screen asks once the product is chosen). */
  async context(oilBatchId: string, productId: string | null) {
    return this.qcContext(oilBatchId, productId);
  }

  async recordRound(oilBatchId: string, body: Row, principal: AuthPrincipal) {
    // WALK2-RP-13: the faulty / added raw lot is typed or scanned by its lot number, not its uuid.
    if (body.rmBatchId) body = { ...body, rmBatchId: await resolveRmLot(this.sql, body.rmBatchId) };
    const results = Array.isArray(body.results) ? (body.results as QcResult[]) : [];
    return this.sql.begin(async (tx) => {
      const b = (await tx`select oil_batch_id, produced_qty::text as qty, u.uom_code from production.oil_batch_master o left join platform.uom_master u on u.uom_id = o.uom_id
                           where oil_batch_id = ${oilBatchId} for update of o`)[0];
      if (!b) throw new NotFoundException('Batch not found.');
      const prior = await tx`select round_no, decision, inspector_id, results, qc_checkpoint_set_id::text as set_id, rework_no, stage from quality.batch_qc_round where oil_batch_id = ${oilBatchId} order by round_no`;
      const last = prior[prior.length - 1];
      const now = new Date();
      const at = await this.stageFor(tx, oilBatchId, now);
      // QC 1 approved, then the rest, then QC 2: an approval closes its own stage, not the next one.
      const decided = () => new ConflictException(`This batch's last QC decision is ${last!.decision}; no further round is taken here.`);
      if (last && FINAL.includes(String(last.decision))) throw decided();
      if (at.stage === null) throw new ConflictException(at.note);
      if (last?.decision === 'APPROVE' && String(last.stage ?? 'QC1') === at.stage) throw decided();
      const stage = at.stage;
      const reworks = Number((await tx`select count(*)::int as n from quality.batch_rework where oil_batch_id = ${oilBatchId}`)[0]!.n);
      if (last?.decision === 'REWORK' && reworks < Number(last.rework_no) + 1) throw new ConflictException('Record the rework (what the mixer adjusted) before the re-QC.');

      let setId: string;
      if (prior.length) setId = String(prior[0]!.set_id);
      else {
        const productId = String(body.productId ?? '');
        if (!productId) throw new BadRequestException('Choose the product this batch is for: its checkpoint version is pinned on the first round.');
        const s = (await tx`select qc_checkpoint_set_id::text as id from quality.qc_checkpoint_set where product_id = ${productId} order by version desc limit 1`)[0];
        if (!s) throw new ConflictException('This product has no QC checkpoints published yet, so the batch cannot be tested.');
        setId = String(s.id);
      }
      const cps = await this.setCheckpoints(tx, setId);
      // PROM-3: what this round compares with. The product is the pinned set's.
      const setProduct = String((await tx`select product_id::text as p from quality.qc_checkpoint_set where qc_checkpoint_set_id = ${setId}`)[0]!.p);
      const refRequired = await this.referenceRequired(tx, { productId: setProduct, oilBatchId });
      const ref = await referenceFor(tx, setProduct, now);
      if (refRequired && ref.kind === 'expired') {
        throw new ConflictException(`The retained reference ${ref.ref.referenceCode} for this product has expired: QC is held until QC establishes a new one.`);
      }
      let referenceBasis: 'REFERENCE' | 'NO_REFERENCE_YET' | null = null;
      let referenceStandardId: string | null = null;
      if (ref.kind === 'active') {
        referenceBasis = 'REFERENCE';
        referenceStandardId = ref.ref.referenceStandardId;
        if (refRequired) {
          for (const c of cps.filter((x) => x.checkType === 'REFERENCE')) {
            const given = (results.find((r) => r.checkpointId === c.id) as (QcResult & { referenceSampleCode?: string }) | undefined)?.referenceSampleCode;
            // A reference with no sample code on file is not a bottle anyone can find: never let a blank scan match it.
            if (!String(ref.ref.sampleCode ?? '').trim()) throw new ConflictException(`The retained reference ${ref.ref.referenceCode} has no sample code on file: QC is held until the bottle is labelled.`);
            if (String(given ?? '').trim() !== String(ref.ref.sampleCode ?? '').trim()) {
              throw new BadRequestException(`"${c.name}": compare with the retained reference ${ref.ref.referenceCode} and scan its sample code${ref.ref.sampleCode ? ` (${ref.ref.sampleCode})` : ''}.`);
            }
          }
        }
      } else if (refRequired) {
        referenceBasis = 'NO_REFERENCE_YET';
      }
      const pol = await evaluateOrHold(this.policy, 'qc.rework', { record_type: 'oil_batch', record_id: oilBatchId, product: body.productId ?? null });
      const rework = reworkFrom(pol.value);
      if (last && String(last.inspector_id) === principal.userId && (last.decision === 'HOLD_RETEST' || (rework.differentInspector && last.decision === 'REWORK'))) {
        throw new ForbiddenException('A different QC person must take this round.');
      }
      const adj = Number((await tx`select coalesce(sum(adjustment_mg), 0)::bigint::text as s from quality.batch_rework where oil_batch_id = ${oilBatchId}`)[0]!.s);
      const failedByRound = prior.map((r) => {
        const res = (typeof r.results === 'string' ? JSON.parse(r.results) : r.results) as { failed?: string[] };
        return res.failed ?? [];
      });
      const batchMg = toBaseUnits(String(b.qty ?? ''), b.uom_code as string)?.base ?? 0;
      const d = decideQc({
        checkpoints: cps, results, defectType: (body.defectType as string) ?? null, instrumentDoubt: body.instrumentDoubt === true, policy: rework,
        history: { reworks, failedCheckpointsByRound: failedByRound, retests: prior.filter((r) => r.decision === 'HOLD_RETEST').length, cumulativeAdjustmentMg: adj, lastDecision: (last?.decision as string) ?? null },
        batchMg,
      });
      if (d.lotHold && !body.rmBatchId) throw new BadRequestException('Name the raw lot found faulty: it is frozen everywhere and every batch that used it is flagged.');
      // PROM-3: QC 2 approves only with a sample of this batch retained, so a complaint can be re-tested.
      if (refRequired && stage === 'QC2' && d.decision === 'APPROVE') {
        const [kept] = await tx`select 1 from quality.qc_sample_retention where oil_batch_id = ${oilBatchId} limit 1`;
        if (!kept) throw new ConflictException('Retain a sample of this batch before QC 2 approves it: a complaint about the lot is re-tested against it.');
      }
      const reasons = [...d.reasons];
      if (rework.envelopeDefaulted && d.decision === 'REWORK') reasons.push('Envelope: the plan\'s 5% (the qc.rework rule sets none).');
      if (!batchMg && d.decision === 'REVIEW') reasons.push('The batch weight is not recorded in a mass unit, so no adjustment fits the envelope.');

      let capaId: string | null = null;
      if (d.openCapa) {
        const code = 'CAPA-' + String(oilBatchId).replace(/-/g, '').slice(-8).toUpperCase() + '-' + (prior.length + 1);
        capaId = String((await tx`insert into quality.qc_capa (capa_code, capa_type, description, status, created_by, updated_by)
          values (${code}, 'CORRECTIVE', ${'Batch QC round ' + (prior.length + 1) + ': ' + reasons.join(' ')}, 'OPEN', ${principal.userId}, ${principal.userId}) returning qc_capa_id::text as id`)[0]!.id);
      }
      const round = (await tx`insert into quality.batch_qc_round (oil_batch_id, round_no, qc_checkpoint_set_id, inspector_id, results, defect_type, instrument_doubt, decision, reasons, rework_no, qc_capa_id, policy_rule_id, policy_version,
                                                                 stage, reference_standard_id, reference_basis)
        values (${oilBatchId}, ${prior.length + 1}, ${setId}, ${principal.userId}, ${JSON.stringify({ results, failed: d.failed })}::jsonb, ${(body.defectType as string) ?? null}, ${body.instrumentDoubt === true},
                ${d.decision}, ${JSON.stringify(reasons)}::jsonb, ${reworks}, ${capaId}, ${pol.ruleId}, ${pol.version}, ${stage}, ${referenceStandardId}, ${referenceBasis}) returning batch_qc_round_id::text as id, round_no`)[0]!;
      if (HOLDING.includes(d.decision)) await holdSubject(tx, 'OIL_BATCH', oilBatchId, `QC ${d.decision}: ${reasons.join(' ')}`, 'QC_ROUND', principal.userId);
      if (d.lotHold) await holdSubject(tx, 'RM_LOT', String(body.rmBatchId), 'Raw lot found faulty in batch QC', 'QC_ROUND', principal.userId);
      return { roundId: round.id, roundNo: round.round_no, stage, referenceBasis, referenceStandardId, decision: d.decision, failed: d.failed, reasons, capaId, lotHold: d.lotHold,
        policy: { ruleId: pol.ruleId, version: pol.version, explain: pol.explain } };
    });
  }

  async recordRework(oilBatchId: string, body: Row, principal: AuthPrincipal) {
    // WALK2-RP-13: the faulty / added raw lot is typed or scanned by its lot number, not its uuid.
    if (body.rmBatchId) body = { ...body, rmBatchId: await resolveRmLot(this.sql, body.rmBatchId) };
    const adj = body.adjustmentMg;
    const note = String(body.note ?? '').trim();
    if (typeof adj !== 'number' || !Number.isSafeInteger(adj) || adj < 0) throw new BadRequestException('The adjustment is a whole number of mg, 0 or more.');
    if (!note) throw new BadRequestException('Say what was adjusted (QC\'s note to the mixer).');
    return this.sql.begin(async (tx) => {
      const b = (await tx`select produced_qty::text as qty, u.uom_code from production.oil_batch_master o left join platform.uom_master u on u.uom_id = o.uom_id where oil_batch_id = ${oilBatchId} for update of o`)[0];
      if (!b) throw new NotFoundException('Batch not found.');
      const last = (await tx`select batch_qc_round_id::text as id, decision, rework_no from quality.batch_qc_round where oil_batch_id = ${oilBatchId} order by round_no desc limit 1`)[0];
      if (!last || last.decision !== 'REWORK') throw new ConflictException('A rework is only recorded after QC decided REWORK.');
      const n = Number(last.rework_no) + 1;
      if ((await tx`select 1 from quality.batch_rework where oil_batch_id = ${oilBatchId} and rework_no = ${n}`).length) throw new ConflictException('This rework is already recorded; the batch is waiting for its full re-QC.');
      const pol = await evaluateOrHold(this.policy, 'qc.rework', { record_type: 'oil_batch', record_id: oilBatchId });
      const rw = reworkFrom(pol.value);
      const batchMg = toBaseUnits(String(b.qty ?? ''), b.uom_code as string)?.base ?? 0;
      const used = Number((await tx`select coalesce(sum(adjustment_mg), 0)::bigint::text as s from quality.batch_rework where oil_batch_id = ${oilBatchId}`)[0]!.s);
      const envelope = Math.floor((batchMg * rw.envelopeBps) / 10000);
      if (used + adj > envelope) throw new ConflictException(`That takes the cumulative adjustment to ${used + adj} mg, past the ${envelope} mg envelope: the batch would be a different formula. It goes to review, not rework.`);
      await tx`insert into quality.batch_rework (oil_batch_id, rework_no, batch_qc_round_id, adjustment_mg, rm_batch_id, note, created_by)
               values (${oilBatchId}, ${n}, ${String(last.id)}, ${adj}, ${(body.rmBatchId as string) ?? null}, ${note}, ${principal.userId})`;
      if (body.rmBatchId) {
        await tx`insert into inventory.batch_genealogy_history (oil_batch_id, rm_batch_id, relationship_type, recorded_dt, status, created_by, updated_by)
                 values (${oilBatchId}, ${String(body.rmBatchId)}, 'REWORK_ADDITION', now(), 'ACTIVE', ${principal.userId}, ${principal.userId})`;
      }
      return { oilBatchId, reworkNo: n, adjustmentMg: adj, cumulativeMg: used + adj, envelopeMg: envelope, next: 'Full re-QC on every checkpoint.' };
    });
  }
}
