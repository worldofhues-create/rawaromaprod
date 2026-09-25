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
  // Golden-journey gap 3: ALEMBIC's goods receipt of the factory FG IS the physical
  // hand-over for a bridge requirement (no RawProd sales order / Dispatched exists for it).
  // Payload: { requirement_id, order_ref, received_qty, uom, receipt_ref, received_at }.
  'ProductionRequirementFulfilled',
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
  // Emitted exactly once when ProductionRequirementFulfilled is applied (requirement COMPLETE).
  'ProductionRequirementCompleted',
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

/* ── Payload contract per inbound type (OPS_GREEN §17, P1 poison event) ─────
 *
 * `validateEnvelope` checks the envelope and nothing inside `payload`, so a
 * Created event with no `needed_by` passed validation and the importer threw on
 * `new Date(String(undefined))` -> an Invalid Date -> a Postgres error -> 500.
 * ALEMBIC read the 500 as transient and re-sent the same poison bytes for ever.
 *
 * Every field the importer reads is checked here first, against the payload
 * shapes in docs/bridge/EVENT_CONTRACT.md, and a miss is a PERMANENT refusal
 * (400, `BRIDGE_PERMANENT_INVALID_PAYLOAD`): re-sending the same event can never
 * make it valid. Pure, so the rule is testable without a database. Unknown
 * EXTRA fields are tolerated (forward compatibility), missing or malformed
 * required ones are not. */
export type PayloadProblem = `${string}:${'missing' | 'invalid'}`;

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const isNonEmptyString = (v: unknown, max = 200): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isPositiveQty = (v: unknown): boolean => {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0;
  return typeof v === 'string' && /^[0-9]+(\.[0-9]+)?$/.test(v.trim()) && Number(v) > 0;
};
/** An ISO-8601 instant Postgres will also accept: a date, optionally a time and zone. */
const isIsoInstant = (v: unknown): boolean =>
  typeof v === 'string'
  && /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)
  && !Number.isNaN(Date.parse(v));

export function validateInboundPayload(type: string, payload: Record<string, unknown>): readonly PayloadProblem[] {
  const problems: PayloadProblem[] = [];
  const need = (field: string, ok: (v: unknown) => boolean) => {
    const v = payload[field];
    if (v === undefined || v === null || v === '') problems.push(`${field}:missing`);
    else if (!ok(v)) problems.push(`${field}:invalid`);
  };
  const optional = (field: string, ok: (v: unknown) => boolean) => {
    const v = payload[field];
    if (v !== undefined && v !== null && !ok(v)) problems.push(`${field}:invalid`);
  };
  const packSize = (v: unknown) => (typeof v === 'string' && v.length <= 50) || (typeof v === 'number' && Number.isFinite(v));
  const priority = (v: unknown) => typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v);

  switch (type) {
    case 'ProductionRequirementCreated':
      need('order_ref', (v) => isNonEmptyString(v, 100));
      need('mapped_sku', (v) => isNonEmptyString(v));
      need('qty', isPositiveQty);
      need('uom', (v) => isNonEmptyString(v, 20));
      need('needed_by', isIsoInstant);
      optional('pack_size', packSize);
      optional('priority', priority);
      break;
    case 'ProductionRequirementChanged':
      optional('mapped_sku', (v) => isNonEmptyString(v));
      optional('qty', isPositiveQty);
      optional('uom', (v) => isNonEmptyString(v, 20));
      optional('needed_by', isIsoInstant);
      optional('pack_size', packSize);
      optional('priority', priority);
      break;
    case 'ProductionRequirementCancelled':
      optional('reason', (v) => typeof v === 'string' && v.length <= 1000);
      break;
    case 'ProductionRequirementFulfilled':
      need('received_qty', isPositiveQty);
      need('uom', (v) => isNonEmptyString(v, 20));
      optional('receipt_ref', (v) => typeof v === 'string' && v.length <= 200);
      optional('order_ref', (v) => typeof v === 'string' && v.length <= 100);
      optional('received_at', isIsoInstant);
      break;
    default:
      // validateEnvelope has already refused a type outside INBOUND_FROM_ALEMBIC.
      break;
  }
  return problems;
}

/* The machine-readable refusal vocabulary both sides of the bridge share
 * (docs/bridge/EVENT_CONTRACT.md, "DLQ / reconciliation"). `permanent: true`
 * tells the sender to park the event after this attempt; `permanent: false`
 * tells it to retry on backoff. */
export const BRIDGE_CODES = {
  badJson: 'BRIDGE_PERMANENT_BAD_JSON',
  invalidEnvelope: 'BRIDGE_PERMANENT_INVALID_ENVELOPE',
  unknownType: 'BRIDGE_PERMANENT_UNKNOWN_TYPE',
  invalidPayload: 'BRIDGE_PERMANENT_INVALID_PAYLOAD',
  unappliable: 'BRIDGE_PERMANENT_UNAPPLIABLE',
  transient: 'BRIDGE_TRANSIENT',
  signatureInvalid: 'BRIDGE_SIGNATURE_INVALID',
} as const;

/** SQLSTATE classes that mean "these VALUES are wrong" rather than "try again":
 *  22 data exception (bad date, numeric overflow, string too long), 23 integrity
 *  constraint violation. A serialization failure (40001), deadlock (40P01), a
 *  connection fault (08), or anything unrecognised is transient. */
export function isPermanentDbError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && (code.startsWith('22') || code.startsWith('23'));
}

/* ── Outbound delivery policy (RawProd -> ALEMBIC), the mirror of ALEMBIC's ──
 * @alembic/domain delivery-policy.ts: the same classification and the same
 * bound, so "parked" means the same thing on both sides of the channel. */
export const BRIDGE_MAX_DELIVERY_ATTEMPTS = 12;
export const BRIDGE_BACKOFF_CAP_SECONDS = 30 * 60;
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([400, 404, 410, 413, 415, 422]);

export interface DeliveryFailure { readonly status?: number; readonly body?: unknown }
export interface FailureDecision {
  readonly failureClass: 'permanent' | 'transient';
  readonly park: 'permanent' | 'max_attempts' | null;
  readonly retryInSeconds: number | null;
}

const field = (body: unknown, key: string): unknown =>
  typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key] : undefined;

export function classifyDeliveryFailure(f: DeliveryFailure): 'permanent' | 'transient' {
  const said = field(f.body, 'permanent');
  if (said === true) return 'permanent';
  if (said === false) return 'transient';
  if (f.status === undefined) return 'transient';
  return PERMANENT_STATUSES.has(f.status) ? 'permanent' : 'transient';
}

export function decideFailedDelivery(
  f: DeliveryFailure, attemptsBefore: number, maxAttempts = BRIDGE_MAX_DELIVERY_ATTEMPTS,
): FailureDecision {
  const failureClass = classifyDeliveryFailure(f);
  const attempts = attemptsBefore + 1;
  if (failureClass === 'permanent') return { failureClass, park: 'permanent', retryInSeconds: null };
  if (attempts >= maxAttempts) return { failureClass, park: 'max_attempts', retryInSeconds: null };
  return { failureClass, park: null, retryInSeconds: Math.min(2 ** attempts, BRIDGE_BACKOFF_CAP_SECONDS) };
}

export function describeFailure(f: DeliveryFailure, networkMessage?: string): string {
  if (f.status === undefined) return `network: ${(networkMessage ?? 'unknown_error').slice(0, 200)}`;
  const code = field(f.body, 'code');
  const outcome = field(f.body, 'outcome');
  const tag = typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code
    : typeof outcome === 'string' && /^[a-z0-9_]{1,64}$/.test(outcome) ? outcome : null;
  return tag ? `http_${f.status}: ${tag}` : `http_${f.status}`;
}

/** Local lifecycle vocabulary RawProd tracks for a requirement it has accepted. A subset
 *  of ALEMBIC's — RawProd applies Created/Changed/Cancelled from ALEMBIC and its own
 *  internal production flow advances the rest (PLANNED..COMPLETE), which is out of this
 *  bridge slice's scope (see the lane report). */
export const LOCAL_STATUSES = [
  'CREATED', 'ACCEPTED', 'REJECTED_MAPPING', 'CANCELLED',
  // Terminal: ALEMBIC confirmed goods receipt (ProductionRequirementFulfilled applied).
  'COMPLETE',
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

  // COMPLETE is terminal: nothing after the fulfilment applies, and nothing re-emits.
  if (input.currentStatus === 'COMPLETE') {
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
