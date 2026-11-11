/**
 * FLOOR-QC-IN-1 — "QC samples every incoming lot", made true at the source.
 *
 * A received raw lot is born QUARANTINE, in the same transaction that creates it, and is written to
 * inventory.lot_qc_event. It used to be born ACTIVE and wait for the automation poller to quarantine
 * it, so with the worker down -- or in the seconds before it ran -- a lot QC had never seen was a
 * plain ACTIVE lot that "Release to stock" and the putaway label both accepted.
 *
 * "Released" means one thing everywhere: the latest incoming inspection is ACCEPT (or PASS), the batch
 * is not QUARANTINE / REJECTED / HOLD, and no hold is open on it. Fail closed: no inspection at all is
 * not released.
 */
import { sql } from 'drizzle-orm';

export const BORN_STATUS = 'QUARANTINE';

interface Exec { execute(q: ReturnType<typeof sql>): Promise<unknown> }

export async function recordLotQcEvent(tx: Exec, rmBatchId: string, event: 'QUARANTINED' | 'RELEASED' | 'REJECTED', detail: string, actor: string): Promise<void> {
  await tx.execute(sql`insert into inventory.lot_qc_event (rm_batch_id, event, detail, actor) values (${rmBatchId}::uuid, ${event}, ${detail}, ${actor})`);
}

/** Why this raw lot may not be used yet, in words for the person asking, or null when QC has released it. */
export async function rmLotQcRefusal(tx: Exec, rmBatchId: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    select rb.batch_number, upper(coalesce(rb.status, '')) as status,
           (select upper(coalesce(q.overall_result, '')) from quality.qc_inspections q where q.rm_batch_id = rb.rm_batch_id order by q.created_dt desc nulls last limit 1) as qc,
           (select h.reason from inventory.lot_hold h where h.subject_type = 'RM_LOT' and h.subject_id = rb.rm_batch_id and h.released_dt is null limit 1) as hold
      from inventory.rm_batch_master rb where rb.rm_batch_id = ${rmBatchId}::uuid`)) as unknown as Array<{ batch_number: string | null; status: string; qc: string | null; hold: string | null }>;
  const r = rows[0];
  if (!r) return 'This lot has no raw-lot record, so QC has no result for it.';
  const n = r.batch_number ?? 'This lot';
  if (r.status === 'REJECTED' || r.qc === 'REJECT') return `${n} was rejected by QC.`;
  if (r.hold) return `${n} is on hold: ${r.hold}`;
  if (r.qc === 'ACCEPT' || r.qc === 'PASS') return null; // QC accepted: QUARANTINE is the state it is released from
  if (r.status === 'QUARANTINE') return `${n} is in quarantine, waiting for incoming QC. It is not released by QC.`;
  return `${n} is not released by QC (${r.qc ? `latest result ${r.qc}` : 'no QC result on file'}).`;
}
