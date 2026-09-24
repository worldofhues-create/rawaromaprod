/**
 * The bridge contract, RawProd's side — pure functions, no I/O, no NestJS. Mirrors
 * ALEMBIC's `packages/domain/src/bridge/` module in shape (same envelope, same
 * idempotency/ordering rule from docs/bridge/EVENT_CONTRACT.md) so "duplicate", "out of
 * order" and "replay" mean the exact same thing on both sides of the channel — a
 * defect here is exactly the kind of thing the two-process contract test in
 * `bridge.contract.spec.ts` exists to catch before either service is running.
 */

export const INBOUND_FROM_ALEMBIC = [
  'ProductionRequirementCreated',
  'ProductionRequirementChanged',
  'ProductionRequirementCancelled',
] as const;
export type InboundFromAlembic = (typeof INBOUND_FROM_ALEMBIC)[number];

export const OUTBOUND_TO_ALEMBIC = [
  'ProductionRequirementAccepted',
  'ProductionRequirementRejectedMapping',
  'ProductionScheduled',
  'ProductionStarted',
  'QcStatusChanged',
  'PackagingStarted',
  'FgBatchAvailable',
  'AtpAllocationGranted',
  'DispatchReady',
  'Dispatched',
  'ProductionRequirementCancelledAck',
  // G1/PB-08 — break-glass sales-order continuity actions (OrdersService), emitted via
  // emitBridgeManualEvent (not tied to a production_requirement) so ALEMBIC can reconcile a
  // manually-created/confirmed/amended RawProd sales order against its own commercial order.
  'SalesOrderManualContinuityCreated',
  'SalesOrderManualContinuityConfirmed',
  'SalesOrderManualContinuityItemAdded',
] as const;
export type OutboundToAlembic = (typeof OUTBOUND_TO_ALEMBIC)[number];

export interface BridgeEnvelope {
  readonly eventId: string;
  readonly version: number;
  readonly type: string;
  readonly orgId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly occurredAt: string;
  readonly source: 'alembic' | 'rawprod';
  readonly aggregate: { readonly type: string; readonly id: string };
  readonly payload: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EnvelopeProblem =
  | 'bad_event_id' | 'bad_version' | 'unknown_type' | 'bad_org_id'
  | 'bad_correlation_id' | 'bad_causation_id' | 'bad_occurred_at'
  | 'bad_source' | 'bad_aggregate' | 'bad_payload';

export type EnvelopeResult =
  | { readonly ok: true; readonly envelope: BridgeEnvelope }
  | { readonly ok: false; readonly problems: readonly EnvelopeProblem[] };

export function validateEnvelope(raw: unknown, allowedTypes: readonly string[]): EnvelopeResult {
  const problems: EnvelopeProblem[] = [];
  if (typeof raw !== 'object' || raw === null) return { ok: false, problems: ['bad_payload'] };
  const r = raw as Record<string, unknown>;

  if (typeof r.event_id !== 'string' || !UUID_RE.test(r.event_id)) problems.push('bad_event_id');
  if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) problems.push('bad_version');
  if (typeof r.type !== 'string' || !allowedTypes.includes(r.type)) problems.push('unknown_type');
  if (typeof r.org_id !== 'string' || !UUID_RE.test(r.org_id)) problems.push('bad_org_id');
  if (typeof r.correlation_id !== 'string' || !UUID_RE.test(r.correlation_id)) problems.push('bad_correlation_id');
  if (r.causation_id !== null && r.causation_id !== undefined) {
    if (typeof r.causation_id !== 'string' || !UUID_RE.test(r.causation_id)) problems.push('bad_causation_id');
  }
  if (typeof r.occurred_at !== 'string' || Number.isNaN(Date.parse(r.occurred_at))) problems.push('bad_occurred_at');
  if (r.source !== 'alembic' && r.source !== 'rawprod') problems.push('bad_source');
  const agg = r.aggregate as Record<string, unknown> | undefined;
  if (typeof agg !== 'object' || agg === null || typeof agg.type !== 'string'
    || typeof agg.id !== 'string' || !UUID_RE.test(agg.id)) {
    problems.push('bad_aggregate');
  }
  if (typeof r.payload !== 'object' || r.payload === null || Array.isArray(r.payload)) problems.push('bad_payload');

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    envelope: {
      eventId: r.event_id as string, version: r.version as number, type: r.type as string,
      orgId: r.org_id as string, correlationId: r.correlation_id as string,
      causationId: (r.causation_id as string | null | undefined) ?? null,
      occurredAt: r.occurred_at as string, source: r.source as 'alembic' | 'rawprod',
      aggregate: agg as { type: string; id: string },
      payload: r.payload as Record<string, unknown>,
    },
  };
}

/** Local lifecycle vocabulary RawProd tracks for a requirement it has accepted. A subset
 *  of ALEMBIC's — RawProd applies Created/Changed/Cancelled from ALEMBIC and its own
 *  internal production flow advances the rest (PLANNED..COMPLETE), which is out of this
 *  bridge slice's scope (see the lane report). */
export const LOCAL_STATUSES = [
  'CREATED', 'ACCEPTED', 'REJECTED_MAPPING', 'CANCELLED',
] as const;
export type LocalStatus = (typeof LOCAL_STATUSES)[number];

export interface InboundDecisionInput {
  readonly alreadyRecorded: boolean;
  readonly incomingVersion: number;
  readonly lastAppliedVersion: number;
  readonly currentStatus: LocalStatus | null;
  readonly eventType: string;
}

export type InboundDecision =
  | { readonly action: 'duplicate' }
  | { readonly action: 'unknown_aggregate' }
  | { readonly action: 'park'; readonly parkedReason: 'out_of_order' }
  | { readonly action: 'apply' };

export function decideInbound(input: InboundDecisionInput): InboundDecision {
  if (input.alreadyRecorded) return { action: 'duplicate' };

  // ProductionRequirementCreated is the one event type allowed to arrive with no known
  // aggregate — it is what CREATES the aggregate. Everything else needs one to already
  // exist.
  if (input.currentStatus === null) {
    if (input.eventType === 'ProductionRequirementCreated' && input.incomingVersion === 1) {
      return { action: 'apply' };
    }
    return { action: 'unknown_aggregate' };
  }

  if (input.currentStatus === 'CANCELLED' && input.eventType !== 'ProductionRequirementCancelled') {
    return { action: 'park', parkedReason: 'out_of_order' };
  }

  if (input.incomingVersion !== input.lastAppliedVersion + 1) {
    return { action: 'park', parkedReason: 'out_of_order' };
  }

  return { action: 'apply' };
}

/** SKU existence check result — §24's mirror on RawProd's side: RawProd, not ALEMBIC,
 *  is the authority on whether `mapped_sku` names a real factory SKU. Pure function over
 *  a caller-supplied existence flag so the decision is testable without a database. */
export function decideAcceptance(skuExists: boolean): OutboundToAlembic {
  return skuExists ? 'ProductionRequirementAccepted' : 'ProductionRequirementRejectedMapping';
}
