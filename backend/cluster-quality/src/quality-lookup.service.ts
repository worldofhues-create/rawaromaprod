/**
 * QualityLookupService — in-cluster implementation of the `QualityLookup` public port.
 * Provided under `QUALITY_LOOKUP` so consumers depend only on the interface, never on a
 * concrete class. A single keyed select returning id + rm_batch + overall result.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { QUALITY_DB, qualitySchema, type QualityDb } from './quality.tokens.js';
import type { InspectionRef, QualityLookup } from './public-api.js';

const { qcInspections } = qualitySchema;

@Injectable()
export class QualityLookupService implements QualityLookup {
  constructor(@Inject(QUALITY_DB) private readonly db: QualityDb) {}

  async getInspection(qcInspectionId: string): Promise<InspectionRef | null> {
    const row = (
      await this.db
        .select({
          qcInspectionId: qcInspections.qcInspectionId,
          rmBatchId: qcInspections.rmBatchId,
          overallResult: qcInspections.overallResult,
        })
        .from(qcInspections)
        .where(eq(qcInspections.qcInspectionId, qcInspectionId))
        .limit(1)
    )[0];
    return row ?? null;
  }
}
