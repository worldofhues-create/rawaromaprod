/**
 * PROD-B-4 — the material audit kiosk behind the receiving screen (plan 4, 12.1, 13).
 *
 *   gate hold   a gate entry with no PO, a PO that is not open, or a vendor that is not the PO's is
 *               HELD at the gate (GateService writes hold_reason); the audit refuses a held entry.
 *   preview     GET a PO with each line's ordered and already-accepted quantity in base units and the
 *               shortfall rule that applies, before the truck arrives (12.1 "isn't surprised").
 *   submit      one audit per gate entry: the checklist per line, the decision from receiving-rule.ts,
 *               the GRN (through GrnService, in the same transaction, so its RM batches go to
 *               quarantine as before), the audit rows naming the policy rule + version, and a debit
 *               note for rejected and short quantities. The PO row is locked so two kiosks submitting
 *               against one PO serialise and the cumulative total cannot be double counted.
 *   override    a partial accept/reject on a line is admin/owner only (12.0) and shows OVERRIDDEN.
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import * as inventorySchema from '@ra/data-inventory';
import { GrnService } from '@ra/cluster-inventory';
import { PolicyService, evaluateOrHold, shortfallFrom } from './policy-port.js';
import { decideReceiving, debitNoteLines, toBaseUnits, type AuditLineInput } from './receiving-rule.js';

/** PO statuses a delivery may be received against. Anything else (DRAFT, CANCELLED, AMENDED, CLOSED,
 *  PENDING_*) is held at the gate. */
export const OPEN_PO_STATUSES = ['APPROVED', 'ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED'];
const OVERRIDE_ROLES = ['owner', 'admin'];

type Row = Record<string, unknown>;

/** Why a gate entry must be held, or null when it may proceed. Shared with GateService's create. */
export async function gateHoldReason(run: (q: string, p: unknown[]) => Promise<Row[]>, purchaseOrderId: string | null | undefined, vendorId: string | null | undefined): Promise<string | null> {
  if (!purchaseOrderId) return 'No purchase order: held at the gate until purchase names one.';
  const po = (await run('select status, vendor_id::text as vendor_id from procurement.purchase_order where purchase_order_id = $1', [purchaseOrderId]))[0];
  if (!po) return 'The purchase order was not found: held at the gate.';
  const st = String(po.status ?? '').toUpperCase();
  if (!OPEN_PO_STATUSES.includes(st)) return `The purchase order is ${st || 'not open'}: held at the gate.`;
  if (vendorId && po.vendor_id && String(po.vendor_id) !== String(vendorId)) return 'The vendor is not the purchase order\'s vendor: held at the gate.';
  return null;
}

@Injectable()
export class ReceivingService {
  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    private readonly policy: PolicyService,
  ) {}

  private async shortfall(ctx: Record<string, unknown>) {
    const d = await evaluateOrHold(this.policy, 'receiving.shortfall', ctx);
    return { rule: shortfallFrom(d.value), d };
  }

  private async poLines(run: (q: string, p: unknown[]) => Promise<Row[]>, poId: string) {
    return run(
      `select poi.purchase_order_item_id::text as "poItemId", poi.material_id::text as "materialId",
              poi.ordered_qty::text as "orderedQty", poi.rate::text as "rate", u.uom_code as "uomCode", poi.uom_id::text as "uomId",
              ra.alias_name as "floorCode",
              coalesce((select sum(l.accepted_base) from inventory.receiving_audit_line l where l.purchase_order_item_id = poi.purchase_order_item_id), 0)::bigint::text as "priorAcceptedBase"
         from procurement.purchase_order_items poi
         left join platform.uom_master u on u.uom_id = poi.uom_id
         left join lateral (select alias_name from masterdata.rm_alias a where a.material_id = poi.material_id and a.status = 'ACTIVE' order by a.created_dt limit 1) ra on true
        where poi.purchase_order_id = $1
        order by poi.created_dt, poi.purchase_order_item_id`,
      [poId],
    );
  }

  /** The PO as receiving sees it before the truck: lines in base units and the rule that applies. */
  async preview(poId: string) {
    const run = (q: string, p: unknown[]) => this.sql.unsafe(q, p as never[]) as unknown as Promise<Row[]>;
    const po = (await run(`select purchase_order_id::text as "purchaseOrderId", po_number as "poNumber", vendor_id::text as "vendorId", status from procurement.purchase_order where purchase_order_id = $1`, [poId]))[0];
    if (!po) throw new NotFoundException('Purchase order not found.');
    const lines = (await this.poLines(run, poId)).map((l) => {
      const b = toBaseUnits(String(l.orderedQty ?? '0'), l.uomCode as string | null);
      return { poItemId: l.poItemId, materialId: l.materialId, floorCode: l.floorCode ?? null, uomCode: l.uomCode ?? null,
        unit: b?.unit ?? null, orderedBase: b?.base ?? null, priorAcceptedBase: Number(l.priorAcceptedBase), auditable: !!b };
    });
    const { rule, d } = await this.shortfall({ vendor: po.vendorId, record_type: 'purchase_order', record_id: poId });
    const deliveries = Number((await run('select count(*)::int as n from inventory.receiving_audit where purchase_order_id = $1', [poId]))[0]!.n);
    const gates = await run(`select gate_entry_id::text as "gateEntryId", gate_entry_number as "gateEntryNumber", status, hold_reason as "holdReason",
        exists (select 1 from inventory.receiving_audit a where a.gate_entry_id = g.gate_entry_id) as "audited"
        from inventory.gate_entry_master g where purchase_order_id = $1 order by created_dt desc`, [poId]);
    return { purchaseOrder: po, lines, rule, policy: { ruleId: d.ruleId, version: d.version, explain: d.explain }, deliveriesSoFar: deliveries, gateEntries: gates };
  }

  async submit(body: Record<string, unknown>, principal: AuthPrincipal) {
    const gateEntryId = String(body.gateEntryId ?? '');
    if (!gateEntryId) throw new BadRequestException('Scan or choose the gate entry for this delivery.');
    const finalDelivery = body.finalDelivery === true;
    const input = Array.isArray(body.lines) ? (body.lines as Row[]) : [];
    if (!input.length) throw new BadRequestException('Audit at least one PO line.');
    const isOverrider = (principal.roles ?? []).some((r) => OVERRIDE_ROLES.includes(r));
    if (input.some((l) => l.override) && !isOverrider) throw new ForbiddenException('A partial accept or reject that overrides the rule is for an admin or the owner.');

    const db = drizzle(this.sql, { schema: inventorySchema });
    return db.transaction(async (tx) => {
      const run = async (q: string, p: unknown[]) => {
        // drizzle's tx.execute takes a SQL object; build one from $n placeholders.
        const parts = q.split(/\$(\d+)/);
        let s = dsql.raw(parts[0]!);
        for (let i = 1; i < parts.length; i += 2) s = dsql`${s}${p[Number(parts[i]) - 1]}${dsql.raw(parts[i + 1]!)}`;
        return Array.from((await tx.execute(s)) as unknown as Row[]);
      };
      const gate = (await run(`select gate_entry_id::text as id, purchase_order_id::text as po, vendor_id::text as vendor, status, hold_reason, location_id::text as loc
                                 from inventory.gate_entry_master where gate_entry_id = $1 for update`, [gateEntryId]))[0];
      if (!gate) throw new NotFoundException('Gate entry not found.');
      if (String(gate.status).toUpperCase() === 'HELD') throw new ConflictException(`This delivery is held at the gate: ${gate.hold_reason ?? 'no reason recorded'}`);
      const hold = await gateHoldReason(run, gate.po as string | null, gate.vendor as string | null);
      if (hold) throw new ConflictException(hold);
      if ((await run('select 1 from inventory.receiving_audit where gate_entry_id = $1', [gateEntryId])).length) throw new ConflictException('This delivery has already been audited.');
      const poId = String(gate.po);
      const po = (await run(`select purchase_order_id::text as id, vendor_id::text as vendor, po_number from procurement.purchase_order where purchase_order_id = $1 for update`, [poId]))[0]!;

      const lines = await this.poLines(run, poId);
      const byId = new Map(lines.map((l) => [String(l.poItemId), l]));
      const rates: Record<string, { ratePaise: number; factor: number }> = {};
      const auditIn: AuditLineInput[] = input.map((l, i) => {
        const pl = byId.get(String(l.poItemId ?? ''));
        if (!pl) throw new BadRequestException(`Line ${i + 1} is not on this purchase order.`);
        const ob = toBaseUnits(String(pl.orderedQty ?? '0'), pl.uomCode as string | null);
        if (!ob) throw new ConflictException(`Line ${i + 1}: the PO unit "${pl.uomCode ?? 'none'}" cannot be weighed or counted here, so it is held for purchase.`);
        rates[String(pl.poItemId)] = { ratePaise: Math.round(Number(pl.rate ?? 0) * 100), factor: ob.factor };
        const o = l.override as Row | undefined;
        return {
          poItemId: String(pl.poItemId), unit: ob.unit, orderedBase: ob.base, priorReceivedBase: Number(pl.priorAcceptedBase),
          receivedBase: l.receivedBase as number, damagedBase: (l.damagedBase ?? 0) as number, checks: l.checks as AuditLineInput['checks'],
          override: o ? { acceptedBase: o.acceptedBase as number, rejectedBase: o.rejectedBase as number, reason: String(o.reason ?? '') } : undefined,
        };
      });
      if (new Set(auditIn.map((l) => l.poItemId)).size !== auditIn.length) throw new BadRequestException('A PO line appears twice in one delivery.');
      const { rule, d } = await this.shortfall({ vendor: po.vendor, record_type: 'purchase_order', record_id: poId });
      const decided = decideReceiving(auditIn, rule, { finalDelivery });
      const deliveryNo = Number((await run('select count(*)::int as n from inventory.receiving_audit where purchase_order_id = $1', [poId]))[0]!.n) + 1;

      // The GRN, in the PO's own unit, through the existing service (savepoint inside this transaction).
      const grn = await new GrnService(tx as never).createGrn({
        gateEntryId, purchaseOrderId: poId, vendorId: po.vendor as string, locationId: (gate.loc as string) ?? null, grnDate: new Date().toISOString().slice(0, 10),
        items: decided.lines.map((r, i) => {
          const pl = byId.get(r.poItemId)!, f = rates[r.poItemId]!.factor, src = input[i]!;
          return {
            purchaseOrderItemId: r.poItemId, materialId: pl.materialId as string, uomId: (pl.uomId as string) ?? null,
            receivedQty: auditIn[i]!.receivedBase / f, acceptedQty: r.acceptedBase / f, rejectedQty: (r.rejectedBase + r.excessHeldBase) / f,
            damagedQty: auditIn[i]!.damagedBase / f, varianceReason: r.explain,
            manufacturingDate: (src.manufacturingDate as string) ?? null, expiryDate: (src.expiryDate as string) ?? null, containers: [],
          };
        }),
      } as never, principal);

      const audit = (await run(
        `insert into inventory.receiving_audit (gate_entry_id, purchase_order_id, grn_id, delivery_no, final_delivery, scope, short_reject_bps, extra_hold_bps, policy_rule_id, policy_version, policy_explain, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning receiving_audit_id::text as id`,
        [gateEntryId, poId, grn.grn.grnId, deliveryNo, finalDelivery, rule.scope, rule.shortRejectBps, rule.extraHoldBps, d.ruleId, d.version, d.explain, principal.userId],
      ))[0]!;
      for (let i = 0; i < decided.lines.length; i++) {
        const r = decided.lines[i]!, a = auditIn[i]!;
        await run(
          `insert into inventory.receiving_audit_line (receiving_audit_id, purchase_order_item_id, material_id, base_unit, ordered_base, received_base, damaged_base, cumulative_received_base, checks, decision, accepted_base, rejected_base, excess_held_base, short_base, overridden, override_reason, overridden_by, explain)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [audit.id, r.poItemId, byId.get(r.poItemId)!.materialId, r.unit, a.orderedBase, a.receivedBase, a.damagedBase, r.cumulativeReceivedBase,
            JSON.stringify(a.checks), r.decision, r.acceptedBase, r.rejectedBase, r.excessHeldBase, r.shortBase, r.overridden, r.overrideReason,
            r.overridden ? principal.userId : null, r.explain],
        );
      }
      const dn = debitNoteLines(decided.lines, rates, { finalDelivery });
      let debitNote: Row | null = null;
      if (dn.length) {
        const amount = dn.reduce((s, l) => s + l.amountPaise, 0);
        const number = 'DN-' + String(po.po_number ?? poId.slice(0, 8)) + '-' + deliveryNo;
        debitNote = (await run(
          `insert into procurement.debit_note (debit_note_number, purchase_order_id, vendor_id, receiving_audit_id, amount_paise, reason, lines, created_by)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
           returning debit_note_id::text as "debitNoteId", debit_note_number as "debitNoteNumber", amount_paise::text as "amountPaise"`,
          [number, poId, po.vendor, audit.id, amount, 'Rejected or short on receipt (delivery ' + deliveryNo + ')', JSON.stringify(dn), principal.userId],
        ))[0]!;
      }
      return {
        receivingAuditId: audit.id, deliveryNo, finalDelivery, grnId: grn.grn.grnId, grnNumber: grn.grn.grnNumber,
        rule, policy: { ruleId: d.ruleId, version: d.version, explain: d.explain }, poShortBps: decided.poShortBps,
        lines: decided.lines, debitNote,
        rmBatches: grn.batches.map((b) => ({ rmBatchId: b.rmBatchId, batchNumber: b.batchNumber })),
      };
    });
  }

  /** Name a PO for a held gate entry (or confirm one), with a reason; the hold re-checks. */
  async resolveHold(gateEntryId: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Say why the hold is lifted.');
    const poId = body.purchaseOrderId ? String(body.purchaseOrderId) : null;
    return this.sql.begin(async (tx) => {
      const run = (q: string, p: unknown[]) => tx.unsafe(q, p as never[]) as unknown as Promise<Row[]>;
      const g = (await run('select purchase_order_id::text as po, vendor_id::text as vendor, status from inventory.gate_entry_master where gate_entry_id = $1 for update', [gateEntryId]))[0];
      if (!g) throw new NotFoundException('Gate entry not found.');
      if (String(g.status).toUpperCase() !== 'HELD') throw new ConflictException('This gate entry is not held.');
      const po = poId ?? (g.po as string | null);
      const still = await gateHoldReason(run, po, g.vendor as string | null);
      if (still) throw new ConflictException(still);
      await run(`update inventory.gate_entry_master set purchase_order_id = $2, status = 'ACTIVE', hold_reason = null, updated_by = $3, updated_dt = now() where gate_entry_id = $1`, [gateEntryId, po, principal.userId]);
      return { gateEntryId, purchaseOrderId: po, status: 'ACTIVE', reason };
    });
  }

  async listAudits(poId?: string) {
    const rows = await this.sql.unsafe(
      `select a.receiving_audit_id::text as "receivingAuditId", a.purchase_order_id::text as "purchaseOrderId", p.po_number as "poNumber",
              a.delivery_no as "deliveryNo", a.final_delivery as "finalDelivery", a.scope, a.policy_explain as "policyExplain", a.created_dt as "createdDt",
              g.grn_number as "grnNumber",
              (select json_agg(json_build_object('poItemId', l.purchase_order_item_id, 'decision', l.decision, 'unit', l.base_unit, 'acceptedBase', l.accepted_base::text,
                 'rejectedBase', l.rejected_base::text, 'excessHeldBase', l.excess_held_base::text, 'shortBase', l.short_base::text, 'overridden', l.overridden, 'explain', l.explain) order by l.created_dt)
                 from inventory.receiving_audit_line l where l.receiving_audit_id = a.receiving_audit_id) as lines,
              (select json_agg(json_build_object('debitNoteNumber', d.debit_note_number, 'amountPaise', d.amount_paise::text))
                 from procurement.debit_note d where d.receiving_audit_id = a.receiving_audit_id) as "debitNotes"
         from inventory.receiving_audit a
         left join procurement.purchase_order p on p.purchase_order_id = a.purchase_order_id
         left join inventory.grn_master g on g.grn_id = a.grn_id
        ${poId ? 'where a.purchase_order_id = $1' : ''}
        order by a.created_dt desc limit 200`,
      (poId ? [poId] : []) as never[],
    );
    return { items: rows, nextCursor: null };
  }
}
