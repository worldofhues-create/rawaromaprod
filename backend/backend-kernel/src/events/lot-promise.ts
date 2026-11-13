/**
 * PROM-3 / PROM-6 (LD-85, ALEMBIC docs/plan/program/process-promises.md): the process record of one
 * compounded (oil) batch, as ALEMBIC is told it. Read in the caller's transaction.
 *
 *   qcPromiseBlockOf   each staged QC 1 / QC 2 round, the retained reference the latest round compared
 *                      with, and whether this batch IS a product's reference: the block `qc.batch.released`
 *                      carries (PROM-3; CoaService delegates here, so there is one implementation).
 *   restRecordOf       the batch's closed rest, in `batch.rest.recorded`'s shape, or null.
 *   fgPromiseBlockOf   the `promise` block of `fg.batch.received` for a lot filled from this batch: its
 *                      number, rest, QC block, continuity key and opaque formula version id (PROM-6).
 *
 * Rule 3: whatever is not on file is null and ALEMBIC's lot page says "Not on file"; nothing is filled
 * in. D-1: opaque refs, codes and dates only; no material, supplier, formula name, percentage or person.
 */
import { sql } from 'drizzle-orm';
import { bridge as bridgeContracts } from '@core/contracts';
import type { BridgeEmitTx } from './bridge-emit.js';

const rows = async <T>(tx: BridgeEmitTx, q: unknown): Promise<T[]> => Array.from((await tx.execute(q)) as unknown as T[]);
const ISO = (col: string) => sql.raw(`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

export async function qcPromiseBlockOf(tx: BridgeEmitTx, oilBatchId: string): Promise<bridgeContracts.QcPromiseBlockWire> {
  const rounds = await rows<{ id: string; stage: bridgeContracts.QcStageCode; decision: bridgeContracts.QcStageWire['decision']; ref_id: string | null; decided_at: string }>(tx, sql`
    select r.batch_qc_round_id::text as id, r.stage, r.decision, r.reference_standard_id::text as ref_id,
           ${ISO('r.created_dt')} as decided_at
      from quality.batch_qc_round r
     where r.oil_batch_id = ${oilBatchId} and r.stage is not null order by r.round_no`);
  const last = [...rounds].reverse().find((r) => r.ref_id);
  let reference: bridgeContracts.QcReferenceWire | null = null;
  if (last?.ref_id) {
    const [ref] = await rows<{ reference_code: string; sample_code: string | null; retained_at: string | null }>(tx, sql`
      select rs.reference_code, s.sample_code, ${ISO('s.retained_dt')} as retained_at
        from quality.reference_standard rs left join quality.qc_sample_retention s on s.qc_sample_retention_id = rs.qc_sample_retention_id
       where rs.reference_standard_id = ${last.ref_id}`);
    if (ref?.sample_code) reference = { ref: ref.reference_code, sample_code: ref.sample_code, retained_at: ref.retained_at };
  }
  const isRef = (await rows<{ one: number }>(tx, sql`
    select 1 as one from quality.reference_standard where oil_batch_id = ${oilBatchId} and status in ('ACTIVE', 'RETIRED') limit 1`)).length > 0;
  return {
    stages: rounds.map((r) => ({ stage: r.stage, round_ref: r.id, decided_at: r.decided_at, decision: r.decision })),
    reference,
    is_reference_batch: isRef,
  };
}

/** The batch's latest CLOSED rest as `batch.rest.recorded` sent it, or null (no closed run on file). */
export async function restRecordOf(tx: BridgeEmitTx, oilBatchId: string): Promise<bridgeContracts.BatchRestRecordedWire | null> {
  const [r] = await rows<{ id: string; batch_number: string | null; started_at: string; closed_at: string | null; days_rested: number | null;
    min_days: number; extend_days: number; rule_days: number | null; rule_version: number | null; rest_short: boolean | null; code: string | null }>(tx, sql`
    select mr.maceration_run_id::text as id, ob.batch_number, ${ISO('mr.started_at')} as started_at, ${ISO('mr.closed_at')} as closed_at,
           mr.days_rested, mr.min_days, mr.extend_days, mr.rule_days, mr.rule_version, mr.rest_short, mr.early_release_reason_code as code
      from production.maceration_run mr join production.oil_batch_master ob on ob.oil_batch_id = mr.oil_batch_id
     where mr.oil_batch_id = ${oilBatchId} and mr.status = 'CLOSED' order by mr.closed_at desc limit 1`);
  if (!r || !r.closed_at || r.days_rested === null || !r.batch_number) return null;
  const early = r.rest_short === true;
  return {
    batch_no: r.batch_number,
    oil_batch_ref: oilBatchId,
    started_at: r.started_at,
    closed_at: r.closed_at,
    days_rested: Number(r.days_rested),
    required_days: Number(r.min_days) + Number(r.extend_days ?? 0),
    rule_days: Number(r.rule_days ?? r.min_days),
    rule_version: Number(r.rule_version ?? 0),
    early_release: early,
    early_release_reason_code: early ? ((r.code as bridgeContracts.AwayFromCautionReasonCode | null) ?? 'other') : null,
    temperature: null,
  };
}

/**
 * The `promise` block for a lot filled from `oilBatchId`, or null when the batch has no number. Each part
 * the factory does not hold is null: a rest that never closed, a batch with no staged QC round, a batch
 * compounded before PROM-5 (no continuity key). The parts are checked against ALEMBIC's rules here, and
 * a part that would be refused is sent as null rather than refusing the whole receipt: the goods are on
 * the shelf either way, and a null part reads "Not on file", which is true.
 */
export async function fgPromiseBlockOf(tx: BridgeEmitTx, oilBatchId: string): Promise<bridgeContracts.FgPromiseBlockWire | null> {
  const [b] = await rows<{ batch_number: string | null; continuity_key: string | null; formula_version_ref: string | null }>(tx, sql`
    select ob.batch_number, bc.continuity_key, coalesce(bc.formula_version_ref, po.formula_version_id)::text as formula_version_ref
      from production.oil_batch_master ob
      left join production.batch_continuity bc on bc.oil_batch_id = ob.oil_batch_id
      left join production.production_order po on po.production_order_id = ob.production_order_id
     where ob.oil_batch_id = ${oilBatchId}`);
  if (!b?.batch_number) return null;
  let rest = await restRecordOf(tx, oilBatchId);
  if (rest && (bridgeContracts.checkBatchRestRecordedWire(rest).length || rest.batch_no !== b.batch_number)) rest = null;
  let qc: bridgeContracts.QcPromiseBlockWire | null = await qcPromiseBlockOf(tx, oilBatchId);
  if (!qc.stages.length && !qc.reference && !qc.is_reference_batch) qc = null;
  else if (bridgeContracts.checkQcPromiseBlockWire(qc).length) qc = null;
  return {
    oil_batch_no: b.batch_number,
    rest,
    qc,
    continuity_key: b.continuity_key && /^ck1:[0-9a-f]{64}$/.test(b.continuity_key) ? b.continuity_key : null,
    formula_version_ref: b.formula_version_ref ?? null,
  };
}
