/**
 * PROM-3 (LD-85, ALEMBIC docs/plan/program/process-promises.md P-03, S-06, S-08): the retained
 * reference a product's QC 1 and QC 2 compare with.
 *
 *   A reference is a PHYSICAL bottle: the retained sample (quality.qc_sample_retention) of a batch that
 *   passed QC on every checkpoint. One ACTIVE reference per product (a RawProd product row is one code
 *   and grade); a unique index holds it.
 *
 *   propose   QC names the batch and why (quality:reference_standard:write). The batch's latest round
 *             must be APPROVE with nothing failed, and a sample of it must be retained.
 *   approve   Stop, second person: someone other than the proposer, signed in within five minutes
 *             (@FreshAuth on the route), approves (quality:reference_standard:approve). When the
 *             product already has an ACTIVE reference, approving retires it, with a reason, and names
 *             this one as its successor: "Retiring one needs a reason and names its successor".
 *   decline   with a reason (toward caution, one person).
 *
 * Nothing is seeded and nothing is derived: until QC proposes and a second person approves a bottle,
 * the product has no reference, its rounds record NO_REFERENCE_YET, and the lot page says so.
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';

type Q = Sql | TransactionSql;
type Row = Record<string, unknown>;

export interface ActiveReference {
  referenceStandardId: string;
  referenceCode: string;
  sampleCode: string | null;
  retainedAt: string | null;
  expiresAt: string | null;
}

const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/** The product's reference as QC must use it now. `none` = none was ever approved (the first batches
 *  of a product); `expired` = one exists but is past its date, so QC is held until a new one is set. */
export async function referenceFor(q: Q, productId: string, now: Date): Promise<
  { kind: 'active'; ref: ActiveReference } | { kind: 'none' } | { kind: 'expired'; ref: ActiveReference }
> {
  const [r] = await q`
    select rs.reference_standard_id::text as id, rs.reference_code, rs.expires_at, s.sample_code, s.retained_dt
      from quality.reference_standard rs
      left join quality.qc_sample_retention s on s.qc_sample_retention_id = rs.qc_sample_retention_id
     where rs.product_id = ${productId} and rs.status = 'ACTIVE'`;
  if (!r) return { kind: 'none' };
  const ref: ActiveReference = {
    referenceStandardId: String(r.id), referenceCode: String(r.reference_code), sampleCode: (r.sample_code as string | null) ?? null,
    retainedAt: iso(r.retained_dt), expiresAt: iso(r.expires_at),
  };
  if (ref.expiresAt && Date.parse(ref.expiresAt) <= now.getTime()) return { kind: 'expired', ref };
  return { kind: 'active', ref };
}

@Injectable()
export class ReferenceStandardService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async list(productId: string) {
    const rows = await this.sql`
      select rs.reference_standard_id::text as "referenceStandardId", rs.reference_code as "referenceCode", rs.status,
             rs.oil_batch_id::text as "oilBatchId", ob.batch_number as "batchNumber", s.sample_code as "sampleCode", s.retained_dt as "retainedAt",
             rs.proposed_by as "proposedBy", rs.proposed_dt as "proposedAt", rs.proposal_reason as "proposalReason",
             rs.approved_by as "approvedBy", rs.approved_dt as "approvedAt", rs.expires_at as "expiresAt",
             rs.retired_dt as "retiredAt", rs.retired_reason as "retiredReason", rs.successor_id::text as "successorId",
             rs.declined_dt as "declinedAt", rs.declined_reason as "declinedReason"
        from quality.reference_standard rs
        left join quality.qc_sample_retention s on s.qc_sample_retention_id = rs.qc_sample_retention_id
        left join production.oil_batch_master ob on ob.oil_batch_id = rs.oil_batch_id
       where rs.product_id = ${productId}
       order by rs.proposed_dt desc limit 100`;
    return { productId, items: rows };
  }

  async propose(body: Row, principal: AuthPrincipal) {
    const oilBatchId = String(body.oilBatchId ?? '');
    const reason = String(body.reason ?? '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(oilBatchId)) throw new BadRequestException('Name the batch whose retained sample becomes the reference.');
    if (!reason) throw new BadRequestException('Say why this batch is the reference.');
    const expiresAt = body.expiresAt == null || body.expiresAt === '' ? null : new Date(String(body.expiresAt));
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new BadRequestException('The expiry is not a date.');
    return this.sql.begin(async (tx) => {
      const [b] = await tx`select o.oil_batch_id, o.batch_number, o.status, po.formula_version_id from production.oil_batch_master o
                             left join production.production_order po on po.production_order_id = o.production_order_id
                            where o.oil_batch_id = ${oilBatchId}`;
      if (!b) throw new NotFoundException('Batch not found.');
      if (String(b.status ?? '').toUpperCase() === 'FAILED') throw new ConflictException('A failed batch cannot be the reference.');
      const [last] = await tx`select r.decision, r.results, s.product_id::text as product_id from quality.batch_qc_round r
                                join quality.qc_checkpoint_set s on s.qc_checkpoint_set_id = r.qc_checkpoint_set_id
                               where r.oil_batch_id = ${oilBatchId} order by r.round_no desc limit 1`;
      const res = last ? ((typeof last.results === 'string' ? JSON.parse(last.results) : last.results) as { failed?: string[] }) : null;
      if (!last || last.decision !== 'APPROVE' || (res?.failed ?? []).length) {
        throw new ConflictException('Only a batch that passed QC on every checkpoint can be the reference: its latest round is not an approval.');
      }
      const productId = String(last.product_id);
      const [kept] = await tx`select qc_sample_retention_id::text as id from quality.qc_sample_retention
                               where oil_batch_id = ${oilBatchId} order by retained_dt desc nulls last limit 1`;
      if (!kept) throw new ConflictException('Retain a sample of this batch first: the reference is that bottle.');
      await tx`select pg_advisory_xact_lock(hashtext(${'reference_standard:' + productId}))`;
      const [pending] = await tx`select reference_code from quality.reference_standard where product_id = ${productId} and status = 'PENDING'`;
      if (pending) throw new ConflictException(`${pending.reference_code} is already waiting for a second person for this product.`);
      const [prod] = await tx`select product_code from packaging.product_master where product_id = ${productId}`;
      const n = Number((await tx`select count(*)::int as n from quality.reference_standard where product_id = ${productId}`)[0]!.n) + 1;
      const code = `R-${String(prod?.product_code ?? productId.slice(0, 8)).toUpperCase()}-${n}`;
      const [row] = await tx`
        insert into quality.reference_standard (reference_code, product_id, oil_batch_id, qc_sample_retention_id, formula_version_ref, status,
                                                proposed_by, proposal_reason, expires_at)
        values (${code}, ${productId}, ${oilBatchId}, ${String(kept.id)}, ${(b.formula_version_id as string | null) ?? null}, 'PENDING',
                ${principal.userId}, ${reason.slice(0, 500)}, ${expiresAt ? expiresAt.toISOString() : null})
        returning reference_standard_id::text as id`;
      return { referenceStandardId: String(row!.id), referenceCode: code, status: 'PENDING', next: 'A second person approves or declines it.' };
    });
  }

  async approve(id: string, body: Row, principal: AuthPrincipal) {
    return this.sql.begin(async (tx) => {
      const [r] = await tx`select * from quality.reference_standard where reference_standard_id = ${id} for update`;
      if (!r) throw new NotFoundException('That reference was not found.');
      if (r.status !== 'PENDING') throw new ConflictException(`That reference is ${String(r.status).toLowerCase()}.`);
      if (String(r.proposed_by) === principal.userId) throw new ForbiddenException('You proposed this reference, so someone else must approve it.');
      await tx`select pg_advisory_xact_lock(hashtext(${'reference_standard:' + String(r.product_id)}))`;
      const [active] = await tx`select reference_standard_id::text as id, reference_code from quality.reference_standard
                                 where product_id = ${String(r.product_id)} and status = 'ACTIVE' for update`;
      const now = new Date().toISOString();
      if (active) {
        const why = String(body.retireReason ?? '').trim();
        if (!why) throw new BadRequestException(`Say why ${active.reference_code} is retired: this one replaces it.`);
        await tx`update quality.reference_standard set status = 'RETIRED', retired_by = ${principal.userId}, retired_dt = ${now}::timestamptz,
                   retired_reason = ${why.slice(0, 500)}, successor_id = ${id} where reference_standard_id = ${String(active.id)}`;
      }
      await tx`update quality.reference_standard set status = 'ACTIVE', approved_by = ${principal.userId}, approved_dt = ${now}::timestamptz,
                 replaces_id = ${active ? String(active.id) : null} where reference_standard_id = ${id}`;
      return { referenceStandardId: id, referenceCode: String(r.reference_code), status: 'ACTIVE', retired: active ? String(active.reference_code) : null };
    });
  }

  async decline(id: string, body: Row, principal: AuthPrincipal) {
    const why = String(body.reason ?? '').trim();
    if (!why) throw new BadRequestException('Say why the reference is declined.');
    const rows = await this.sql`update quality.reference_standard set status = 'DECLINED', declined_by = ${principal.userId}, declined_dt = now(),
                                  declined_reason = ${why.slice(0, 500)} where reference_standard_id = ${id} and status = 'PENDING' returning reference_code`;
    if (!rows.length) throw new ConflictException('No reference waiting with that id.');
    return { referenceStandardId: id, referenceCode: String(rows[0]!.reference_code), status: 'DECLINED' };
  }
}
