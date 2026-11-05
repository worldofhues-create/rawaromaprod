/**
 * PROD-B-5 — the 12.8 payment release gate over procurement.po_payment_release.
 *
 *   request   REQUESTED, capped by payment-gate.ts releasable() for its kind
 *   approve   APPROVED by someone who neither requested it nor raised the PO; the cap is re-checked
 *   release   RELEASED with a UTR/reference by someone who did not raise the PO; the cap is re-checked
 *   refuse    REFUSED with a reason; frees the amount
 *
 * The PO row is locked FOR UPDATE in every step, so two requests racing cannot both fit under the cap.
 * Terms come from procurement.payment_terms (lane A's PolicyService), which ships with no default:
 * until an admin publishes a rule every payment holds (409), as the owner decided.
 * Money: integer paise. PO value and accepted value are summed in numeric and rounded once.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { PolicyService, evaluateOrHold } from './policy-port.js';
import { checkMakerChecker, dueDate, parseTerms, releasable, type PoMoney, type ReleaseKind, type Terms } from './payment-gate.js';

type Row = Record<string, unknown>;
type Run = (q: string, p: unknown[]) => Promise<Row[]>;
const APPROVED_PO = ['APPROVED', 'ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'];

@Injectable()
export class PaymentReleaseService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql, private readonly policy: PolicyService) {}

  private async state(run: Run, poId: string, lock: boolean) {
    const po = (await run(`select purchase_order_id::text as id, po_number, vendor_id::text as vendor, status, created_by
                             from procurement.purchase_order where purchase_order_id = $1 ${lock ? 'for update' : ''}`, [poId]))[0];
    if (!po) throw new NotFoundException('Purchase order not found.');
    const m = (await run(`select
        coalesce(round(sum(coalesce(poi.amount, poi.ordered_qty * poi.rate)) * 100), 0)::bigint::text as po_value,
        coalesce((select round(sum(gi.accepted_qty * p2.rate) * 100) from inventory.grn_items gi
                   join inventory.grn_master g on g.grn_id = gi.grn_id
                   join procurement.purchase_order_items p2 on p2.purchase_order_item_id = gi.purchase_order_item_id
                  where g.purchase_order_id = $1), 0)::bigint::text as accepted,
        (select min(coalesce(g.grn_date, g.created_dt::date))::text from inventory.grn_master g where g.purchase_order_id = $1) as grn_date,
        (select min(ge.entry_dt)::date::text from inventory.gate_entry_master ge where ge.purchase_order_id = $1 and ge.invoice_number is not null) as invoice_date
       from procurement.purchase_order_items poi where poi.purchase_order_id = $1`, [poId]))[0]!;
    const rel = await run(`select kind, status, amount_paise::text as amount from procurement.po_payment_release where purchase_order_id = $1`, [poId]);
    const committed = { ADVANCE: 0, BALANCE: 0 } as Record<ReleaseKind, number>;
    let released = 0;
    for (const r of rel) {
      if (r.status === 'REFUSED') continue;
      committed[r.kind as ReleaseKind] += Number(r.amount);
      if (r.status === 'RELEASED') released += Number(r.amount);
    }
    const money: PoMoney = { poValuePaise: Number(m.po_value), poApproved: APPROVED_PO.includes(String(po.status).toUpperCase()), acceptedValuePaise: Number(m.accepted), committed };
    return { po, money, released, grnDate: (m.grn_date as string) ?? null, invoiceDate: (m.invoice_date as string) ?? null };
  }

  private async terms(po: Row) {
    const d = await evaluateOrHold(this.policy, 'procurement.payment_terms', { vendor: po.vendor, record_type: 'purchase_order', record_id: po.id });
    let t: Terms;
    try { t = parseTerms(d.value); } catch (e) { throw new ConflictException((e as Error).message); }
    return { t, d };
  }

  async summary(poId: string) {
    const run: Run = (q, p) => this.sql.unsafe(q, p as never[]) as unknown as Promise<Row[]>;
    const s = await this.state(run, poId, false);
    const releases = await run(`select po_payment_release_id::text as "releaseId", kind, amount_paise::text as "amountPaise", status, requested_by as "requestedBy",
        approved_by as "approvedBy", released_by as "releasedBy", utr, due_date::text as "dueDate", note, requested_dt as "requestedDt", released_dt as "releasedDt"
        from procurement.po_payment_release where purchase_order_id = $1 order by requested_dt`, [poId]);
    let terms: unknown = null, hold: string | null = null, can = { ADVANCE: 0, BALANCE: 0 }, due: string | null = null, policy: unknown = null;
    try {
      const { t, d } = await this.terms(s.po);
      terms = t; policy = { ruleId: d.ruleId, version: d.version, explain: d.explain };
      can = { ADVANCE: releasable(t, 'ADVANCE', s.money), BALANCE: releasable(t, 'BALANCE', s.money) };
      due = dueDate(t, { grnDate: s.grnDate, invoiceDate: s.invoiceDate });
    } catch (e) { if (e instanceof ConflictException) hold = e.message; else throw e; }
    return { purchaseOrderId: poId, poNumber: s.po.po_number, poCreatedBy: s.po.created_by, terms, policy, hold,
      poValuePaise: s.money.poValuePaise, acceptedValuePaise: s.money.acceptedValuePaise, releasedPaise: s.released,
      committedPaise: s.money.committed, releasablePaise: can, dueDate: due, releases };
  }

  async request(body: Row, principal: AuthPrincipal) {
    const poId = String(body.purchaseOrderId ?? '');
    const kind = body.kind === 'ADVANCE' ? 'ADVANCE' : body.kind === 'BALANCE' ? 'BALANCE' : null;
    const amount = body.amountPaise;
    if (!poId || !kind) throw new BadRequestException('Name the purchase order and whether this is the ADVANCE or the BALANCE.');
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) throw new BadRequestException('The amount must be a whole number of paise above 0.');
    return this.sql.begin(async (tx) => {
      const run: Run = (q, p) => tx.unsafe(q, p as never[]) as unknown as Promise<Row[]>;
      const s = await this.state(run, poId, true);
      const { t, d } = await this.terms(s.po);
      const cap = releasable(t, kind, s.money);
      if (amount > cap) throw new ConflictException(`That would pay more than is due: at most ₹${(cap / 100).toFixed(2)} can be requested as ${kind.toLowerCase()} now.`);
      const due = dueDate(t, { grnDate: s.grnDate, invoiceDate: s.invoiceDate });
      return (await run(`insert into procurement.po_payment_release (purchase_order_id, kind, amount_paise, terms, policy_rule_id, policy_version, status, requested_by, due_date, note)
          values ($1, $2, $3, $4::jsonb, $5, $6, 'REQUESTED', $7, $8, $9)
          returning po_payment_release_id::text as "releaseId", status, amount_paise::text as "amountPaise", due_date::text as "dueDate"`,
        [poId, kind, amount, JSON.stringify(t), d.ruleId, d.version, principal.userId, due, body.note ? String(body.note) : null]))[0];
    });
  }

  private async step(id: string, _principal: AuthPrincipal, fn: (r: Row, s: Awaited<ReturnType<PaymentReleaseService['state']>>, run: Run) => Promise<Row>) {
    return this.sql.begin(async (tx) => {
      const run: Run = (q, p) => tx.unsafe(q, p as never[]) as unknown as Promise<Row[]>;
      const r0 = (await run('select purchase_order_id::text as po from procurement.po_payment_release where po_payment_release_id = $1', [id]))[0];
      if (!r0) throw new NotFoundException('Payment request not found.');
      const s = await this.state(run, String(r0.po), true);
      const r = (await run('select *, amount_paise::text as amount from procurement.po_payment_release where po_payment_release_id = $1 for update', [id]))[0]!;
      return fn(r, s, run);
    });
  }

  /** The cap without this row: what else is committed must still leave room for it. */
  private recheck(r: Row, s: { money: PoMoney }) {
    const t = parseTerms(typeof r.terms === 'string' ? JSON.parse(r.terms) : r.terms);
    const kind = r.kind as ReleaseKind;
    const others = { ...s.money, committed: { ...s.money.committed, [kind]: s.money.committed[kind] - Number(r.amount) } };
    const cap = releasable(t, kind, others);
    if (Number(r.amount) > cap) throw new ConflictException(`This payment no longer fits: at most ₹${(cap / 100).toFixed(2)} is due as ${kind.toLowerCase()} now (goods were rejected or other payments went first).`);
  }

  async approve(id: string, principal: AuthPrincipal) {
    return this.step(id, principal, async (r, s, run) => {
      if (r.status !== 'REQUESTED') throw new ConflictException(`This payment is ${r.status}, not waiting for approval.`);
      checkMakerChecker('approve', { actor: principal.userId, requestedBy: String(r.requested_by), poCreatedBy: (s.po.created_by as string) ?? null });
      this.recheck(r, s);
      return (await run(`update procurement.po_payment_release set status = 'APPROVED', approved_by = $2, approved_dt = now() where po_payment_release_id = $1
                         returning po_payment_release_id::text as "releaseId", status`, [id, principal.userId]))[0]!;
    });
  }

  async release(id: string, body: Row, principal: AuthPrincipal) {
    const utr = String(body.utr ?? '').trim();
    if (!utr) throw new BadRequestException('Enter the UTR or bank reference for this payment.');
    return this.step(id, principal, async (r, s, run) => {
      if (r.status !== 'APPROVED') throw new ConflictException(r.status === 'REQUESTED' ? 'Approve this payment before releasing it.' : `This payment is ${r.status}.`);
      checkMakerChecker('release', { actor: principal.userId, requestedBy: String(r.requested_by), poCreatedBy: (s.po.created_by as string) ?? null });
      this.recheck(r, s);
      if ((await run('select 1 from procurement.po_payment_release where upper(utr) = upper($1)', [utr])).length) throw new ConflictException('That UTR is already recorded on another payment.');
      return (await run(`update procurement.po_payment_release set status = 'RELEASED', released_by = $2, released_dt = now(), utr = $3 where po_payment_release_id = $1
                         returning po_payment_release_id::text as "releaseId", status, utr`, [id, principal.userId, utr]))[0]!;
    });
  }

  async refuse(id: string, body: Row, principal: AuthPrincipal) {
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Say why the payment is refused.');
    return this.step(id, principal, async (r, _s, run) => {
      if (r.status === 'RELEASED' || r.status === 'REFUSED') throw new ConflictException(`This payment is already ${r.status}.`);
      return (await run(`update procurement.po_payment_release set status = 'REFUSED', note = coalesce(note || ' / ', '') || $2 where po_payment_release_id = $1
                         returning po_payment_release_id::text as "releaseId", status`, [id, 'Refused by ' + principal.userId + ': ' + reason]))[0]!;
    });
  }
}
