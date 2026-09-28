/**
 * CoaService — Certificate-of-Analysis data from factory QC (owner ruling 2026-09-28, item 1).
 *
 *   product QC spec   per product: specific gravity 20/4 °C min/max, flash point (Pensky-Martens
 *                     closed cup) min/max °C, shelf life (months), optional colour/odour standards.
 *   batch COA         per oil batch: the analyst's results, judged against a SNAPSHOT of the spec
 *                     (a later spec change never re-judges a tested batch), pass/fail per test
 *                     (specific gravity and flash point by range; colour/appearance and odour by the
 *                     analyst's conformance call), overall PASS only when all four pass, production
 *                     date (defaults to the batch's produced date) and best-before = production date
 *                     + the product's shelf life. Re-recordable until released.
 *   release           only an overall-PASS batch can be released. Release stamps who/when and, in
 *                     the SAME transaction, writes `qc.batch.released` to the bridge outbox
 *                     (payload: @core/contracts bridge.QcBatchReleasedPayload). A FAIL is refused
 *                     with 409 and emits nothing. A second release of a released batch is a no-op
 *                     (no second event).
 *
 * Product resolution: the batch's production order → plan item → formula_id → the product(s)
 * whose product_master.formula_id is that formula. When the chain yields exactly one product it is
 * used; a caller-named product must be one of the chain's products when the chain yields any.
 *
 * Cross-schema reads (packaging.product_master/product_sku, platform.document_master,
 * iam.user_master, production.production_plan_items) are raw SQL inside this cluster's own
 * transaction — the same idiom batch/planning services use; no new workspace dependency.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { bridge as bridgeContracts } from '@core/contracts';
import { emitBridgeManualEvent, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { PRODUCTION_DB, productionSchema, type ProductionDb } from '../production.tokens.js';
import type { ListCoaQuery, RecordBatchCoa, UpsertProductQcSpec } from './coa.dtos.js';

const { productQcSpec, batchCoa, batchCoaPhoto, oilBatchMaster } = productionSchema;

type Tx = Parameters<Parameters<ProductionDb['transaction']>[0]>[0];

/** yyyy-mm-dd of a date-ish value (a postgres `date` string, a Date, an ISO timestamp). */
export function ymd(v: string | Date): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** productionDate + months, clamped to the target month's last day (31 Jan + 1 → 28/29 Feb). */
export function addMonthsYmd(productionDate: string, months: number): string {
  const [y, m, d] = productionDate.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Inclusive range check — the COA prints "min - max", and a result on the boundary is in spec. */
export function withinSpec(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

export interface ProductRow { product_id: string; product_code: string | null; product_name: string | null }

@Injectable()
export class CoaService {
  constructor(@Inject(PRODUCTION_DB) private readonly db: ProductionDb) {}

  /* ── product QC spec ─────────────────────────────────────────────────────────────────── */

  /** Every product with its QC spec (null when none is set yet) — the QC spec screen. */
  async listSpecs(limit = 200) {
    return (await this.db.execute(sql`
      select p.product_id as "productId", p.product_code as "productCode", p.product_name as "productName",
             s.product_qc_spec_id as "productQcSpecId", s.sg_min as "sgMin", s.sg_max as "sgMax",
             s.flash_point_min_c as "flashPointMinC", s.flash_point_max_c as "flashPointMaxC",
             s.shelf_life_months as "shelfLifeMonths", s.colour_appearance_standard as "colourAppearanceStandard",
             s.odour_standard as "odourStandard", s.updated_dt as "updatedDt",
             case when s.product_qc_spec_id is null then 'NO_SPEC' else 'ACTIVE' end as status
        from packaging.product_master p
        left join production.product_qc_spec s on s.product_id = p.product_id
       order by p.product_code nulls last
       limit ${Math.min(Math.max(limit, 1), 500)}
    `)) as unknown as Record<string, unknown>[];
  }

  async getSpec(productId: string) {
    return (await this.db.select().from(productQcSpec).where(eq(productQcSpec.productId, productId)).limit(1))[0] ?? null;
  }

  async upsertSpec(productId: string, body: UpsertProductQcSpec, principal: AuthPrincipal) {
    const product = await this.product(this.db, productId);
    if (!product) throw new NotFoundException(`product not found: ${productId}`);
    const values = {
      sgMin: String(body.sgMin),
      sgMax: String(body.sgMax),
      flashPointMinC: String(body.flashPointMinC),
      flashPointMaxC: String(body.flashPointMaxC),
      shelfLifeMonths: body.shelfLifeMonths,
      colourAppearanceStandard: body.colourAppearanceStandard ?? null,
      odourStandard: body.odourStandard ?? null,
      status: 'ACTIVE',
      updatedBy: principal.userId,
    };
    const row = (
      await this.db
        .insert(productQcSpec)
        .values({ productQcSpecId: uuidv7(), productId, createdBy: principal.userId, ...values })
        .onConflictDoUpdate({ target: productQcSpec.productId, set: { ...values, updatedDt: new Date() } })
        .returning()
    )[0];
    return row;
  }

  /* ── batch COA ───────────────────────────────────────────────────────────────────────── */

  async listCoas(query: ListCoaQuery) {
    return (await this.db.execute(sql`
      select c.batch_coa_id as "batchCoaId", c.oil_batch_id as "oilBatchId", b.batch_number as "batchNumber",
             c.product_id as "productId", p.product_code as "productCode", p.product_name as "productName",
             c.sg_result as "sgResult", c.sg_pass as "sgPass", c.flash_point_result_c as "flashPointResultC",
             c.flash_point_pass as "flashPointPass", c.colour_appearance_pass as "colourAppearancePass",
             c.odour_pass as "odourPass", c.overall_result as "overallResult",
             c.production_date::text as "productionDate", c.best_before::text as "bestBefore",
             c.released_dt as "releasedDt", c.status
        from production.batch_coa c
        left join production.oil_batch_master b on b.oil_batch_id = c.oil_batch_id
        left join packaging.product_master p on p.product_id = c.product_id
       where ${query.status ? sql`c.status = ${query.status}` : sql`true`}
       order by c.batch_coa_id desc
       limit ${query.limit}
    `)) as unknown as Record<string, unknown>[];
  }

  async getCoa(batchCoaId: string) {
    const coa = (await this.db.select().from(batchCoa).where(eq(batchCoa.batchCoaId, batchCoaId)).limit(1))[0];
    if (!coa) return null;
    const photos = await this.db.select().from(batchCoaPhoto).where(eq(batchCoaPhoto.batchCoaId, batchCoaId));
    return { ...coa, photos };
  }

  /** The products an oil batch's formula maps to — the batch screen's product picker. */
  async productsForBatch(oilBatchId: string): Promise<ProductRow[]> {
    return this.candidateProducts(this.db, oilBatchId);
  }

  /** The products a batch's formula maps to (via order → plan item → formula_id). */
  private async candidateProducts(tx: Tx | ProductionDb, oilBatchId: string): Promise<ProductRow[]> {
    return (await tx.execute(sql`
      select distinct p.product_id::text as product_id, p.product_code, p.product_name
        from production.oil_batch_master b
        join production.production_order o on o.production_order_id = b.production_order_id
        join production.production_plan_items i on i.production_plan_item_id = o.production_plan_item_id
        join packaging.product_master p on p.formula_id = i.formula_id
       where b.oil_batch_id = ${oilBatchId} and i.formula_id is not null
    `)) as unknown as ProductRow[];
  }

  async recordCoa(body: RecordBatchCoa, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const batch = (await tx.select().from(oilBatchMaster).where(eq(oilBatchMaster.oilBatchId, body.oilBatchId)).limit(1))[0];
      if (!batch) throw new NotFoundException(`oil batch not found: ${body.oilBatchId}`);
      if (String(batch.status ?? '').toUpperCase() === 'FAILED') {
        throw new ConflictException(`Oil batch ${batch.batchNumber ?? body.oilBatchId} is FAILED; it cannot carry a certificate of analysis.`);
      }

      const productId = await this.resolveProduct(tx, body.oilBatchId, body.productId);
      const spec = (await tx.select().from(productQcSpec).where(eq(productQcSpec.productId, productId)).limit(1))[0];
      if (!spec) {
        throw new ConflictException('This product has no QC specification yet. Set its specific gravity, flash point and shelf life on the QC spec screen first.');
      }

      const existing = (await tx.select().from(batchCoa).where(eq(batchCoa.oilBatchId, body.oilBatchId)).for('update').limit(1))[0];
      if (existing?.status === 'RELEASED') {
        throw new ConflictException('This batch has already been released; its certificate of analysis can no longer change.');
      }

      for (const p of body.photos) {
        if (p.documentId && !(await this.documentExists(tx, p.documentId))) {
          throw new BadRequestException(`photo document not found: ${p.documentId}`);
        }
      }

      const sgMin = Number(spec.sgMin), sgMax = Number(spec.sgMax);
      const fpMin = Number(spec.flashPointMinC), fpMax = Number(spec.flashPointMaxC);
      const sgPass = withinSpec(body.sgResult, sgMin, sgMax);
      const fpPass = withinSpec(body.flashPointResultC, fpMin, fpMax);
      const overall = sgPass && fpPass && body.colourAppearancePass && body.odourPass ? 'PASS' : 'FAIL';
      const productionDate = body.productionDate ?? ymd(batch.producedDt ?? batch.createdDt);
      const bestBefore = addMonthsYmd(productionDate, spec.shelfLifeMonths);

      const values = {
        productId,
        sgResult: String(body.sgResult), sgSpecMin: spec.sgMin, sgSpecMax: spec.sgMax, sgPass,
        flashPointResultC: String(body.flashPointResultC), flashPointSpecMinC: spec.flashPointMinC,
        flashPointSpecMaxC: spec.flashPointMaxC, flashPointPass: fpPass,
        colourAppearance: body.colourAppearance, colourAppearancePass: body.colourAppearancePass,
        odourDescription: body.odourDescription, odourPass: body.odourPass,
        productionDate, bestBefore, overallResult: overall,
        testedBy: principal.userId, testedDt: new Date(), status: 'TESTED', updatedBy: principal.userId,
      };
      const coa = existing
        ? (await tx.update(batchCoa).set({ ...values, updatedDt: new Date() }).where(eq(batchCoa.batchCoaId, existing.batchCoaId)).returning())[0]!
        : (await tx.insert(batchCoa).values({ batchCoaId: uuidv7(), oilBatchId: body.oilBatchId, createdBy: principal.userId, ...values }).returning())[0]!;

      await tx.delete(batchCoaPhoto).where(eq(batchCoaPhoto.batchCoaId, coa.batchCoaId));
      for (const p of body.photos) {
        await tx.insert(batchCoaPhoto).values({
          batchCoaPhotoId: uuidv7(), batchCoaId: coa.batchCoaId, documentId: p.documentId ?? null,
          url: p.url ?? null, caption: p.caption ?? null, status: 'ACTIVE',
          createdBy: principal.userId, updatedBy: principal.userId,
        });
      }
      return { coa, failedTests: failedTests(coa) };
    });
  }

  /**
   * POST /v1/batch-coas/:id/release — release a PASSED batch and emit `qc.batch.released` in the
   * same transaction. FAIL → 409, nothing emitted. Already released → returned as-is, nothing
   * emitted again.
   */
  async releaseCoa(batchCoaId: string, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const coa = (await tx.select().from(batchCoa).where(eq(batchCoa.batchCoaId, batchCoaId)).for('update').limit(1))[0];
      if (!coa) throw new NotFoundException(`batch COA not found: ${batchCoaId}`);
      if (coa.status === 'RELEASED') return { coa, emitted: false };
      if (coa.overallResult !== 'PASS') {
        throw new ConflictException(`This batch failed QC (${failedTests(coa).join(', ')}) and cannot be released.`);
      }
      const batch = (await tx.select().from(oilBatchMaster).where(eq(oilBatchMaster.oilBatchId, coa.oilBatchId)).limit(1))[0];
      if (!batch) throw new NotFoundException(`oil batch not found: ${coa.oilBatchId}`);
      if (String(batch.status ?? '').toUpperCase() === 'FAILED') throw new ConflictException('The oil batch is FAILED and cannot be released.');

      const product = await this.product(tx, coa.productId);
      if (!product?.product_code) throw new ConflictException('The product has no product code; ALEMBIC cannot map a certificate without one.');
      const skuCodes = ((await tx.execute(sql`
        select sku_code from packaging.product_sku where product_id = ${coa.productId} and sku_code is not null order by sku_code
      `)) as unknown as { sku_code: string }[]).map((r) => r.sku_code);
      const photos = await tx.select().from(batchCoaPhoto).where(eq(batchCoaPhoto.batchCoaId, batchCoaId));
      const docPaths = new Map<string, string | null>();
      for (const p of photos) if (p.documentId) docPaths.set(p.documentId, await this.documentPath(tx, p.documentId));
      const releaserName = ((await tx.execute(sql`
        select user_name from iam.user_master where user_id = ${principal.userId} limit 1
      `)) as unknown as { user_name: string | null }[])[0]?.user_name ?? null;

      const releasedAt = new Date();
      const payload = buildQcBatchReleasedPayload({
        batchNo: batch.batchNumber ?? '', productRef: product.product_code, skuCodes, coa,
        photos: photos.map((p) => ({ documentId: p.documentId, url: p.url, caption: p.caption, documentPath: p.documentId ? docPaths.get(p.documentId) ?? null : null })),
        releasedAt, releasedBy: principal.userId, releasedByName: releaserName,
      });
      const problems = bridgeContracts.validateQcBatchReleased(payload);
      if (problems.length > 0) throw new ConflictException(`The release could not be sent: incomplete ${problems.join(', ')}.`);
      bridgeContracts.assertNoFormulaContent(payload);

      const released = (
        await tx.update(batchCoa)
          .set({ status: 'RELEASED', releasedBy: principal.userId, releasedDt: releasedAt, updatedBy: principal.userId, updatedDt: releasedAt })
          .where(and(eq(batchCoa.batchCoaId, batchCoaId), eq(batchCoa.status, 'TESTED')))
          .returning()
      )[0];
      if (!released) throw new ConflictException('This batch was changed by another request; reload and try again.');
      await emitBridgeManualEvent(tx, bridgeContracts.QC_BATCH_RELEASED, batchCoaId, payload as unknown as Record<string, unknown>);
      return { coa: released, emitted: true };
    });
  }

  /* ── helpers ─────────────────────────────────────────────────────────────────────────── */

  private async resolveProduct(tx: Tx, oilBatchId: string, requested: string | undefined): Promise<string> {
    const candidates = await this.candidateProducts(tx, oilBatchId);
    if (requested) {
      if (!(await this.product(tx, requested))) throw new NotFoundException(`product not found: ${requested}`);
      if (candidates.length > 0 && !candidates.some((c) => c.product_id === requested)) {
        throw new ConflictException('That product is not made from this batch\'s formula. Pick one of the batch\'s products.');
      }
      return requested;
    }
    if (candidates.length === 1) return candidates[0]!.product_id;
    throw new BadRequestException(
      candidates.length === 0
        ? 'Choose the product this batch is for (its production order does not name a formula with a product).'
        : 'This batch\'s formula is used by more than one product; choose the product.',
    );
  }

  private async product(tx: Tx | ProductionDb, productId: string): Promise<ProductRow | null> {
    return ((await tx.execute(sql`
      select product_id::text as product_id, product_code, product_name from packaging.product_master where product_id = ${productId} limit 1
    `)) as unknown as ProductRow[])[0] ?? null;
  }

  private async documentExists(tx: Tx, documentId: string): Promise<boolean> {
    return ((await tx.execute(sql`select 1 from platform.document_master where document_id = ${documentId} limit 1`)) as unknown as unknown[]).length > 0;
  }

  private async documentPath(tx: Tx, documentId: string): Promise<string | null> {
    return ((await tx.execute(sql`select file_path from platform.document_master where document_id = ${documentId} limit 1`)) as unknown as { file_path: string | null }[])[0]?.file_path ?? null;
  }
}

type CoaRow = typeof batchCoa.$inferSelect;

export function failedTests(coa: Pick<CoaRow, 'sgPass' | 'flashPointPass' | 'colourAppearancePass' | 'odourPass'>): string[] {
  const out: string[] = [];
  if (!coa.sgPass) out.push('specific gravity');
  if (!coa.flashPointPass) out.push('flash point');
  if (!coa.colourAppearancePass) out.push('colour & appearance');
  if (!coa.odourPass) out.push('odour');
  return out;
}

/** Pure payload builder for `qc.batch.released` — exported for the shape test. */
export function buildQcBatchReleasedPayload(input: {
  batchNo: string;
  productRef: string;
  skuCodes: string[];
  coa: CoaRow;
  photos: { documentId: string | null; url: string | null; caption: string | null; documentPath: string | null }[];
  releasedAt: Date;
  releasedBy: string;
  releasedByName: string | null;
}): bridgeContracts.QcBatchReleasedPayload {
  const { coa } = input;
  const isHttp = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u);
  return {
    batchNo: input.batchNo,
    productRef: input.productRef,
    skuCodes: input.skuCodes,
    results: [
      {
        test: bridgeContracts.COA_TEST_SPECIFIC_GRAVITY, value: Number(coa.sgResult), unit: null,
        specMin: Number(coa.sgSpecMin), specMax: Number(coa.sgSpecMax), pass: coa.sgPass,
      },
      {
        test: bridgeContracts.COA_TEST_FLASH_POINT, value: Number(coa.flashPointResultC), unit: '°C',
        specMin: Number(coa.flashPointSpecMinC), specMax: Number(coa.flashPointSpecMaxC), pass: coa.flashPointPass,
      },
    ],
    colourAppearance: coa.colourAppearance,
    odourDescription: coa.odourDescription,
    photos: input.photos.map((p) => {
      const url = isHttp(p.url) ? p.url : isHttp(p.documentPath) ? p.documentPath : undefined;
      return {
        ...(url ? { url } : {}),
        ...(p.documentId ? { assetRef: `document:${p.documentId}` } : {}),
        caption: p.caption,
      };
    }),
    productionDate: ymd(coa.productionDate),
    bestBefore: ymd(coa.bestBefore),
    releasedAt: input.releasedAt.toISOString(),
    releasedBy: input.releasedBy,
    releasedByName: input.releasedByName,
  };
}
