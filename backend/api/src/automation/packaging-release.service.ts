/**
 * PackagingReleaseService — G3 rule: "packaging QC PASS → FG batch released, FG stock
 * availability updated, availability event emitted on the bridge to ALEMBIC" (directive §18
 * "FG": `packaging QC pass → FG release → ATP → emit availability`).
 *
 * Consumes `packaging.qc.recorded` (PackagingQcService.create — backend/api/src/
 * packaging-qc/packaging-qc.service.ts, added alongside this rule since that table
 * previously emitted no event at all) from `packaging.outbox`. Dedupe key = packagingQcId.
 *
 * PASS: flips `packaging.finished_good_batch_master.status` to RELEASED (guarded — a batch
 * already released is left alone) and emits `FgBatchAvailable` onto `bridge.outbox`, inline
 * with `emitBridgeOutbound`'s own contract (backend/backend-kernel/src/events/bridge-emit.ts):
 * resolves the production order two hops back (package_order → oil_batch →
 * production_order), looks up the linked `bridge.production_requirement`, and no-ops if this
 * batch isn't bridge-originated — exactly the same no-op-when-unlinked behaviour
 * `emitBridgeOutbound` has (kept as an inline equivalent here rather than a direct import,
 * because that helper's `BridgeEmitTx` type expects a Drizzle `.execute()` handle and this
 * module only holds a plain `postgres.js` `Sql`/transaction).
 *
 * FG stock availability is a DERIVED value (FgStockService — backend/api/src/fg-stock)
 * computed live from produced/dispatched/consumed/reserved + the latest packaging_qc result;
 * flipping the batch to RELEASED is the one state change availability needed here — no
 * separate "recompute ATP" step exists to run.
 *
 * FAIL: no inventory action (packaging_qc's FAIL already zeroes ATP for that batch via
 * FgStockService's live join — directive's "QC affects availability" is already true by
 * construction); still claimed + decision-logged as NOOP so the event is never re-offered.
 *
 * Write set: `packaging.finished_good_batch_master` (status), `bridge.outbox` (insert),
 * `bridge.production_requirement` (version counter bump only, same as `emitBridgeOutbound`).
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql, TransactionSql } from 'postgres';
import { AUTOMATION_POLL_MS, RULE, SYSTEM_ACTOR } from './automation.constants.js';
import { runIdempotent } from './ledger.js';

const EVENT_TYPE = 'packaging.qc.recorded';

@Injectable()
export class PackagingReleaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PackagingReleaseService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.drain(), AUTOMATION_POLL_MS);
    if (this.timer.unref) this.timer.unref();
    this.logger.log(`G3 packaging-release: polling ${EVENT_TYPE} every ${AUTOMATION_POLL_MS}ms`);
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = (await this.sql`
        select o.aggregate_id::text as packaging_qc_id, o.payload
          from packaging.outbox o
         where o.type = ${EVENT_TYPE}
           and o.aggregate_id is not null
           and not exists (
             select 1 from automation.applied a
              where a.rule_code = ${RULE.PACKAGING_QC_RELEASE} and a.dedupe_key = o.aggregate_id::text
                and a.status = 'DONE'
           )
         order by o.occurred_at asc
         limit 50
      `) as unknown as Array<{ packaging_qc_id: string; payload: unknown }>;
      for (const r of rows) await this.applyOne(r.packaging_qc_id, r.payload);
    } catch (err) {
      this.logger.warn(`packaging-release drain failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async applyOne(packagingQcId: string, rawPayload: unknown): Promise<void> {
    const payload = (typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload) as {
      finishedGoodBatchId?: string;
      overallResult?: string;
    };
    const finishedGoodBatchId = payload?.finishedGoodBatchId;
    const overallResult = String(payload?.overallResult ?? '').toUpperCase();
    if (!finishedGoodBatchId) return; // malformed — no key to act on

    await runIdempotent({
      sql: this.sql,
      ruleCode: RULE.PACKAGING_QC_RELEASE,
      dedupeKey: packagingQcId,
      eventType: EVENT_TYPE,
      aggregateId: packagingQcId,
      inputs: { packagingQcId, finishedGoodBatchId, overallResult },
      work: async (tx) => {
        if (overallResult !== 'PASS') {
          return {
            decision: 'NOOP' as const,
            reason: `packaging QC result is ${overallResult || 'unset'} — FG availability already reflects this via the live ATP query; no release action`,
          };
        }

        const updated = (await tx`
          update packaging.finished_good_batch_master
             set status = 'RELEASED', updated_by = ${SYSTEM_ACTOR}
           where finished_good_batch_id = ${finishedGoodBatchId} and coalesce(status, 'ACTIVE') <> 'RELEASED'
           returning finished_good_batch_id, package_order_id
        `) as unknown as Array<{ finished_good_batch_id: string; package_order_id: string | null }>;

        if (updated.length === 0) {
          return { decision: 'SKIPPED' as const, reason: 'FG batch already RELEASED' };
        }

        const bridgeEmitted = await this.emitAvailability(tx, updated[0]!.package_order_id, finishedGoodBatchId, packagingQcId);

        return {
          decision: 'FIRED' as const,
          reason: 'packaging QC PASS: FG batch released to availability',
          outputs: { finishedGoodBatchId, bridgeEmitted },
        };
      },
    });
  }

  /** Inline equivalent of `emitBridgeOutbound` (backend/backend-kernel/src/events/bridge-emit.ts)
   * for a plain postgres.js transaction: resolves package_order → oil_batch →
   * production_order, then the linked bridge.production_requirement (if any), bumps its
   * emitted-version counter, and inserts the FgBatchAvailable row. No-ops (returns false) when
   * the batch isn't bridge-originated — same contract as the helper it mirrors. */
  private async emitAvailability(
    tx: TransactionSql,
    packageOrderId: string | null,
    finishedGoodBatchId: string,
    packagingQcId: string,
  ): Promise<boolean> {
    if (!packageOrderId) return false;
    const order = (await tx`
      select ob.production_order_id
        from packaging.package_order po
        join production.oil_batch_master ob on ob.oil_batch_id = po.oil_batch_id
       where po.package_order_id = ${packageOrderId}
       limit 1
    `) as unknown as Array<{ production_order_id: string | null }>;
    const productionOrderId = order[0]?.production_order_id;
    if (!productionOrderId) return false;

    const linked = (await tx`
      select alembic_requirement_id, correlation_id
        from bridge.production_requirement
       where production_order_id = ${productionOrderId}
       limit 1
    `) as unknown as Array<{ alembic_requirement_id: string; correlation_id: string }>;
    const requirement = linked[0];
    if (!requirement) return false;

    const versioned = (await tx`
      update bridge.production_requirement
         set last_emitted_version = last_emitted_version + 1
       where alembic_requirement_id = ${requirement.alembic_requirement_id}
       returning last_emitted_version
    `) as unknown as Array<{ last_emitted_version: string | number }>;
    const version = versioned[0] ? Number(versioned[0].last_emitted_version) : 1;

    await tx`
      insert into bridge.outbox (type, aggregate_id, payload)
      values ('FgBatchAvailable', ${requirement.alembic_requirement_id},
        ${JSON.stringify({
          finished_good_batch_id: finishedGoodBatchId,
          packaging_qc_id: packagingQcId,
          released: true,
          correlation_id: requirement.correlation_id,
          _bridge_version: version,
        })}::jsonb)
    `;
    return true;
  }
}
