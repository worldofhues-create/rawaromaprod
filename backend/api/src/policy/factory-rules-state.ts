/**
 * PROM-6 (LD-85, ALEMBIC docs/plan/program/process-promises.md section 4): `factory.rules.state`, how
 * ALEMBIC learns that this factory ENFORCES a promise, not only that a rule has a value.
 *
 * One reading of every factory rule (backend-kernel `factoryRulesStateWire`: the cautious value across
 * everything the latest version can produce, with the code's enforcement version), written to
 * bridge.outbox in the caller's transaction:
 *
 *   - on every publish of a factory rule, inside the publish (PolicyService.publish), so the state and
 *     the version it describes commit together or not at all;
 *   - once a day, and once when the API starts (FactoryRulesStateService), so ALEMBIC's 48-hour window
 *     never lapses while nothing changes, and a deploy that changed the enforcing code is reported at
 *     once.
 *
 * Checked against ALEMBIC's own parse rules before it is written, and for formula content (D-1): the
 * payload carries rule values and version numbers only, never a person, material or formula.
 */
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { PG_CLIENT, FACTORY_RULE_KEYS, factoryRulesStateWire, type FactoryRuleKey, type PolicyVersionRow } from '@core/backend-kernel';
import { bridge as bridgeContracts } from '@core/contracts';

type Db = Sql | TransactionSql;

/** Reads each factory rule's latest published version and writes one `factory.rules.state` to the outbox. */
export async function emitFactoryRulesState(db: Db, reason: bridgeContracts.FactoryRulesStateReason): Promise<bridgeContracts.FactoryRulesStateWire> {
  const keys = [...FACTORY_RULE_KEYS] as string[];
  const rows = (await db`
    select distinct on (policy_key) policy_key, version, body::text as body
      from platform.policy_version
     where policy_key in ${db(keys)} and created_dt <= now()
     order by policy_key, version desc`) as unknown as Array<{ policy_key: FactoryRuleKey; version: number; body: string }>;
  const latest: Partial<Record<FactoryRuleKey, PolicyVersionRow>> = {};
  for (const r of rows) latest[r.policy_key] = { version: Number(r.version), body: r.body };
  const wire = factoryRulesStateWire(latest, new Date().toISOString(), reason);
  const problems = bridgeContracts.checkFactoryRulesStateWire(wire);
  if (problems.length) throw new Error(`factory.rules.state would be refused by ALEMBIC: ${problems.join(', ')}`);
  bridgeContracts.assertNoFormulaContent(wire);
  await db`insert into bridge.outbox (type, aggregate_id, payload)
           values (${bridgeContracts.FACTORY_RULES_STATE}, ${randomUUID()}::uuid, ${JSON.stringify(wire)}::jsonb)`;
  return wire;
}

/** How often the daily sender looks, and how old the last state may be before it sends another. */
export const RULES_STATE_CHECK_MS = 60 * 60 * 1000;
export const RULES_STATE_EVERY_MS = 23 * 60 * 60 * 1000;

/**
 * Sends `factory.rules.state` when the API starts and whenever the last one in the outbox is older than
 * 23 hours (checked hourly), so ALEMBIC's view is never more than a day old. Two API processes may both
 * send one; that is harmless (each is a whole state, the latest wins) and is not worth a lock.
 */
@Injectable()
export class FactoryRulesStateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FactoryRulesStateService.name);
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;

  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  onModuleInit(): void {
    this.first = setTimeout(() => void this.tick('startup'), 15_000);
    this.first.unref?.();
    this.timer = setInterval(() => void this.tick('daily'), RULES_STATE_CHECK_MS);
    this.timer.unref?.();
  }
  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** Sends one state when `reason` is startup, or when none was written in the last 23 hours. */
  async tick(reason: 'startup' | 'daily'): Promise<boolean> {
    try {
      return await this.sql.begin(async (tx) => {
        if (reason === 'daily') {
          const [r] = (await tx`
            select 1 as recent from bridge.outbox
             where type = ${bridgeContracts.FACTORY_RULES_STATE}
               and occurred_at > now() - make_interval(secs => ${RULES_STATE_EVERY_MS / 1000})
             limit 1`) as unknown as Array<{ recent: number }>;
          if (r) return false;
        }
        await emitFactoryRulesState(tx, reason);
        return true;
      });
    } catch (err) {
      this.logger.warn(`factory.rules.state was not sent: ${(err as Error).message}`);
      return false;
    }
  }
}
