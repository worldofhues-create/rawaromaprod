/**
 * PackingService (lane pf-c, plan section 6, station 5) — the packing station.
 *
 *   start        an order + the QC-approved lots it ships from. A lot without a packaging QC PASS,
 *                or one still macerating, is refused.
 *   addUnit      one filled, sealed unit: net weight within tolerance on the EXACT mg (from the
 *                scale or typed, recorded which), then the branded customer label is printed:
 *                RAW AROMA CHEM, product, size, lot, QC APPROVED, date, and the hazard line only
 *                from the product's sourced DG record, else "Classification pending".
 *   openCarton / scanUnit / closeCarton
 *                units scanned into carton n; a unit of another order or another lot is refused;
 *                the carton is weighed: never lighter than its contents, never beyond the
 *                packaging allowance.
 *   finish       every unit in a closed carton with its customer label printed -> PACKED, the
 *                "carton i of N" labels and the packing list print; the shipment appears on the
 *                logistics station's queue.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { assertNotMacerating, PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import type { Sql } from 'postgres';
import { drizzleExec, iso, UUID_RE } from './floor-util.js';
import { PrintService } from './print.service.js';
import { ScaleService } from './scale.service.js';
import { scanCode } from '../floor/scan-code.js';

export const BRAND = 'RAW AROMA CHEM';
/** Carton weight above its contents allowed by default (box, filler, ice packs): 1 kg. */
export const DEFAULT_PACKAGING_ALLOWANCE_MG = 1_000_000;

/** Integer mg -> "125.5 g" / "1.25 kg" for a printed label (display only; checks use mg). */
export function weightText(mg: number): string {
  const trim = (n: number) => String(Math.round(n * 100) / 100);
  return mg >= 1_000_000 ? `${trim(mg / 1_000_000)} kg` : `${trim(mg / 1000)} g`;
}

interface LotInfo { id: string; batchNumber: string | null; productName: string | null; productCode: string | null; skuCode: string | null; packSize: string | null; hazard: string }

@Injectable()
export class PackingService {
  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    private readonly print: PrintService,
    private readonly scales: ScaleService,
  ) {}

  private async lot(id: string): Promise<LotInfo> {
    const [r] = await this.sql`
      select f.finished_good_batch_id, f.batch_number, s.sku_code, s.pack_size, pm.product_code, pm.product_name,
             d.un_number, d.dg_class, d.packing_group, d.proper_shipping_name
        from packaging.finished_good_batch_master f
        left join packaging.product_sku s on s.product_sku_id = f.product_sku_id
        left join packaging.product_master pm on pm.product_id = s.product_id
        left join packaging.product_dg_info d on d.product_id = pm.product_id
       where f.finished_good_batch_id = ${id}::uuid`;
    if (!r) throw new NotFoundException(`Lot ${id} was not found.`);
    const dg = [r.un_number ? `UN${String(r.un_number).replace(/^UN/i, '')}` : '', r.dg_class ? `Class ${r.dg_class}` : '', r.packing_group ? `PG ${r.packing_group}` : ''].filter(Boolean).join(' · ');
    return {
      id, batchNumber: r.batch_number ?? null, productName: r.product_name ?? null, productCode: r.product_code ?? null,
      skuCode: r.sku_code ?? null, packSize: r.pack_size ?? null,
      // Never assert "not hazardous": absent sourced data is "Classification pending".
      hazard: dg || 'Classification pending',
    };
  }

  async start(body: { salesOrderId?: unknown; finishedGoodBatchIds?: unknown }, principal: AuthPrincipal) {
    const so = typeof body.salesOrderId === 'string' && UUID_RE.test(body.salesOrderId) ? body.salesOrderId : null;
    if (!so) throw new BadRequestException('salesOrderId is required.');
    const lots = Array.isArray(body.finishedGoodBatchIds) ? Array.from(new Set(body.finishedGoodBatchIds.map(String))) : [];
    if (!lots.length || lots.some((l) => !UUID_RE.test(l))) throw new BadRequestException('finishedGoodBatchIds: the lots this order ships from.');
    const [order] = await this.sql`select so_number from sales.sales_order where sales_order_id = ${so}::uuid`;
    if (!order) throw new NotFoundException('That sales order was not found.');
    for (const l of lots) {
      const [qc] = await this.sql`select overall_result from packaging.packaging_qc where finished_good_batch_id = ${l}::uuid order by created_dt desc limit 1`;
      if (String(qc?.overall_result ?? '').toUpperCase() !== 'PASS') {
        const info = await this.lot(l);
        throw new ConflictException(`Lot ${info.batchNumber ?? l} is not QC approved (packaging QC has not passed). Only an approved batch is packed.`);
      }
      await assertNotMacerating(drizzleExec(this.sql), { finishedGoodBatchId: l }, 'be packed');
    }
    const [{ n }] = (await this.sql`select count(*)::int as n from sales.shipment where sales_order_id = ${so}::uuid`) as unknown as [{ n: number }];
    const shipmentNo = `SHP-${String(order.so_number ?? so.slice(0, 8)).replace(/[^A-Za-z0-9-]/g, '')}-${n + 1}`;
    const [r] = await this.sql`
      insert into sales.shipment (shipment_id, shipment_no, sales_order_id, status, lots, created_by)
      values (${uuidv7()}::uuid, ${shipmentNo}, ${so}::uuid, 'PACKING', ${this.sql.array(lots)}::uuid[], ${principal.userId}::uuid)
      returning *`;
    return this.shapeShipment(r!);
  }

  async shipment(id: string) {
    const [r] = await this.sql`select s.*, so.so_number from sales.shipment s left join sales.sales_order so on so.sales_order_id = s.sales_order_id where s.shipment_id = ${id}::uuid`;
    if (!r) throw new NotFoundException('That shipment was not found.');
    const cartons = await this.sql`select * from sales.shipment_carton where shipment_id = ${id}::uuid order by seq`;
    const units = await this.sql`select * from sales.shipment_unit where shipment_id = ${id}::uuid order by created_at`;
    const shaped = this.shapeShipment(r);
    return { ...shaped, lotNames: await this.lotNames(((r.lots as string[]) ?? []).map(String)), cartons: cartons.map((c) => this.shapeCarton(c)), units: units.map((u) => this.shapeUnit(u)) };
  }

  /** WALK2-RP-9: what a packer chooses from, by name: the station asked for a typed sales-order uuid
   *  and comma-separated lot uuids. Open orders, and lots whose latest packaging QC passed (start()
   *  still refuses one that is macerating or no longer approved). */
  async candidates() {
    const orders = await this.sql`
      select so.sales_order_id, so.so_number, so.order_date, c.customer_name
        from sales.sales_order so left join sales.customer_master c on c.customer_id = so.customer_id
       where upper(coalesce(so.status, '')) = 'CONFIRMED' order by so.order_date nulls last, so.so_number`;
    const lots = await this.sql`
      select f.finished_good_batch_id, f.batch_number, s.pack_size, pm.product_name
        from packaging.finished_good_batch_master f
        left join packaging.product_sku s on s.product_sku_id = f.product_sku_id
        left join packaging.product_master pm on pm.product_id = s.product_id
       where (select upper(coalesce(q.overall_result, '')) from packaging.packaging_qc q
               where q.finished_good_batch_id = f.finished_good_batch_id order by q.created_dt desc limit 1) = 'PASS'
       order by f.created_dt`;
    return {
      orders: orders.map((o) => ({ salesOrderId: String(o.sales_order_id), soNumber: o.so_number ?? null, customerName: o.customer_name ?? null, orderDate: o.order_date ? iso(o.order_date) : null })),
      lots: lots.map((l) => ({ finishedGoodBatchId: String(l.finished_good_batch_id), batchNumber: l.batch_number ?? null, productName: l.product_name ?? null, packSize: l.pack_size ?? null })),
    };
  }

  /** The shipment's lots by batch number, for the unit picker (it showed the first 8 characters of a uuid). */
  private async lotNames(ids: string[]) {
    if (!ids.length) return [];
    const rows = await this.sql`select finished_good_batch_id, batch_number from packaging.finished_good_batch_master where finished_good_batch_id = any(${this.sql.array(ids)}::uuid[])`;
    const by = new Map(rows.map((r) => [String(r.finished_good_batch_id), r.batch_number ?? null]));
    return ids.map((id) => ({ finishedGoodBatchId: id, batchNumber: by.get(id) ?? null }));
  }

  async queue() {
    const rows = await this.sql`
      select s.*, so.so_number from sales.shipment s left join sales.sales_order so on so.sales_order_id = s.sales_order_id
       where s.status = 'PACKING' order by s.created_at limit 200`;
    return rows.map((r) => this.shapeShipment(r));
  }

  private async packingShipment(tx: Sql, id: string) {
    const [s] = await tx`select s.*, so.so_number from sales.shipment s left join sales.sales_order so on so.sales_order_id = s.sales_order_id where s.shipment_id = ${id}::uuid for update of s`;
    if (!s) throw new NotFoundException('That shipment was not found.');
    if (s.status !== 'PACKING') throw new ConflictException(`That shipment is ${s.status}; units are added only while PACKING.`);
    return s;
  }

  async addUnit(shipmentId: string, body: Record<string, unknown>, station: string, principal: AuthPrincipal) {
    if (body.sealed !== true) throw new BadRequestException('Tick seal / cap / tamper seal before the unit is recorded.');
    const target = body.targetMg, tol = body.toleranceMg;
    if (!Number.isSafeInteger(target) || (target as number) <= 0) throw new BadRequestException('targetMg must be whole milligrams above 0.');
    if (!Number.isSafeInteger(tol) || (tol as number) < 0) throw new BadRequestException('toleranceMg must be whole milligrams, 0 or more.');
    const w = await this.scales.resolveWeight({ mg: body.mg, weightSource: body.weightSource, scaleReadingId: body.scaleReadingId, weightCheckId: body.weightCheckId }, station, principal, `shipment ${shipmentId} unit`);
    const fgId = String(body.finishedGoodBatchId ?? '');
    const unit = await this.sql.begin(async (tx) => {
      const s = await this.packingShipment(tx as unknown as Sql, shipmentId);
      if (!(s.lots as string[]).includes(fgId)) throw new ConflictException('That lot is not one of this shipment\'s lots.');
      if (Math.abs(w.mg - (target as number)) > (tol as number)) {
        throw new ConflictException(`Net weight ${weightText(w.mg)} is outside the tolerance (${weightText(target as number)} ± ${weightText(tol as number)}). Re-fill or call a supervisor.`);
      }
      const info = await this.lot(fgId);
      const [{ n }] = (await tx`select count(*)::int as n from sales.shipment_unit where shipment_id = ${shipmentId}::uuid`) as unknown as [{ n: number }];
      const [u] = await tx`
        insert into sales.shipment_unit (unit_id, unit_code, shipment_id, sales_order_id, sales_order_item_id, finished_good_batch_id, batch_number,
                                         target_mg, tolerance_mg, net_mg, weight_source, scale_reading_id, sealed, packed_by)
        values (${uuidv7()}::uuid, ${`U-${s.shipment_no}-${n + 1}`}, ${shipmentId}::uuid, ${s.sales_order_id}::uuid,
                ${typeof body.salesOrderItemId === 'string' && UUID_RE.test(body.salesOrderItemId) ? body.salesOrderItemId : null}::uuid,
                ${fgId}::uuid, ${info.batchNumber}, ${target as number}, ${tol as number}, ${w.mg}, ${w.weightSource}, ${w.scaleReadingId}::uuid, true, ${principal.userId}::uuid)
        returning *`;
      return { row: u!, info };
    });
    const unitCode = String(unit.row.unit_code);
    const label = await this.print.enqueue({
      station, labelKind: 'customer', subjectRef: unitCode,
      content: {
        brand: BRAND,
        title: unit.info.productName ?? unit.info.productCode ?? unit.info.skuCode ?? 'Product',
        lines: [
          ['Size', unit.info.packSize], ['Lot', unit.info.batchNumber], ['QC', 'APPROVED'],
          ['Packed', new Date().toISOString().slice(0, 10)], ['Hazard', unit.info.hazard],
        ],
        code: unitCode,
      },
    }, principal);
    return { unit: this.shapeUnit(unit.row), label };
  }

  async openCarton(shipmentId: string, _principal: AuthPrincipal) {
    return this.sql.begin(async (tx) => {
      const s = await this.packingShipment(tx as unknown as Sql, shipmentId);
      const [open] = await tx`select carton_code from sales.shipment_carton where shipment_id = ${shipmentId}::uuid and status = 'OPEN'`;
      if (open) throw new ConflictException(`Carton ${open.carton_code} is still open. Close it first.`);
      const [{ n }] = (await tx`select count(*)::int as n from sales.shipment_carton where shipment_id = ${shipmentId}::uuid`) as unknown as [{ n: number }];
      const [c] = await tx`
        insert into sales.shipment_carton (carton_id, shipment_id, seq, carton_code, status)
        values (${uuidv7()}::uuid, ${shipmentId}::uuid, ${n + 1}, ${`CTN-${s.shipment_no}-${n + 1}`}, 'OPEN') returning *`;
      return this.shapeCarton(c!);
    });
  }

  async scanUnit(cartonId: string, unitCode: unknown, _principal: AuthPrincipal) {
    const code = typeof unitCode === 'string' ? scanCode(unitCode) : ''; // SCAN-3
    if (!code) throw new BadRequestException('Scan the unit label.');
    return this.sql.begin(async (tx) => {
      const [c] = await tx`
        select c.*, s.sales_order_id, s.lots, s.status as shipment_status from sales.shipment_carton c
          join sales.shipment s on s.shipment_id = c.shipment_id where c.carton_id = ${cartonId}::uuid for update of c`;
      if (!c) throw new NotFoundException('That carton was not found.');
      if (c.status !== 'OPEN') throw new ConflictException(`Carton ${c.carton_code} is closed.`);
      const [u] = await tx`select * from sales.shipment_unit where upper(unit_code) = upper(${code}) for update`;
      if (!u) throw new NotFoundException(`Unit ${code} was not found. Scan the unit's own label.`);
      if (String(u.sales_order_id) !== String(c.sales_order_id)) throw new ConflictException(`Unit ${u.unit_code} belongs to another order. It cannot go in this carton.`);
      if (String(u.shipment_id) !== String(c.shipment_id) || !(c.lots as string[]).includes(String(u.finished_good_batch_id))) {
        throw new ConflictException(`Unit ${u.unit_code} is from lot ${u.batch_number ?? '?'}, not a lot of this shipment.`);
      }
      if (u.carton_id) throw new ConflictException(`Unit ${u.unit_code} is already in a carton.`);
      const [done] = await tx`update sales.shipment_unit set carton_id = ${cartonId}::uuid, carton_scanned_at = now() where unit_id = ${u.unit_id}::uuid returning *`;
      return this.shapeUnit(done!);
    });
  }

  async closeCarton(cartonId: string, body: Record<string, unknown>, station: string, principal: AuthPrincipal) {
    const w = await this.scales.resolveWeight({ mg: body.mg, weightSource: body.weightSource, scaleReadingId: body.scaleReadingId, weightCheckId: body.weightCheckId }, station, principal, `carton ${cartonId}`);
    const allowance = body.allowanceMg === undefined ? DEFAULT_PACKAGING_ALLOWANCE_MG : Number(body.allowanceMg);
    if (!Number.isSafeInteger(allowance) || allowance < 0) throw new BadRequestException('allowanceMg must be whole milligrams.');
    return this.sql.begin(async (tx) => {
      const [c] = await tx`select * from sales.shipment_carton where carton_id = ${cartonId}::uuid for update`;
      if (!c) throw new NotFoundException('That carton was not found.');
      if (c.status !== 'OPEN') throw new ConflictException('That carton is already closed.');
      const [{ n, net }] = (await tx`select count(*)::int as n, coalesce(sum(net_mg), 0)::bigint as net from sales.shipment_unit where carton_id = ${cartonId}::uuid`) as unknown as [{ n: number; net: string }];
      if (!n) throw new ConflictException('This carton has no units. Scan units into it first.');
      const contents = Number(net);
      if (w.mg < contents) throw new ConflictException(`The carton weighs ${weightText(w.mg)}, lighter than its contents (${weightText(contents)}). Re-weigh or re-scan.`);
      if (w.mg - contents > allowance) throw new ConflictException(`The carton weighs ${weightText(w.mg - contents)} more than its contents, beyond the packaging allowance of ${weightText(allowance)}. Check for a missing scan.`);
      const [r] = await tx`
        update sales.shipment_carton set status = 'CLOSED', gross_mg = ${w.mg}, weight_source = ${w.weightSource}, closed_at = now(), closed_by = ${principal.userId}::uuid
         where carton_id = ${cartonId}::uuid returning *`;
      return this.shapeCarton(r!);
    });
  }

  async finish(shipmentId: string, station: string, principal: AuthPrincipal) {
    const { s, cartons, lotLines } = await this.sql.begin(async (tx) => {
      const s = await this.packingShipment(tx as unknown as Sql, shipmentId);
      const cartons = await tx`select * from sales.shipment_carton where shipment_id = ${shipmentId}::uuid order by seq`;
      if (!cartons.length) throw new ConflictException('No cartons yet.');
      if (cartons.some((c) => c.status !== 'CLOSED')) throw new ConflictException('A carton is still open. Weigh and close it.');
      const units = await tx`select unit_code, carton_id, batch_number, net_mg from sales.shipment_unit where shipment_id = ${shipmentId}::uuid`;
      if (!units.length) throw new ConflictException('No units packed.');
      const loose = units.filter((u) => !u.carton_id);
      if (loose.length) throw new ConflictException(`${loose.length} unit(s) are not in a carton: ${loose.map((u) => u.unit_code).join(', ')}.`);
      const unprinted = (await tx`
        select u.unit_code from sales.shipment_unit u
         where u.shipment_id = ${shipmentId}::uuid
           and not exists (select 1 from platform.print_job j where j.label_kind = 'customer' and j.subject_ref = u.unit_code and j.status = 'printed')`).map((u) => String(u.unit_code));
      if (unprinted.length) throw new ConflictException(`The customer label is not printed for ${unprinted.join(', ')}. Print it (or print in the browser) first.`);
      await tx`update sales.shipment set status = 'PACKED', carton_count = ${cartons.length}, packed_at = now(), packed_by = ${principal.userId}::uuid, updated_at = now() where shipment_id = ${shipmentId}::uuid`;
      const byLot = new Map<string, number>();
      for (const u of units) byLot.set(String(u.batch_number ?? '?'), (byLot.get(String(u.batch_number ?? '?')) ?? 0) + 1);
      return { s, cartons, lotLines: Array.from(byLot.entries()) };
    });
    const N = cartons.length;
    const lotsText = lotLines.map(([l]) => l).join(', ');
    const cartonLabels = [];
    for (const c of cartons) {
      cartonLabels.push(await this.print.enqueue({
        station, labelKind: 'carton', subjectRef: String(c.carton_code), size: '100x150',
        content: {
          brand: BRAND, title: 'PACKED',
          lines: [['Order', s.so_number ?? String(s.sales_order_id)], ['Shipment', s.shipment_no], ['Carton', `${c.seq} of ${N}`], ['Gross', weightText(Number(c.gross_mg))], ['Lots', lotsText]],
          code: String(c.carton_code),
        },
      }, principal));
    }
    const packingList = await this.print.enqueue({
      station, labelKind: 'packing_list', subjectRef: String(s.shipment_no), size: 'a4',
      content: {
        brand: BRAND, title: 'PACKING LIST',
        lines: [
          ['Order', s.so_number ?? String(s.sales_order_id)], ['Shipment', s.shipment_no], ['Cartons', N],
          ...cartons.map((c) => [`Carton ${c.seq}`, `${c.carton_code} · ${weightText(Number(c.gross_mg))}`] as [string, string]),
          ...lotLines.map(([lot, n]) => [`Lot ${lot}`, `${n} ${Number(n) === 1 ? 'unit' : 'units'}`] as [string, string]),
        ].slice(0, 20) as Array<[string, string | number]>,
        code: String(s.shipment_no),
      },
    }, principal);
    return { shipment: await this.shipment(shipmentId), cartonLabels, packingList };
  }

  shapeShipment(r: Record<string, unknown>) {
    return {
      shipmentId: String(r.shipment_id), shipmentNo: String(r.shipment_no), salesOrderId: String(r.sales_order_id),
      soNumber: (r.so_number as string | null) ?? null, status: String(r.status), lots: (r.lots as string[]) ?? [],
      cartonCount: r.carton_count === null || r.carton_count === undefined ? null : Number(r.carton_count),
      courierCode: (r.courier_code as string | null) ?? null, awb: (r.awb as string | null) ?? null, awbSource: (r.awb_source as string | null) ?? null,
      dispatchId: (r.dispatch_id as string | null) ?? null, handedOverAt: iso(r.handed_over_at), handedOverTo: (r.handed_over_to as string | null) ?? null,
      holdReason: (r.hold_reason as string | null) ?? null, docs: (typeof r.docs === 'string' ? JSON.parse(r.docs) : r.docs) ?? null,
      packedAt: iso(r.packed_at), createdAt: iso(r.created_at),
    };
  }
  shapeCarton(c: Record<string, unknown>) {
    return {
      cartonId: String(c.carton_id), shipmentId: String(c.shipment_id), seq: Number(c.seq), cartonCode: String(c.carton_code), status: String(c.status),
      grossMg: c.gross_mg === null || c.gross_mg === undefined ? null : Number(c.gross_mg), weightSource: (c.weight_source as string | null) ?? null,
      checkedAt: iso(c.checked_at),
    };
  }
  shapeUnit(u: Record<string, unknown>) {
    return {
      unitId: String(u.unit_id), unitCode: String(u.unit_code), shipmentId: String(u.shipment_id), finishedGoodBatchId: String(u.finished_good_batch_id),
      batchNumber: (u.batch_number as string | null) ?? null, targetMg: Number(u.target_mg), toleranceMg: Number(u.tolerance_mg), netMg: Number(u.net_mg),
      weightSource: String(u.weight_source), cartonId: (u.carton_id as string | null) ?? null,
    };
  }
}
