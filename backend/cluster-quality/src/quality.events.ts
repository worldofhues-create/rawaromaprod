/**
 * quality cluster events — the cross-cluster signals this cluster emits via the
 * transactional outbox. Declared inline with `defineEvent` (no shared contracts package for
 * the @ra clusters yet). Payloads carry ids / soft-refs only.
 *
 * Emitted from the QC disposition flow: on ACCEPT → `quality.qc.passed`; on REJECT →
 * `quality.qc.failed`. Downstream (inventory) reacts to release/quarantine the rm_batch.
 */
import { z } from 'zod';
import { defineEvent, uuid } from '@core/contracts';

export const qualityEvents = {
  qcPassed: defineEvent(
    'quality.qc.passed',
    z.object({ qcInspectionId: uuid, rmBatchId: uuid }),
  ),
  qcFailed: defineEvent(
    'quality.qc.failed',
    z.object({ qcInspectionId: uuid, rmBatchId: uuid }),
  ),
  qcHold: defineEvent(
    'quality.qc.hold',
    z.object({ qcInspectionId: uuid, rmBatchId: uuid }),
  ),
} as const;
