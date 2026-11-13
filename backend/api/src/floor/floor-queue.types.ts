/**
 * The floor queue's two shapes, on their own (STAGE-2-RP). They lived in floor-queue.service.ts, which
 * imports pipeline.ts for the late prediction, while pipeline.ts imported these types back: a cycle
 * `pnpm boundaries` had reported since PROD-D. Types only; floor-queue.service.ts still exports them.
 */
export interface QueueJob {
  floorJobId: string;
  jobNo: string;
  stage: string;
  orderRef: string | null;
  tote: string | null;
  promiseDt: string | null;
  createdDt: string;
  expedite: boolean;
  channel: string | null;
  customerTier: string | null;
  ready: boolean;
  waitingOn: string[];
  /** ORDER (a customer order, the default) or SUGGESTED (an approved cover suggestion). */
  source?: 'ORDER' | 'SUGGESTED';
  /** FLOOR-LOT-STOP-1: why the line is stopped, or null. */
  stopped?: string | null;
}

export interface RankedJob extends QueueJob {
  position: number | null;
  lane: 'NEW' | 'DELAYED';
  daysLate: number;
  priority: 'EXPEDITE' | 'TOP' | 'ALTERNATE' | 'SUGGESTED' | 'HOLD';
  why: string;
  policyVersion: number | null;
}
