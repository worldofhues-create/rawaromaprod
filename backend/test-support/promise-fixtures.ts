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

const REFERENCE_ON = { rules: [], hasDefault: true, defaultValue: { required: true } };
const REFERENCE_OFF = { rules: [], hasDefault: true, defaultValue: { required: false } };
const RULE_EDITOR = { userId: '00000000-0000-7000-8000-0000000000a1', portal: 'ops', roles: ['admin'], permissions: ['platform:policy:write'] } as unknown as AuthPrincipal;

/**
 * PROM-3: for a suite whose subject is the REST or the state machine, not the QC basis, the typed
 * production_qc reading stays the verdict, exactly as before PROM-3: `qc.reference_required` is
 * published OFF for the suite and back ON (the shipped default) after it. The rounds-are-the-verdict
 * path is proved in prom-3-reference.test.ts. Files run one at a time (run-tests.mjs), so no other
 * suite sees the switch.
 */
export async function typedQcIsTheVerdict(policy: { publish: (key: string, body: unknown, reason: string, p: AuthPrincipal) => Promise<unknown> }): Promise<() => Promise<void>> {
  await policy.publish('qc.reference_required', REFERENCE_OFF, 'test suite: the typed QC reading is the verdict for this suite', RULE_EDITOR);
  return async () => { await policy.publish('qc.reference_required', REFERENCE_ON, 'test suite: back to the shipped default', RULE_EDITOR); };
}
