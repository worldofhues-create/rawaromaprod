/**
 * emitBridgeOutbound — lane F6 (RP-EMIT): the shared emission point every cluster's
 * production/packaging/dispatch flow calls, INSIDE its own transaction, right beside the
 * domain state change it accompanies. Mirrors `recordOutbox` in shape and intent (see
 * outbox.recorder.ts) but targets the `bridge` schema's outbox specifically, toward
 * ALEMBIC, per docs/bridge/EVENT_CONTRACT.md and backend/api/src/bridge/contract.ts.
 *
 * Every RawProd cluster already depends on `@core/backend-kernel` (recordOutbox lives
 * here too), so putting this here — rather than in a new shared package, or adding
 * `@ra/data-bridge` as a dependency of cluster-production/packaging/quality/sales — adds
 * no new workspace dependency anywhere (C3). It stays a plain, schema-typeless function
 * (raw cross-schema SQL, the same idiom `batch.service.ts`/`orders.service.ts`/
 * `dispatch.service.ts` already use for `production.*`/`packaging.*` reads from other
 * clusters' transactions) rather than importing `@ra/data-bridge`'s Drizzle table objects,
 * for the same reason — this file otherwise stays domain-free.
 *
 * Contract:
 *   - Looks up `bridge.production_requirement` by `production_order_id` (the reverse of
 *     the FK bridge's importer sets when RawProd schedules against an accepted
 *     requirement — see planning.service.ts's createOrder). If nothing links back to a
 *     requirement, emits NOTHING: the order is ordinary RawProd-internal production, not
 *     bridge-originated, and that's the common case, not an error.
 *   - When a requirement IS linked, atomically increments `last_emitted_version` on that
 *     requirement row (UPDATE ... RETURNING) and stamps the new value onto the outbox
 *     row's payload as `_bridge_version` — the exact counter `relay.service.ts` reads to
 *     set the outgoing envelope's `version`. Because the increment and the outbox insert
 *     run in the SAME statement-ordered transaction as the caller's own domain write, a
 *     rollback of the state change rolls back both, and two concurrent callers racing the
 *     same requirement serialize on the row (ordinary MVCC row-level locking from the
 *     UPDATE), so versions never collide or go out of order.
 */
import { sql } from 'drizzle-orm';

/** The minimal read/write surface this needs: any Drizzle db or transaction handle. */
export interface BridgeEmitTx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(query: any): Promise<unknown>;
}

interface LinkedRequirementRow {
  alembic_requirement_id: string;
  correlation_id: string;
}

interface EmittedVersionRow {
  last_emitted_version: string | number;
}

/**
 * Emits `type` toward ALEMBIC for whatever `bridge.production_requirement` row is linked
 * to `productionOrderId` (its `production_order_id` column), inside the caller's own
 * transaction. No-ops when `productionOrderId` is null/undefined, or when no requirement
 * is linked to it.
 *
 * @param tx the caller's active transaction (or db handle) — same connection as the
 *   domain write this call sits beside.
 * @param type one of contract.ts's `OutboundToAlembic` values.
 * @param productionOrderId the production order this state change happened against —
 *   resolved by the caller (directly, or via a join through oil_batch/package_order for
 *   the packaging/dispatch clusters, which don't hold it themselves).
 * @param extraPayload additional domain fields for ALEMBIC's side; `correlation_id` and
 *   `_bridge_version` are added automatically and override anything passed here.
 */
export async function emitBridgeOutbound(
  tx: BridgeEmitTx,
  type: string,
  productionOrderId: string | null | undefined,
  extraPayload: Record<string, unknown> = {},
): Promise<void> {
  if (!productionOrderId) return; // not bridge-originated — nothing to emit

  const linked = (await tx.execute(sql`
    select alembic_requirement_id, correlation_id
      from bridge.production_requirement
     where production_order_id = ${productionOrderId}
     limit 1
  `)) as unknown as LinkedRequirementRow[];
  const requirement = linked[0];
  if (!requirement) return; // no requirement fulfilled by this order — nothing to emit

  const versioned = (await tx.execute(sql`
    update bridge.production_requirement
       set last_emitted_version = last_emitted_version + 1
     where alembic_requirement_id = ${requirement.alembic_requirement_id}
     returning last_emitted_version
  `)) as unknown as EmittedVersionRow[];
  const version = versioned[0] ? Number(versioned[0].last_emitted_version) : 1;

  const payload = JSON.stringify({
    ...extraPayload,
    correlation_id: requirement.correlation_id,
    _bridge_version: version,
  });

  await tx.execute(sql`
    insert into bridge.outbox (type, aggregate_id, payload)
    values (${type}, ${requirement.alembic_requirement_id}, ${payload}::jsonb)
  `);
}
