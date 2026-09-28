/**
 * FgLabelService (OPS-GREEN Act L, lane ops-factory; extended by lane produce 2026-09-29) — the
 * LABEL step: fill → FG batch → QC released → LABEL (rack assigned) → put away → packaging QC.
 *
 * The label's content is composed HERE from the records — the operator supplies only how many
 * labels were applied. Nothing on it is typed in, and no regulatory field the records do not
 * carry (price, licence number, address) is invented. Missing batch data is refused rather than
 * printed blank. PackagingQcService refuses a label check of PASS for a batch with no APPLIED label.
 *
 * Lane produce (owner requirement 2026-09-29) — the label carries: product (code + name), batch,
 * SKU and pack size, net quantity + unit, manufacturing and expiry dates, the QC status (only a
 * QC-RELEASED batch may be labelled: a batch whose certificate of analysis failed — or was never
 * released — is refused, and a FAILED batch raises an alert), the DG/hazard block where the
 * product has one (packaging.product_dg_info), and the RACK location assigned for put-away
 * (ShelfTaskService.ensurePutaway picks the bin now, so the label and the shelf agree; the
 * put-away itself happens at the shelf). `preview()` composes the same content for printing
 * without recording anything (browser print / PDF at label-printer sizes, web/ws-produce.js).
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { sql as dsql } from 'drizzle-orm';
import { PG_CLIENT, recordProduceAlert, type AuthPrincipal } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { shelfDb } from '../shelf/shelf.tokens.js';
import { ShelfTaskService, qcRefusal, type FgBatchInfo } from '../shelf/shelf-task.service.js';
import { ShelfLayoutService } from '../shelf/shelf-layout.service.js';
import { PickLightService } from '../shelf/pick-light.service.js';

export interface DgBlock {
  unNumber: string | null;
  properShippingName: string | null;
  dgClass: string | null;
  packingGroup: string | null;
  signalWord: string | null;
  hazardStatements: string | null;
}

export interface LabelContent {
  skuCode: string;
  batchNumber: string;
  manufacturingDate: string;
  expiryDate: string;
  netQuantity: string;
  unit: string | null;
  productCode: string | null;
  productName: string | null;
  packSize: string | null;
  qcStatus: 'RELEASED';
  qcReleasedAt: string | null;
  dg: DgBlock | null;
  /** The put-away location (rack-shelf-bin), assigned before the label is printed; null when no bin exists yet. */
  rack: string | null;
  /** true while the rack is the assigned target (not yet confirmed at the shelf). */
  rackAssigned: boolean;
}

const COLS = `fg_label_record_id as "fgLabelRecordId", finished_good_batch_id as "finishedGoodBatchId",
  label_count as "labelCount", label_content as "labelContent", applied_by as "appliedBy",
  applied_dt as "appliedDt", status`;

@Injectable()
export class FgLabelService {
  private readonly shelf: ShelfTaskService;

  constructor(@Inject(PG_CLIENT) private readonly sql: Sql, @Optional() shelf?: ShelfTaskService) {
    if (shelf) this.shelf = shelf;
    else {
      const db = shelfDb(sql);
      const layout = new ShelfLayoutService(db);
      this.shelf = new ShelfTaskService(db, layout, new PickLightService(db));
    }
  }

  /** The label as it would print now (no record written). Refused exactly as `apply` is. */
  async preview(finishedGoodBatchId: string, principal: AuthPrincipal): Promise<LabelContent> {
    const fg = await this.gate(finishedGoodBatchId, principal);
    return this.compose(fg);
  }

  async apply(finishedGoodBatchId: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    const labelCount = Number(body.labelCount);
    if (!Number.isInteger(labelCount) || labelCount < 1 || labelCount > 100_000) {
      throw new BadRequestException('labelCount must be a whole number of labels applied (1..100000).');
    }
    const fg = await this.gate(finishedGoodBatchId, principal);
    assertLabelFields(fg);
    // The rack goes on the label, so the bin is assigned before it prints (the put-away itself is
    // confirmed at the shelf). A batch already on the shelves keeps its location.
    if (fg.stocked < fg.producedQty) await this.shelf.ensurePutaway(fg.id, principal);
    const content = await this.compose(fg);
    return this.sql.begin(async (tx) => {
      const locked = (await tx`select 1 from packaging.finished_good_batch_master where finished_good_batch_id = ${finishedGoodBatchId} for update`)[0];
      if (!locked) throw new NotFoundException(`finished_good_batch_master not found: ${finishedGoodBatchId}`);
      const rows = await tx`
        insert into packaging.fg_label_record
          (finished_good_batch_id, label_count, label_content, applied_by, applied_dt, status, created_by, updated_by)
        values (${finishedGoodBatchId}, ${labelCount}, ${JSON.stringify(content)}::text::jsonb, ${principal.userId}, now(),
                'APPLIED', ${principal.userId}, ${principal.userId})
        returning ${tx.unsafe(COLS)}`;
      await tx`
        insert into packaging.outbox (type, aggregate_id, payload)
        values ('packaging.label.applied', ${finishedGoodBatchId},
          ${JSON.stringify({ finishedGoodBatchId, labelCount })}::jsonb)`;
      return rows[0];
    });
  }

  async list(finishedGoodBatchId: string | undefined, limit = 100) {
    const lim = Math.min(Math.max(1, limit), 200);
    const rows = finishedGoodBatchId
      ? await this.sql`select ${this.sql.unsafe(COLS)} from packaging.fg_label_record
                        where finished_good_batch_id = ${finishedGoodBatchId} order by applied_dt desc limit ${lim}`
      : await this.sql`select ${this.sql.unsafe(COLS)} from packaging.fg_label_record order by applied_dt desc limit ${lim}`;
    return { items: rows, nextCursor: null };
  }

  /** QC gate: only a QC-RELEASED batch is labelled; a FAILED one also alerts (once per batch). */
  private async gate(finishedGoodBatchId: string, principal: AuthPrincipal): Promise<FgBatchInfo> {
    const fg = await this.shelf.fgBatch(finishedGoodBatchId);
    if (fg.qc === 'RELEASED') return fg;
    if (fg.qc === 'FAILED') {
      const db = shelfDb(this.sql);
      await db.transaction((tx) => recordProduceAlert(tx, {
        kind: 'label_blocked', severity: 'high',
        title: `Labelling blocked: batch ${fg.batchNumber ?? fg.id} failed QC`,
        detail: `Someone tried to label it (${principal.userId}). A failed batch is never labelled.`,
        roles: ['packaging', 'qc', 'production'], refType: 'fg_batch', refId: fg.id,
        dedupeKey: `label_blocked:${fg.id}`,
      }));
    }
    throw new ConflictException(qcRefusal(fg, 'label'));
  }

  private async compose(fg: FgBatchInfo): Promise<LabelContent> {
    const db = shelfDb(this.sql);
    const dg = fg.productId
      ? ((await db.execute(dsql`
          select un_number, proper_shipping_name, dg_class, packing_group, signal_word, hazard_statements
            from packaging.product_dg_info where product_id = ${fg.productId}::uuid
        `)) as unknown as Array<Record<string, string | null>>)[0]
      : undefined;
    const where = await this.shelf.whereIs(fg.id);
    const content: LabelContent = {
      skuCode: String(fg.skuCode ?? ''),
      batchNumber: String(fg.batchNumber ?? ''),
      manufacturingDate: fg.manufacturingDate ?? '',
      expiryDate: fg.expiryDate ?? '',
      netQuantity: fg.producedQty ? String(Number(fg.producedQty)) : '',
      unit: fg.uomCode ? String(fg.uomCode) : null,
      productCode: fg.productCode,
      productName: fg.productName,
      packSize: fg.packSize,
      qcStatus: 'RELEASED',
      qcReleasedAt: fg.releasedAt,
      dg: dg && Object.values(dg).some((v) => v !== null && String(v).trim() !== '')
        ? {
            unNumber: dg.un_number ?? null, properShippingName: dg.proper_shipping_name ?? null,
            dgClass: dg.dg_class ?? null, packingGroup: dg.packing_group ?? null,
            signalWord: dg.signal_word ?? null, hazardStatements: dg.hazard_statements ?? null,
          }
        : null,
      rack: where.label,
      rackAssigned: where.assigned,
    };
    assertLabelFields(fg);
    return content;
  }
}

/** A label is never printed with a blank field the batch record should carry. */
function assertLabelFields(fg: FgBatchInfo): void {
  const missing = ([
    ['skuCode', fg.skuCode], ['batchNumber', fg.batchNumber], ['manufacturingDate', fg.manufacturingDate],
    ['expiryDate', fg.expiryDate], ['netQuantity', fg.producedQty ? String(fg.producedQty) : ''],
  ] as const).filter(([, v]) => v === null || v === undefined || String(v) === '').map(([k]) => k);
  if (missing.length > 0) {
    throw new ConflictException(`The batch record lacks ${missing.join(', ')}: a label is never printed with blank fields.`);
  }
}

/** True when the batch carries at least one APPLIED label (PackagingQcService's label gate). */
export async function hasAppliedLabel(sql: Sql, finishedGoodBatchId: string | null): Promise<boolean> {
  if (!finishedGoodBatchId) return false;
  const r = await sql`select 1 from packaging.fg_label_record
                       where finished_good_batch_id = ${finishedGoodBatchId} and status = 'APPLIED' limit 1`;
  return r.length > 0;
}
