/**
 * FgLabelService (OPS-GREEN Act L, lane ops-factory) — the LABEL step: fill → FG batch → LABEL →
 * package → packaging QC → FG release.
 *
 * The label's content is composed HERE from the finished-good batch's own record (SKU code,
 * batch number, manufacturing and expiry dates, net quantity + unit) — the operator supplies only
 * how many labels were applied. Nothing on it is typed in, and no regulatory field the batch does
 * not carry (price, licence number, address) is invented. Missing batch data is refused rather
 * than printed blank. PackagingQcService refuses a label check of PASS for a batch with no
 * APPLIED label.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import type { Sql } from 'postgres';

export interface LabelContent {
  skuCode: string;
  batchNumber: string;
  manufacturingDate: string;
  expiryDate: string;
  netQuantity: string;
  unit: string | null;
}

const COLS = `fg_label_record_id as "fgLabelRecordId", finished_good_batch_id as "finishedGoodBatchId",
  label_count as "labelCount", label_content as "labelContent", applied_by as "appliedBy",
  applied_dt as "appliedDt", status`;

function isoDate(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null;
}

@Injectable()
export class FgLabelService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async apply(finishedGoodBatchId: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    const labelCount = Number(body.labelCount);
    if (!Number.isInteger(labelCount) || labelCount < 1 || labelCount > 100_000) {
      throw new BadRequestException('labelCount must be a whole number of labels applied (1..100000).');
    }
    return this.sql.begin(async (tx) => {
      const fg = (await tx`
        select fg.finished_good_batch_id, fg.batch_number, fg.manufacturing_date, fg.expiry_date,
               fg.produced_qty::text as produced_qty, fg.status, s.sku_code, u.uom_code
          from packaging.finished_good_batch_master fg
          left join packaging.product_sku s on s.product_sku_id = fg.product_sku_id
          left join platform.uom_master u on u.uom_id = fg.uom_id
         where fg.finished_good_batch_id = ${finishedGoodBatchId}
         for update of fg`)[0];
      if (!fg) throw new NotFoundException(`finished_good_batch_master not found: ${finishedGoodBatchId}`);
      const content: LabelContent = {
        skuCode: String(fg.sku_code ?? ''),
        batchNumber: String(fg.batch_number ?? ''),
        manufacturingDate: isoDate(fg.manufacturing_date) ?? '',
        expiryDate: isoDate(fg.expiry_date) ?? '',
        netQuantity: fg.produced_qty ? String(Number(fg.produced_qty)) : '',
        unit: fg.uom_code ? String(fg.uom_code) : null,
      };
      const missing = (['skuCode', 'batchNumber', 'manufacturingDate', 'expiryDate', 'netQuantity'] as const)
        .filter((k) => content[k] === '');
      if (missing.length > 0) {
        throw new ConflictException(`The batch record lacks ${missing.join(', ')}: a label is never printed with blank fields.`);
      }
      const rows = await tx`
        insert into packaging.fg_label_record
          (finished_good_batch_id, label_count, label_content, applied_by, applied_dt, status, created_by, updated_by)
        values (${finishedGoodBatchId}, ${labelCount}, ${tx.json(content as never)}, ${principal.userId}, now(),
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
}

/** True when the batch carries at least one APPLIED label (PackagingQcService's label gate). */
export async function hasAppliedLabel(sql: Sql, finishedGoodBatchId: string | null): Promise<boolean> {
  if (!finishedGoodBatchId) return false;
  const r = await sql`select 1 from packaging.fg_label_record
                       where finished_good_batch_id = ${finishedGoodBatchId} and status = 'APPLIED' limit 1`;
  return r.length > 0;
}
