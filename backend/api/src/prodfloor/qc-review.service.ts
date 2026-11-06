/**
 * PROD-D-5 — the QC review decision (production-floor plan 12.7.4; lane B sent batches to REVIEW and
 * stopped there). A batch is in review when its latest QC round decided REVIEW. Its options come from
 * qc-review.ts: reject always; downgrade only when production.product_downgrade_target defines a grade
 * or product for the batch's product; reblend only when production.formula_reblend_rule allows it for
 * the batch's formula.
 *
 *   propose   a perfumer or a vault approver proposes one outcome with a reason (one live decision per
 *             batch, enforced by a partial unique index).
 *   confirm   the other signature, by a different person, makes it final. Confirming writes the
 *             genealogy (inventory.batch_genealogy_history: QC_REVIEW_REJECT | QC_REVIEW_DOWNGRADE |
 *             QC_REVIEW_REBLEND on the batch, REBLEND_RECEIVED on the receiving batch when named), opens
 *             a CAPA on a reject, and rewrites the batch's QC hold reason to say what was decided. The
 *             hold is not released here: a downgraded batch is tested against its new spec and a
 *             reblended one leaves only through the batch it goes into.
 *   withdraw  the proposer may withdraw before it is confirmed, with a reason.
 *
 * The batch's product is the one its pinned checkpoint set names; its formula is the product's, or the
 * production order's plan item's.
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { reviewOptions, signatureFor, checkProposal, checkConfirm, type ReviewContext, type Signature } from './qc-review.js';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENEALOGY: Record<string, string> = { REJECT: 'QC_REVIEW_REJECT', DOWNGRADE: 'QC_REVIEW_DOWNGRADE', REBLEND: 'QC_REVIEW_REBLEND' };

@Injectable()
export class QcReviewService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async list() {
    return this.sql`
      select ob.oil_batch_id::text as "oilBatchId", ob.batch_number as "batchNumber", r.round_no as "roundNo", r.reasons, r.created_dt as "reviewSince",
             pm.product_name as "productName", d.outcome as "proposedOutcome", d.status as "decisionStatus", d.proposed_as as "proposedAs"
        from (select distinct on (oil_batch_id) * from quality.batch_qc_round order by oil_batch_id, round_no desc) r
        join production.oil_batch_master ob on ob.oil_batch_id = r.oil_batch_id
        left join quality.qc_checkpoint_set s on s.qc_checkpoint_set_id = r.qc_checkpoint_set_id
        left join packaging.product_master pm on pm.product_id = s.product_id
        left join quality.batch_review_decision d on d.oil_batch_id = r.oil_batch_id and d.status in ('PROPOSED', 'CONFIRMED')
       where r.decision = 'REVIEW'
       order by (d.status = 'CONFIRMED') nulls first, r.created_dt`;
  }

  private async context(q: Sql | TransactionSql, oilBatchId: string): Promise<{ ctx: ReviewContext; round: Row }> {
    const round = (await q`select r.batch_qc_round_id::text as id, r.round_no, r.decision, r.reasons, s.product_id::text as product_id
                             from quality.batch_qc_round r left join quality.qc_checkpoint_set s on s.qc_checkpoint_set_id = r.qc_checkpoint_set_id
                            where r.oil_batch_id = ${oilBatchId} order by r.round_no desc limit 1`)[0];
    if (!round) throw new NotFoundException('This batch has no QC round.');
    const productId = (round.product_id as string) ?? null;
    const pm = productId ? (await q`select product_name, formula_id::text as formula_id from packaging.product_master where product_id = ${productId}`)[0] : undefined;
    const viaOrder = (await q`select ppi.formula_id::text as formula_id from production.oil_batch_master ob
                                join production.production_order po on po.production_order_id = ob.production_order_id
                                join production.production_plan_items ppi on ppi.production_plan_item_id = po.production_plan_item_id
                               where ob.oil_batch_id = ${oilBatchId}`)[0];
    const formulaId = (pm?.formula_id as string) ?? (viaOrder?.formula_id as string) ?? null;
    const dg = productId ? (await q`select d.target_product_id::text as tpid, d.target_grade, t.product_name as tname from production.product_downgrade_target d
                                       left join packaging.product_master t on t.product_id = d.target_product_id where d.product_id = ${productId}`)[0] : undefined;
    const rb = formulaId ? (await q`select reblend_allowed, max_share_bps from production.formula_reblend_rule where formula_id = ${formulaId}`)[0] : undefined;
    return {
      round,
      ctx: {
        productId, productName: (pm?.product_name as string) ?? null, formulaId,
        downgrade: dg ? { targetProductId: (dg.tpid as string) ?? null, targetProductName: (dg.tname as string) ?? null, targetGrade: (dg.target_grade as string) ?? null } : null,
        reblend: rb ? { allowed: !!rb.reblend_allowed, maxShareBps: rb.max_share_bps == null ? null : Number(rb.max_share_bps) } : null,
      },
    };
  }

  private async batchRow(q: Sql | TransactionSql, oilBatchId: string, lock = false) {
    if (!UUID.test(oilBatchId)) throw new BadRequestException('That is not a batch id.');
    const b = lock
      ? (await q`select oil_batch_id::text as "oilBatchId", batch_number as "batchNumber", produced_qty::text as "producedQty", status from production.oil_batch_master where oil_batch_id = ${oilBatchId} for update`)[0]
      : (await q`select oil_batch_id::text as "oilBatchId", batch_number as "batchNumber", produced_qty::text as "producedQty", status from production.oil_batch_master where oil_batch_id = ${oilBatchId}`)[0];
    if (!b) throw new NotFoundException('Batch not found.');
    return b;
  }

  private async live(q: Sql | TransactionSql, oilBatchId: string) {
    return (await q`select batch_review_decision_id::text as id, outcome, reason, status, proposed_by as "proposedBy", proposed_as as "proposedAs", proposed_dt as "proposedDt",
                           confirmed_by as "confirmedBy", confirmed_as as "confirmedAs", confirmed_dt as "confirmedDt", target_product_id::text as "targetProductId",
                           target_grade as "targetGrade", reblend_into_oil_batch_id::text as "reblendIntoOilBatchId", reblend_share_bps as "reblendShareBps", qc_capa_id::text as "capaId"
                      from quality.batch_review_decision where oil_batch_id = ${oilBatchId} and status in ('PROPOSED', 'CONFIRMED')`)[0] ?? null;
  }

  async detail(oilBatchId: string) {
    const batch = await this.batchRow(this.sql, oilBatchId);
    const { ctx, round } = await this.context(this.sql, oilBatchId);
    const rounds = await this.sql`select round_no as "roundNo", decision, defect_type as "defectType", reasons, rework_no as "reworkNo", created_dt as "createdDt"
                                    from quality.batch_qc_round where oil_batch_id = ${oilBatchId} order by round_no`;
    const reworks = await this.sql`select rework_no as "reworkNo", adjustment_mg::text as "adjustmentMg", note, created_dt as "createdDt" from quality.batch_rework where oil_batch_id = ${oilBatchId} order by rework_no`;
    const hold = (await this.sql`select reason, held_dt as "heldDt" from inventory.lot_hold where subject_type = 'OIL_BATCH' and subject_id = ${oilBatchId} and released_dt is null`)[0] ?? null;
    const history = await this.sql`select outcome, status, reason, proposed_as as "proposedAs", proposed_dt as "proposedDt", withdrawn_reason as "withdrawnReason"
                                     from quality.batch_review_decision where oil_batch_id = ${oilBatchId} and status = 'WITHDRAWN' order by proposed_dt`;
    return {
      batch, inReview: round.decision === 'REVIEW', product: { productId: ctx.productId, productName: ctx.productName, formulaId: ctx.formulaId },
      options: reviewOptions(ctx), decision: await this.live(this.sql, oilBatchId), withdrawn: history, rounds, reworks, hold,
    };
  }

  async propose(oilBatchId: string, body: Row, principal: AuthPrincipal) {
    const sign = signatureFor(principal.permissions ?? [], body.signAs as string | undefined);
    return this.sql.begin(async (tx) => {
      await this.batchRow(tx, oilBatchId, true);
      const { ctx, round } = await this.context(tx, oilBatchId);
      if (round.decision !== 'REVIEW') throw new ConflictException(`This batch is not in review: its last QC decision is ${round.decision}.`);
      if (await this.live(tx, oilBatchId)) throw new ConflictException('A decision is already proposed for this batch: confirm or withdraw it first.');
      const p = checkProposal(body.outcome, body, reviewOptions(ctx), ctx);
      if (p.reblendIntoOilBatchId) await this.checkReceiver(tx, oilBatchId, p.reblendIntoOilBatchId, ctx.formulaId);
      const row = (await tx`insert into quality.batch_review_decision (oil_batch_id, batch_qc_round_id, outcome, reason, target_product_id, target_grade, reblend_into_oil_batch_id, reblend_share_bps, proposed_by, proposed_as)
        values (${oilBatchId}, ${String(round.id)}, ${p.outcome}, ${p.reason}, ${p.targetProductId}, ${p.targetGrade}, ${p.reblendIntoOilBatchId}, ${p.reblendShareBps}, ${principal.userId}, ${sign})
        returning batch_review_decision_id::text as id`)[0]!;
      return { decisionId: row.id, outcome: p.outcome, status: 'PROPOSED', proposedAs: sign,
        next: sign === 'PERFUMER' ? 'A vault approver (a different person) confirms it.' : 'A perfumer (a different person) confirms it.' };
    });
  }

  private async checkReceiver(tx: TransactionSql, from: string, into: string, formulaId: string | null) {
    if (!UUID.test(into)) throw new BadRequestException('The receiving batch is not a batch id.');
    if (into === from) throw new BadRequestException('A batch cannot be reblended into itself.');
    const t = (await tx`select ob.oil_batch_id, ppi.formula_id::text as formula_id from production.oil_batch_master ob
                          left join production.production_order po on po.production_order_id = ob.production_order_id
                          left join production.production_plan_items ppi on ppi.production_plan_item_id = po.production_plan_item_id
                         where ob.oil_batch_id = ${into}`)[0];
    if (!t) throw new NotFoundException('The receiving batch does not exist.');
    if ((await tx`select 1 from inventory.lot_hold where subject_type = 'OIL_BATCH' and subject_id = ${into} and released_dt is null`).length) throw new ConflictException('The receiving batch is itself on hold.');
    if (formulaId && t.formula_id && t.formula_id !== formulaId) throw new ConflictException('The receiving batch is a different formula: reblending is allowed only into the same formula.');
  }

  async confirm(oilBatchId: string, body: Row, principal: AuthPrincipal) {
    const sign: Signature = signatureFor(principal.permissions ?? [], body.signAs as string | undefined);
    return this.sql.begin(async (tx) => {
      await this.batchRow(tx, oilBatchId, true);
      const d = await this.live(tx, oilBatchId);
      if (!d) throw new NotFoundException('Nothing is proposed for this batch.');
      checkConfirm({ proposedBy: String(d.proposedBy), proposedAs: d.proposedAs as Signature, status: String(d.status) }, principal.userId, sign);
      // The options are re-checked at confirm: a target or rule removed since the proposal stops it.
      const { ctx } = await this.context(tx, oilBatchId);
      const opt = reviewOptions(ctx)[d.outcome as 'REJECT' | 'DOWNGRADE' | 'REBLEND'];
      if (!opt.enabled) throw new ConflictException(`${opt.why} The proposal can no longer be confirmed; withdraw it.`);
      const b = (await tx`select batch_number from production.oil_batch_master where oil_batch_id = ${oilBatchId}`)[0]!;
      let capaId: string | null = null;
      if (d.outcome === 'REJECT') {
        const code = 'CAPA-' + oilBatchId.replace(/-/g, '').slice(-8).toUpperCase() + '-RV';
        capaId = String((await tx`insert into quality.qc_capa (capa_code, capa_type, description, status, created_by, updated_by)
          values (${code}, 'CORRECTIVE', ${'QC review rejected batch ' + (b.batch_number ?? oilBatchId) + ': ' + d.reason}, 'OPEN', ${principal.userId}, ${principal.userId}) returning qc_capa_id::text as id`)[0]!.id);
      }
      await tx`update quality.batch_review_decision set status = 'CONFIRMED', confirmed_by = ${principal.userId}, confirmed_as = ${sign}, confirmed_dt = now(), qc_capa_id = ${capaId}
                where batch_review_decision_id = ${String(d.id)}`;
      await tx`insert into inventory.batch_genealogy_history (oil_batch_id, relationship_type, recorded_dt, status, created_by, updated_by)
               values (${oilBatchId}, ${GENEALOGY[String(d.outcome)]!}, now(), 'ACTIVE', ${principal.userId}, ${principal.userId})`;
      if (d.outcome === 'REBLEND' && d.reblendIntoOilBatchId) {
        await tx`insert into inventory.batch_genealogy_history (oil_batch_id, relationship_type, recorded_dt, status, created_by, updated_by)
                 values (${String(d.reblendIntoOilBatchId)}, 'REBLEND_RECEIVED', now(), 'ACTIVE', ${principal.userId}, ${principal.userId})`;
      }
      const what = d.outcome === 'REJECT' ? 'rejected: written off or returned for disposal'
        : d.outcome === 'DOWNGRADE' ? `downgraded to ${d.targetGrade ?? ctx.downgrade?.targetProductName ?? 'the defined product'}: QC against that spec before release`
        : `to be reblended (${Number(d.reblendShareBps) / 100}% of the receiving batch)`;
      await tx`update inventory.lot_hold set reason = ${'QC review ' + what + '. ' + d.reason} where subject_type = 'OIL_BATCH' and subject_id = ${oilBatchId} and released_dt is null`;
      return { decisionId: d.id, outcome: d.outcome, status: 'CONFIRMED', capaId, genealogy: GENEALOGY[String(d.outcome)] };
    });
  }

  async withdraw(oilBatchId: string, body: Row, principal: AuthPrincipal) {
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Say why the proposal is withdrawn.');
    return this.sql.begin(async (tx) => {
      await this.batchRow(tx, oilBatchId, true);
      const d = await this.live(tx, oilBatchId);
      if (!d || d.status !== 'PROPOSED') throw new ConflictException('There is no open proposal to withdraw.');
      if (d.proposedBy !== principal.userId) throw new ForbiddenException('Only the person who proposed it can withdraw it.');
      await tx`update quality.batch_review_decision set status = 'WITHDRAWN', withdrawn_reason = ${reason} where batch_review_decision_id = ${String(d.id)}`;
      return { decisionId: d.id, status: 'WITHDRAWN' };
    });
  }

  /* ── what review may choose: defined ahead of a failure, never at it ─────────────────── */

  async setDowngradeTarget(productId: string, body: Row, principal: AuthPrincipal) {
    if (!UUID.test(productId)) throw new BadRequestException('Choose a product.');
    const reason = String(body.reason ?? '').trim();
    const tp = body.targetProductId ? String(body.targetProductId) : null, grade = String(body.targetGrade ?? '').trim() || null;
    if (!reason) throw new BadRequestException('Say why this downgrade path exists.');
    if (!tp && !grade) throw new BadRequestException('Name the grade or the product a downgraded batch is sold as.');
    if (tp === productId) throw new BadRequestException('A product cannot be downgraded to itself.');
    if (!(await this.sql`select 1 from packaging.product_master where product_id = ${productId}`).length) throw new NotFoundException('Product not found.');
    if (tp && !(await this.sql`select 1 from packaging.product_master where product_id = ${tp}`).length) throw new NotFoundException('The target product does not exist.');
    await this.sql`insert into production.product_downgrade_target (product_id, target_product_id, target_grade, reason, set_by) values (${productId}, ${tp}, ${grade}, ${reason}, ${principal.userId})
                   on conflict (product_id) do update set target_product_id = excluded.target_product_id, target_grade = excluded.target_grade, reason = excluded.reason, set_by = excluded.set_by, set_dt = now()`;
    return { productId, targetProductId: tp, targetGrade: grade };
  }

  async setReblendRule(formulaId: string, body: Row, principal: AuthPrincipal) {
    if (!UUID.test(formulaId)) throw new BadRequestException('That is not a formula id.');
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Say why.');
    const allowed = body.reblendAllowed === true;
    const pct = body.maxSharePct;
    let bps: number | null = null;
    if (allowed) {
      if (typeof pct !== 'number' || !(pct > 0) || pct > 100) throw new BadRequestException('Give the most a reblended batch may make up of the receiving batch, as a percentage above 0 and at most 100.');
      bps = Math.round(pct * 100);
    }
    await this.sql`insert into production.formula_reblend_rule (formula_id, reblend_allowed, max_share_bps, reason, set_by) values (${formulaId}, ${allowed}, ${bps}, ${reason}, ${principal.userId})
                   on conflict (formula_id) do update set reblend_allowed = excluded.reblend_allowed, max_share_bps = excluded.max_share_bps, reason = excluded.reason, set_by = excluded.set_by, set_dt = now()`;
    return { formulaId, reblendAllowed: allowed, maxShareBps: bps };
  }
}
