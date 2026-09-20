/**
 * quality cluster — PUBLIC API. Other clusters (inventory, procurement) occasionally need a
 * cold read of a QC inspection's outcome to gate a batch release. The only surface we expose
 * is the `QualityLookup` read port (ids + overall result only). Inject by the
 * `QUALITY_LOOKUP` token; never sync-import the cluster itself.
 */

export interface InspectionRef {
  qcInspectionId: string;
  rmBatchId: string | null;
  overallResult: string | null;
}

/** Cold read port into the QC inspections. */
export interface QualityLookup {
  getInspection(qcInspectionId: string): Promise<InspectionRef | null>;
}

/** DI token for `QualityLookup`. */
export const QUALITY_LOOKUP = Symbol('QUALITY_LOOKUP');
