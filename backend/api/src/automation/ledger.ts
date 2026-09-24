/**
 * automation/ledger.ts — the shared idempotency + decision-log + dead-letter substrate every
 * G3 automation rule runs through. Mirrors the exactly-once outbox-consumer pattern already in
 * this codebase (ConsumptionService's `inventory.material_issue_applied` single-applier claim;
 * EmailNotifierService's `attempts >= 3` dead-letter convention) generalised into one reusable
 * helper so every rule gets the same guarantee instead of re-implementing it five times.
 *
 * Contract of `runIdempotent`:
 *   - (ruleCode, dedupeKey) is claimed EXACTLY ONCE via an atomic
 *     `INSERT ... ON CONFLICT DO NOTHING RETURNING` — the same primitive
 *     inventory.material_issue_applied already uses, so two concurrent callers (a retried
 *     drain tick, a duplicate/out-of-order event, two worker replicas) race the SAME row and
 *     only one wins the claim.
 *   - The loser (claim returned 0 rows) re-reads the row: DONE or dead-lettered → skip
 *     (duplicate delivery produces NO second effect); PENDING → someone else has it in flight
 *     right now → skip; FAILED with attempts left → atomically re-claims the retry.
 *   - `work(tx)` runs the domain effect AND the decision-log insert in ONE transaction, so a
 *     decision log row exists iff the effect committed. A thrown error rolls the domain
 *     effect back (retry-safe — nothing partial to undo) and increments `attempts`; at
 *     MAX_ATTEMPTS the key is dead-lettered and never retried again.
 */
import type { Sql, TransactionSql } from 'postgres';
import { MAX_ATTEMPTS, SYSTEM_ACTOR } from './automation.constants.js';

export type Decision = 'FIRED' | 'SKIPPED' | 'NOOP';

export interface RuleOutcome {
  decision: Decision;
  reason: string;
  outputs?: Record<string, unknown>;
}

export interface RunIdempotentParams {
  sql: Sql;
  ruleCode: string;
  dedupeKey: string;
  eventType: string;
  aggregateId?: string | null;
  inputs?: Record<string, unknown>;
  work: (tx: TransactionSql) => Promise<RuleOutcome>;
}

interface AppliedRow {
  status: string;
  attempts: number;
}

/** Re-export for callers that want the actor string without a second import. */
export { SYSTEM_ACTOR };

/**
 * Runs `work` for one (ruleCode, dedupeKey) at most once successfully, ever. Returns the
 * outcome when this call actually ran the rule, or `null` when it was skipped (already done,
 * already dead-lettered, currently in flight elsewhere, or it failed this attempt).
 */
export async function runIdempotent(params: RunIdempotentParams): Promise<RuleOutcome | null> {
  const { sql, ruleCode, dedupeKey, eventType, aggregateId, inputs, work } = params;

  const claimed = (await sql`
    insert into automation.applied (rule_code, dedupe_key, status, attempts, updated_dt)
    values (${ruleCode}, ${dedupeKey}, 'PENDING', 0, now())
    on conflict (rule_code, dedupe_key) do nothing
    returning rule_code
  `) as unknown as Array<{ rule_code: string }>;

  if (claimed.length === 0) {
    const existing = (await sql`
      select status, attempts from automation.applied
       where rule_code = ${ruleCode} and dedupe_key = ${dedupeKey}
    `) as unknown as AppliedRow[];
    const prior = existing[0];
    if (!prior) return null; // raced away between the failed insert and this read — next tick picks it up
    if (prior.status === 'DONE') return null; // exactly-once: duplicate delivery, no second effect
    if (prior.status === 'FAILED' && prior.attempts >= MAX_ATTEMPTS) return null; // dead-lettered
    if (prior.status === 'PENDING') return null; // in flight elsewhere right now

    // status === 'FAILED', attempts < MAX_ATTEMPTS: retry-safe re-claim (only the retry path
    // reaches here). Loses gracefully if another caller re-claims first.
    const reclaimed = (await sql`
      update automation.applied set status = 'PENDING', updated_dt = now()
       where rule_code = ${ruleCode} and dedupe_key = ${dedupeKey} and status = 'FAILED'
       returning rule_code
    `) as unknown as Array<{ rule_code: string }>;
    if (reclaimed.length === 0) return null;
  }

  try {
    let outcome: RuleOutcome | undefined;
    await sql.begin(async (tx) => {
      outcome = await work(tx);
      await tx`
        insert into automation.decision_log
          (rule_code, dedupe_key, event_type, aggregate_id, decision, reason, inputs, outputs)
        values (${ruleCode}, ${dedupeKey}, ${eventType}, ${aggregateId ?? null},
                ${outcome.decision}, ${outcome.reason},
                ${JSON.stringify(inputs ?? {})}::jsonb, ${JSON.stringify(outcome.outputs ?? {})}::jsonb)
      `;
      await tx`
        update automation.applied
           set status = 'DONE', attempts = attempts + 1, last_error = null, updated_dt = now()
         where rule_code = ${ruleCode} and dedupe_key = ${dedupeKey}
      `;
    });
    return outcome ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const bumped = (await sql`
      update automation.applied
         set status = 'FAILED', attempts = attempts + 1, last_error = ${message}, updated_dt = now()
       where rule_code = ${ruleCode} and dedupe_key = ${dedupeKey}
       returning attempts
    `) as unknown as Array<{ attempts: number }>;
    const attempts = bumped[0]?.attempts ?? MAX_ATTEMPTS;
    if (attempts >= MAX_ATTEMPTS) {
      await sql`
        insert into automation.dead_letter
          (rule_code, dedupe_key, event_type, payload, error, attempts, last_failed_dt)
        values (${ruleCode}, ${dedupeKey}, ${eventType}, ${JSON.stringify(inputs ?? {})}::jsonb,
                ${message}, ${attempts}, now())
        on conflict (rule_code, dedupe_key) do update
          set attempts = excluded.attempts, error = excluded.error, last_failed_dt = now()
      `;
    }
    return null; // swallowed by design — the caller's drain loop must move on to the next candidate
  }
}
