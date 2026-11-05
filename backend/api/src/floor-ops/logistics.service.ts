/**
 * LogisticsService (lane pf-c, plan section 6 station 6 and section 9) — the logistics station.
 *
 *   queue           packed shipments waiting to ship, oldest order first (we hold the order date,
 *                   not a promise date).
 *   checkCarton     scan each carton; all N must be present (and their labels printed) to ship.
 *   documents       generated from the order: tax invoice, packing list, delivery challan, an e-way
 *                   bill when the configured rule says so, and a DG declaration only where the
 *                   product's DG data is sourced. Only fields we hold are filled; blank means blank
 *                   (no invoice or e-way number is invented). They print, and are written to
 *                   sales.dispatch_document at handover (that table needs the dispatch).
 *   assignAwb       scan or type; non-empty, unique, the courier's format where known.
 *   handover        the courier collects: one dispatch through the dispatch flow (ATP, maceration
 *                   and QC checks, and Dispatched to ALEMBIC with awb, courier and lots), the
 *                   documents recorded against it, HANDED OVER with the time and the person.
 *   exception       courier did not come (re-book), carton damaged (back to packing), address
 *                   does not match the invoice (hold and alert).
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { DispatchService } from '@ra/cluster-sales';
import type { Sql } from 'postgres';
import { CourierService } from './courier.service.js';
import { raiseAlert } from './floor-alerts.js';
import { PackingService, BRAND } from './packing.service.js';
import { PrintService } from './print.service.js';

/** E-way bill rule (plan 9.2: "the threshold and rules are settings"). Unset: not determined. */
export const EWAY_THRESHOLD = Symbol('EWAY_THRESHOLD');

export interface GeneratedDoc {
  type: 'INVOICE' | 'PACKING_LIST' | 'DELIVERY_CHALLAN' | 'EWAY_BILL' | 'DG_DECLARATION';
  documentNumber: string | null;
  fields: Record<string, string | number | null>;
  /** Fields this document needs that we do not hold: printed blank, never invented. */
  blanks: string[];
  note?: string;
}

@Injectable()
export class LogisticsService {
  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    private readonly packing: PackingService,
    private readonly couriers: CourierService,
    private readonly print: PrintService,
    private readonly dispatch: DispatchService,
    /** Order value (rupees) at or above which an e-way bill is required; null = rule not set. */
    @Optional() @Inject(EWAY_THRESHOLD) private readonly ewayThreshold: number | null = null,
  ) {}

  async queue() {
    const rows = await this.sql`
      select s.*, so.so_number, so.order_date,
             (select count(*) from sales.shipment_carton c where c.shipment_id = s.shipment_id and c.checked_at is not null)::int as checked
        from sales.shipment s left join sales.sales_order so on so.sales_order_id = s.sales_order_id
       where s.status in ('PACKED', 'DOCS_READY', 'AWB_ASSIGNED', 'HOLD')
       order by so.order_date nulls last, s.packed_at, s.created_at limit 200`;
    return rows.map((r) => ({ ...this.packing.shapeShipment(r), cartonsChecked: Number(r.checked) }));
  }

  private async locked(tx: Sql, id: string, allowed: string[]) {
    const [s] = await tx`
      select s.*, so.so_number, so.customer_id, so.total_amount, c.customer_name from sales.shipment s
        left join sales.sales_order so on so.sales_order_id = s.sales_order_id
        left join sales.customer_master c on c.customer_id = so.customer_id
       where s.shipment_id = ${id}::uuid for update of s`;
    if (!s) throw new NotFoundException('That shipment was not found.');
    if (!allowed.includes(String(s.status))) throw new ConflictException(`That shipment is ${s.status}.`);
    return s;
  }

  async checkCarton(shipmentId: string, cartonCode: unknown, principal: AuthPrincipal) {
    const code = typeof cartonCode === 'string' ? cartonCode.trim() : '';
    if (!code) throw new BadRequestException('Scan the carton label.');
    return this.sql.begin(async (tx) => {
      await this.locked(tx as unknown as Sql, shipmentId, ['PACKED', 'DOCS_READY', 'AWB_ASSIGNED']);
      const [c] = await tx`select * from sales.shipment_carton where upper(carton_code) = upper(${code})`;
      if (!c) throw new NotFoundException(`Carton ${code} was not found.`);
      if (String(c.shipment_id) !== shipmentId) throw new ConflictException(`Carton ${c.carton_code} belongs to another shipment.`);
      await tx`update sales.shipment_carton set checked_at = coalesce(checked_at, now()), checked_by = coalesce(checked_by, ${principal.userId}::uuid) where carton_id = ${c.carton_id}::uuid`;
      const [p] = await tx`select count(*)::int as n, count(checked_at)::int as checked from sales.shipment_carton where shipment_id = ${shipmentId}::uuid`;
      return { cartonCode: String(c.carton_code), checked: Number(p!.checked), total: Number(p!.n), complete: Number(p!.checked) === Number(p!.n) };
    });
  }

  private async assertCartonSet(tx: Sql, shipmentId: string) {
    const cartons = await tx`select carton_code, checked_at from sales.shipment_carton where shipment_id = ${shipmentId}::uuid order by seq`;
    const missing = cartons.filter((c) => !c.checked_at).map((c) => String(c.carton_code));
    if (!cartons.length || missing.length) throw new ConflictException(`${cartons.length - missing.length} of ${cartons.length} cartons scanned. Missing: ${missing.join(', ')}. It cannot ship incomplete.`);
    const unprinted = (await tx`
      select c.carton_code from sales.shipment_carton c where c.shipment_id = ${shipmentId}::uuid
         and not exists (select 1 from platform.print_job j where j.label_kind = 'carton' and j.subject_ref = c.carton_code and j.status = 'printed')`).map((c) => String(c.carton_code));
    if (unprinted.length) throw new ConflictException(`The carton label is not printed for ${unprinted.join(', ')}.`);
    return cartons;
  }

  async documents(shipmentId: string, station: string, principal: AuthPrincipal) {
    const { s, docs } = await this.sql.begin(async (tx) => {
      const s = await this.locked(tx as unknown as Sql, shipmentId, ['PACKED', 'DOCS_READY']);
      const cartons = await this.assertCartonSet(tx as unknown as Sql, shipmentId);
      const lots = await tx`
        select u.batch_number, count(*)::int as units, d.un_number, d.dg_class, d.packing_group, d.proper_shipping_name
          from sales.shipment_unit u
          left join packaging.finished_good_batch_master f on f.finished_good_batch_id = u.finished_good_batch_id
          left join packaging.product_sku sk on sk.product_sku_id = f.product_sku_id
          left join packaging.product_dg_info d on d.product_id = sk.product_id
         where u.shipment_id = ${shipmentId}::uuid
         group by u.batch_number, d.un_number, d.dg_class, d.packing_group, d.proper_shipping_name`;
      const amount = s.total_amount === null || s.total_amount === undefined ? null : String(s.total_amount);
      const base = { order: s.so_number ?? null, shipment: String(s.shipment_no), customer: s.customer_name ?? null };
      const docs: GeneratedDoc[] = [
        { type: 'INVOICE', documentNumber: null, fields: { ...base, amount }, blanks: ['invoiceNumber', 'gstin', 'hsn', ...(amount ? [] : ['amount']), ...(s.customer_name ? [] : ['customer'])], note: 'The tax invoice number comes from the invoicing system; it is not generated here.' },
        { type: 'PACKING_LIST', documentNumber: String(s.shipment_no), fields: { ...base, cartons: cartons.length, lots: lots.map((l) => `${l.batch_number} × ${l.units}`).join(', ') }, blanks: [] },
        { type: 'DELIVERY_CHALLAN', documentNumber: null, fields: { ...base, cartons: cartons.length }, blanks: ['challanNumber', 'vehicleNumber'] },
      ];
      if (this.ewayThreshold === null) {
        docs.push({ type: 'EWAY_BILL', documentNumber: null, fields: { ...base, amount }, blanks: ['ewayBillNumber'], note: 'Not determined: the e-way bill rule is not set. Check before handover.' });
      } else if (amount !== null && Number(amount) >= this.ewayThreshold) {
        docs.push({ type: 'EWAY_BILL', documentNumber: null, fields: { ...base, amount }, blanks: ['ewayBillNumber'], note: 'Required by the configured rule. Generate it on the portal and record the number.' });
      }
      const dg = lots.filter((l) => l.un_number || l.dg_class);
      if (dg.length) {
        docs.push({
          type: 'DG_DECLARATION', documentNumber: null, blanks: ['shipperSignature'],
          fields: { ...base, goods: dg.map((l) => [l.un_number ? `UN${String(l.un_number).replace(/^UN/i, '')}` : null, l.proper_shipping_name, l.dg_class ? `Class ${l.dg_class}` : null, l.packing_group ? `PG ${l.packing_group}` : null, `lot ${l.batch_number}`].filter(Boolean).join(' · ')).join('; ') },
          note: 'From the product\'s sourced DG record.',
        });
      }
      await tx`update sales.shipment set docs = ${JSON.stringify(docs)}::text::jsonb, status = 'DOCS_READY', updated_at = now() where shipment_id = ${shipmentId}::uuid`;
      return { s, docs };
    });
    const printed = [];
    for (const d of docs) {
      printed.push(await this.print.enqueue({
        station, labelKind: 'dispatch_doc', subjectRef: `${s.shipment_no}:${d.type}`, size: 'a4',
        content: {
          brand: BRAND, title: d.type.replace(/_/g, ' '),
          lines: [
            ['Number', d.documentNumber ?? '(blank: not held here)'],
            ...Object.entries(d.fields).map(([k, v]) => [k, v === null ? '(blank: not held)' : String(v)] as [string, string]),
            ...(d.note ? [['Note', d.note] as [string, string]] : []),
          ].slice(0, 20) as Array<[string, string]>,
          code: String(s.shipment_no),
        },
      }, principal));
    }
    return { docs, printJobs: printed.map((p) => ({ printJobId: p.printJobId, status: p.status, labelKind: p.labelKind, subjectRef: p.subjectRef })) };
  }

  async assignAwb(shipmentId: string, body: Record<string, unknown>, station: string, principal: AuthPrincipal) {
    const courier = typeof body.courierCode === 'string' ? body.courierCode.trim() : '';
    if (!courier) throw new BadRequestException('Pick the courier.');
    const known = await this.sql`
      select 1 from sales.courier_connector where provider = ${courier}
      union all select 1 from sales.transporter_master where transporter_code = ${courier}`;
    if (!known.length) throw new BadRequestException(`${courier} is not in the courier list.`);
    if (body.source !== 'scan' && body.source !== 'typed') throw new BadRequestException('source is scan or typed.');
    const awb = await this.couriers.validateAwb(courier, body.awb);
    const s = await this.sql.begin(async (tx) => {
      const s = await this.locked(tx as unknown as Sql, shipmentId, ['DOCS_READY', 'AWB_ASSIGNED']);
      const [dup] = await tx`select shipment_no from sales.shipment where upper(awb) = ${awb} and shipment_id <> ${shipmentId}::uuid`;
      if (dup) throw new ConflictException(`AWB ${awb} is already used on shipment ${dup.shipment_no}. A courier AWB is never reused.`);
      try {
        await tx`update sales.shipment set courier_code = ${courier}, awb = ${awb}, awb_source = ${body.source as string}, awb_at = now(), status = 'AWB_ASSIGNED', updated_at = now() where shipment_id = ${shipmentId}::uuid`;
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException(`AWB ${awb} is already used on another shipment.`);
        throw e;
      }
      return s;
    });
    const label = await this.print.enqueue({
      station, labelKind: 'courier', subjectRef: awb, size: '100x150',
      content: { brand: BRAND, title: courier.toUpperCase(), lines: [['AWB', awb], ['Order', s.so_number ?? null], ['Shipment', String(s.shipment_no)], ['Cartons', s.carton_count]], code: awb },
    }, principal);
    return { shipment: await this.packing.shipment(shipmentId), courierLabel: { printJobId: label.printJobId, status: label.status } };
  }

  async handover(shipmentId: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    const handedTo = typeof body.handedTo === 'string' ? body.handedTo.trim().slice(0, 120) : '';
    if (!handedTo) throw new BadRequestException('The courier person\'s name is required at handover.');
    // Claim it first so a retried or double-pressed handover cannot dispatch twice.
    const s = await this.sql.begin(async (tx) => {
      const s = await this.locked(tx as unknown as Sql, shipmentId, ['AWB_ASSIGNED', 'HANDING_OVER']);
      await this.assertCartonSet(tx as unknown as Sql, shipmentId);
      await tx`update sales.shipment set status = 'HANDING_OVER', updated_at = now() where shipment_id = ${shipmentId}::uuid`;
      return s;
    });
    let dispatchId = (s.dispatch_id as string | null) ?? null;
    if (!dispatchId) {
      const lines = await this.sql`
        select finished_good_batch_id, batch_number, count(*)::int as units from sales.shipment_unit
         where shipment_id = ${shipmentId}::uuid group by finished_good_batch_id, batch_number order by batch_number`;
      const [transporter] = await this.sql`select transporter_id from sales.transporter_master where transporter_code = ${s.courier_code}`;
      try {
        const d = await this.dispatch.createDispatch({
          salesOrderId: String(s.sales_order_id),
          customerId: (s.customer_id as string | null) ?? undefined,
          dispatchDate: new Date().toISOString().slice(0, 10),
          transporterId: (transporter?.transporter_id as string | undefined) ?? undefined,
          awb: String(s.awb), courier: String(s.courier_code),
          lots: lines.map((l) => String(l.batch_number ?? l.finished_good_batch_id)),
          items: lines.map((l) => ({ finishedGoodBatchId: String(l.finished_good_batch_id), dispatchedQty: Number(l.units) })),
        }, principal);
        dispatchId = String(d.dispatch.dispatchId);
      } catch (e) {
        await this.sql`update sales.shipment set status = 'AWB_ASSIGNED', updated_at = now() where shipment_id = ${shipmentId}::uuid and status = 'HANDING_OVER'`;
        throw e;
      }
      await this.sql`update sales.shipment set dispatch_id = ${dispatchId}::uuid where shipment_id = ${shipmentId}::uuid`;
    }
    await this.sql.begin(async (tx) => {
      const docs = ((typeof s.docs === 'string' ? JSON.parse(s.docs) : s.docs) ?? []) as GeneratedDoc[];
      const [already] = await tx`select 1 from sales.dispatch_document where dispatch_id = ${dispatchId}::uuid limit 1`;
      if (!already) {
        for (const d of docs) {
          if (d.type === 'DG_DECLARATION') continue; // not a dispatch_document type; it is printed and kept on the shipment
          await tx`
            insert into sales.dispatch_document (dispatch_document_id, dispatch_id, sales_order_id, document_type, document_number, document_date,
                                                 amount, reference, notes, status, created_by, updated_by)
            values (${uuidv7()}::uuid, ${dispatchId}::uuid, ${s.sales_order_id}::uuid, ${d.type}, ${d.documentNumber}, current_date,
                    ${d.type === 'INVOICE' && d.fields.amount !== null ? String(d.fields.amount) : null}::numeric, ${String(s.shipment_no)},
                    ${[d.note, d.blanks.length ? `Not held: ${d.blanks.join(', ')}` : null].filter(Boolean).join(' ') || null}, 'ISSUED', ${principal.userId}, ${principal.userId})`;
        }
      }
      await tx`update sales.shipment set status = 'HANDED_OVER', handed_over_at = now(), handed_over_to = ${handedTo}, handed_over_by = ${principal.userId}::uuid, updated_at = now() where shipment_id = ${shipmentId}::uuid`;
    });
    return this.packing.shipment(shipmentId);
  }

  async exception(shipmentId: string, body: Record<string, unknown>, station: string, _principal: AuthPrincipal) {
    const kind = String(body.kind ?? '');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    if (kind === 'COURIER_NO_SHOW') {
      await this.sql.begin(async (tx) => {
        await this.locked(tx as unknown as Sql, shipmentId, ['AWB_ASSIGNED']);
        await tx`update sales.shipment set courier_code = null, awb = null, awb_source = null, awb_at = null, status = 'DOCS_READY', updated_at = now() where shipment_id = ${shipmentId}::uuid`;
      });
    } else if (kind === 'CARTON_DAMAGED') {
      const code = typeof body.cartonCode === 'string' ? body.cartonCode.trim() : '';
      if (!code) throw new BadRequestException('Which carton is damaged (cartonCode)?');
      await this.sql.begin(async (tx) => {
        await this.locked(tx as unknown as Sql, shipmentId, ['PACKED', 'DOCS_READY', 'AWB_ASSIGNED']);
        const [c] = await tx`update sales.shipment_carton set status = 'OPEN', gross_mg = null, weight_source = null, closed_at = null where shipment_id = ${shipmentId}::uuid and upper(carton_code) = upper(${code}) returning carton_id`;
        if (!c) throw new NotFoundException(`Carton ${code} is not in this shipment.`);
        await tx`update sales.shipment_carton set checked_at = null, checked_by = null where shipment_id = ${shipmentId}::uuid`;
        await tx`update sales.shipment set status = 'PACKING', docs = null, courier_code = null, awb = null, awb_source = null, awb_at = null, hold_reason = ${'Carton damaged at handover: ' + code + (note ? ` (${note})` : '')}, updated_at = now() where shipment_id = ${shipmentId}::uuid`;
      });
    } else if (kind === 'ADDRESS_MISMATCH') {
      if (!note) throw new BadRequestException('Say what does not match.');
      const s = await this.sql.begin(async (tx) => {
        const s = await this.locked(tx as unknown as Sql, shipmentId, ['PACKED', 'DOCS_READY', 'AWB_ASSIGNED']);
        await tx`update sales.shipment set status = 'HOLD', hold_reason = ${'Address does not match the invoice: ' + note}, updated_at = now() where shipment_id = ${shipmentId}::uuid`;
        return s;
      });
      await raiseAlert(this.sql, {
        kind: 'shipment_hold', station, subjectType: 'shipment', subjectId: shipmentId,
        title: `Held: ${s.shipment_no} (${s.so_number ?? 'order'}) address does not match the invoice`,
        body: `${note}. Sales / CRM to confirm the address.`, dedupeKey: `shipment_hold:${shipmentId}`,
      }, new Date());
    } else if (kind === 'RELEASE_HOLD') {
      await this.sql.begin(async (tx) => {
        const s = await this.locked(tx as unknown as Sql, shipmentId, ['HOLD']);
        await tx`update sales.shipment set status = ${s.awb ? 'AWB_ASSIGNED' : s.docs ? 'DOCS_READY' : 'PACKED'}, hold_reason = null, updated_at = now() where shipment_id = ${shipmentId}::uuid`;
        await tx`update platform.floor_alert set cleared_at = now() where dedupe_key = ${'shipment_hold:' + shipmentId} and cleared_at is null`;
      });
    } else {
      throw new BadRequestException('kind is COURIER_NO_SHOW, CARTON_DAMAGED, ADDRESS_MISMATCH or RELEASE_HOLD.');
    }
    return this.packing.shipment(shipmentId);
  }
}
