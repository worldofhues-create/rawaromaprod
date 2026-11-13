/**
 * PROM-2 / PROM-3 test fixtures: the steps a batch must now take to be released, for the tests whose
 * subject is something else (the state machine's edges, concurrency, the outbox). Inside tests only.
 *
 *   qc1          the QC before maceration.
 *   completeRest moves the open run's start back by exactly the days it must rest, so the rest is
 *                served without waiting 45 days. It never shortens a rest a test is about.
 *   qc2          the QC after the rest.
 */
import type { Sql } from 'postgres';
import type { AuthPrincipal } from '../backend-kernel/src/edge/principal.js';
import type { BatchService } from '../cluster-production/src/batch/batch.service.js';

const tick = () => new Promise((r) => setTimeout(r, 15));

export async function qc1(batches: BatchService, oilBatchId: string, p: AuthPrincipal): Promise<void> {
  await batches.recordProductionQc({ oilBatchId, result: 'PASS' }, p);
  await tick();
}

export async function completeRest(sql: Sql, oilBatchId: string): Promise<void> {
  await sql`update production.maceration_run set started_at = started_at - make_interval(days => min_days + extend_days)
             where oil_batch_id = ${oilBatchId} and status = 'MACERATING'`;
}

export async function qc2(batches: BatchService, oilBatchId: string, p: AuthPrincipal): Promise<void> {
  await tick();
  await batches.recordProductionQc({ oilBatchId, result: 'PASS' }, p);
}
