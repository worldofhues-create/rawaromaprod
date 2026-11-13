/**
 * PROM-2 / PROM-3 (LD-85, ALEMBIC docs/plan/program/process-promises.md): the factory rules a
 * storefront promise rests on, read INSIDE the caller's transaction by the gates that enforce them.
 *
 *   maceration.rest         { minDays, maxDays, appliesTo, earlyRelease }   "Every batch rests 45 days
 *                           between QC 1 and QC 2". Default 45 (owner, LD-85; the storefront's MAC_D).
 *                           maxDays null = no over-maximum alarm ("No maximum set"): no number is
 *                           invented (OQ-PROM-4).
 *   qc.reference_required   { required }   "checked against a retained reference before it ships".
 *   fill.lot_server_assigned { required }  "Every pack carries a lot number tied to its batch record" (PROM-4).
 *                           The lot is minted by the server at fill and never typed. Only `true` is a
 *                           valid value: printing a lot no record holds is a Block (system-led 3.4), so
 *                           the rule is data the Rules screen shows and PROM-6 reports, not a switch.
 *
 * Both are ordinary policies (platform.policy / policy_version, the Rules screen), evaluated with the
 * one rules engine (policy-engine.ts). What is different is the failure direction:
 *
 *   - No version in force at all (a database the release has not reached, a fresh branch): the
 *     registry default below applies, so a branch is never without the rule (plan, PROM-2).
 *   - A version that has no rule for this case and no default: HOLD (409). Never a guess.
 *   - A value of the wrong shape: HOLD (409), and `factoryRuleProblems` refuses it at publish.
 *   - No single-record override: a shorter rest for one batch is an early release (a second person),
 *     a longer one is an extension; the policy service refuses a record override on these keys.
 *
 * `FACTORY_ENFORCEMENT_VERSION` is bumped by the commit that changes the CODE enforcing a rule. The
 * rule's value alone does not prove the code that enforces it is deployed (PROM-6 sends both).
 */
import { ConflictException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { BridgeEmitTx } from './bridge-emit.js';
import { evaluateRules, type PolicyBody } from './policy-engine.js';

export const MACERATION_REST = 'maceration.rest' as const;
export const QC_REFERENCE_REQUIRED = 'qc.reference_required' as const;
export const FILL_LOT_SERVER_ASSIGNED = 'fill.lot_server_assigned' as const;
/** PROM-5: whether a supplier change for one raw-material identity is a "raw material change" the
 *  customer is told about (OQ-PROM-5 default: yes). Read by continuity.ts. */
export const CONTINUITY_SUPPLIER_CHANGE = 'continuity.supplier_change_is_material' as const;
export const FACTORY_RULE_KEYS = [MACERATION_REST, QC_REFERENCE_REQUIRED, FILL_LOT_SERVER_ASSIGNED, CONTINUITY_SUPPLIER_CHANGE] as const;
export type FactoryRuleKey = (typeof FACTORY_RULE_KEYS)[number];

export interface RestRule {
  minDays: number;
  maxDays: number | null;
  appliesTo: 'every_batch';
  earlyRelease: 'second_person';
}
export interface ReferenceRule {
  required: boolean;
}
export interface LotRule {
  required: true;
}
export interface SupplierChangeRule {
  isMaterial: boolean;
}

export const FACTORY_RULE_DEFAULTS: { [MACERATION_REST]: RestRule; [QC_REFERENCE_REQUIRED]: ReferenceRule; [FILL_LOT_SERVER_ASSIGNED]: LotRule; [CONTINUITY_SUPPLIER_CHANGE]: SupplierChangeRule } = Object.freeze({
  [MACERATION_REST]: Object.freeze({ minDays: 45, maxDays: null, appliesTo: 'every_batch', earlyRelease: 'second_person' }) as RestRule,
  [QC_REFERENCE_REQUIRED]: Object.freeze({ required: true }) as ReferenceRule,
  [FILL_LOT_SERVER_ASSIGNED]: Object.freeze({ required: true }) as LotRule,
  [CONTINUITY_SUPPLIER_CHANGE]: Object.freeze({ isMaterial: true }) as SupplierChangeRule,
});

/** 1 = PROM-2 (every batch rests, no skip through HOLD/REWORK, early release by two people),
 *  PROM-3 (QC 1 / QC 2 rounds against the retained reference are the release verdict) and PROM-4
 *  (the finished-good lot and the generic oil-batch number are minted by the server; a typed one is
 *  refused). */
export const FACTORY_ENFORCEMENT_VERSION: Readonly<Record<FactoryRuleKey, number>> = Object.freeze({
  [MACERATION_REST]: 1,
  [QC_REFERENCE_REQUIRED]: 1,
  [FILL_LOT_SERVER_ASSIGNED]: 1,
  /* PROM-5: each batch's continuity key is recorded at compounding, and a change is sent before any
     lot under the new key can be released. */
  [CONTINUITY_SUPPLIER_CHANGE]: 1,
});

const isDays = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 365;

/** Why a `maceration.rest` value cannot be used ([] = usable). The screen shows these verbatim. */
export function restRuleProblems(v: unknown): string[] {
  const o = (v ?? null) as Partial<RestRule> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return ['The rest rule is not a rule.'];
  const out: string[] = [];
  if (!isDays(o.minDays)) out.push('minDays must be a whole number of days, 1 to 365.');
  if (!(o.maxDays === null || isDays(o.maxDays))) out.push('maxDays must be a whole number of days, 1 to 365, or null for no maximum.');
  if (isDays(o.minDays) && isDays(o.maxDays) && (o.maxDays as number) < (o.minDays as number)) out.push('maxDays cannot be less than minDays.');
  if (o.appliesTo !== 'every_batch') out.push('appliesTo must be "every_batch": the promise is about every batch.');
  if (o.earlyRelease !== 'second_person') out.push('earlyRelease must be "second_person": an early release is never one person\'s decision.');
  return out;
}

export function referenceRuleProblems(v: unknown): string[] {
  const o = (v ?? null) as Partial<ReferenceRule> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return ['The reference rule is not a rule.'];
  return typeof o.required === 'boolean' ? [] : ['required must be true or false.'];
}

export function supplierChangeRuleProblems(v: unknown): string[] {
  const o = (v ?? null) as Partial<SupplierChangeRule> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return ['The supplier-change rule is not a rule.'];
  return typeof o.isMaterial === 'boolean' ? [] : ['isMaterial must be true or false.'];
}

/** PROM-4: the lot rule has one valid value. Switching it off would let a typed lot onto a pack. */
export function lotRuleProblems(v: unknown): string[] {
  const o = (v ?? null) as Partial<LotRule> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return ['The lot rule is not a rule.'];
  return o.required === true ? [] : ['required must be true: the lot is assigned by the server at fill and is never typed, so this rule cannot be switched off.'];
}

export function isFactoryRuleKey(key: string): key is FactoryRuleKey {
  return (FACTORY_RULE_KEYS as readonly string[]).includes(key);
}

/** Every value a body can produce (each rule's THEN and the default), checked; [] = publishable. */
export function factoryRuleProblems(key: string, body: PolicyBody): string[] {
  if (!isFactoryRuleKey(key)) return [];
  const check = key === MACERATION_REST ? restRuleProblems : key === FILL_LOT_SERVER_ASSIGNED ? lotRuleProblems
    : key === CONTINUITY_SUPPLIER_CHANGE ? supplierChangeRuleProblems : referenceRuleProblems;
  const out: string[] = [];
  (body.rules ?? []).forEach((r, i) => check(r.then).forEach((p) => out.push(`Rule ${i + 1}: ${p}`)));
  if (body.hasDefault) check(body.defaultValue).forEach((p) => out.push(`Otherwise: ${p}`));
  return out;
}

export interface RuleInForce<T> {
  value: T;
  /** 0 = the registry default (no version published yet). */
  version: number;
  source: 'policy' | 'registry_default';
  explain: string;
}

async function readRule(tx: BridgeEmitTx, key: FactoryRuleKey, ctx: Record<string, unknown>): Promise<RuleInForce<unknown>> {
  const rows = Array.from((await tx.execute(sql`
    select version, body::text as body from platform.policy_version
     where policy_key = ${key} and created_dt <= now() order by version desc limit 1`)) as unknown as { version: number; body: string }[]);
  const row = rows[0];
  if (!row) return { value: FACTORY_RULE_DEFAULTS[key], version: 0, source: 'registry_default', explain: `No version of ${key} published: the registry default applies` };
  const body = JSON.parse(String(row.body)) as PolicyBody;
  const e = evaluateRules(body, ctx);
  if (!e.resolved) throw new ConflictException(`Policy ${key} v${row.version} has no rule for this case and no default: hold and ask (${e.explain}).`);
  return { value: e.value, version: Number(row.version), source: 'policy', explain: e.explain };
}

/** The rest rule for one oil batch. `branch` is null until WO-SET-2 gives an oil batch its branch;
 *  until then the general rung (the owner's 45) applies to every branch. */
export async function restRuleInForce(tx: BridgeEmitTx, ctx: { oilBatchId?: string | null; branch?: string | null } = {}): Promise<RuleInForce<RestRule>> {
  const r = await readRule(tx, MACERATION_REST, { record_type: 'oil_batch', record_id: ctx.oilBatchId ?? null, branch: ctx.branch ?? null });
  const problems = restRuleProblems(r.value);
  if (problems.length) throw new ConflictException(`The ${MACERATION_REST} rule (v${r.version}) is not a valid rule, so this batch is held: ${problems.join(' ')} Ask an admin to fix it on the Rules screen.`);
  return r as RuleInForce<RestRule>;
}

/** Whether QC 1 / QC 2 rounds against the retained reference are the release verdict. */
export async function referenceRuleInForce(tx: BridgeEmitTx, ctx: { productId?: string | null; oilBatchId?: string | null; branch?: string | null } = {}): Promise<RuleInForce<ReferenceRule>> {
  const r = await readRule(tx, QC_REFERENCE_REQUIRED, { record_type: 'oil_batch', record_id: ctx.oilBatchId ?? null, product: ctx.productId ?? null, branch: ctx.branch ?? null });
  const problems = referenceRuleProblems(r.value);
  if (problems.length) throw new ConflictException(`The ${QC_REFERENCE_REQUIRED} rule (v${r.version}) is not a valid rule, so QC is held: ${problems.join(' ')} Ask an admin to fix it on the Rules screen.`);
  return r as RuleInForce<ReferenceRule>;
}

/** PROM-4: the lot rule in force. Read by the fill and the oil-batch create so the version that
 *  refused a typed lot is the one on record; a malformed value holds (409), never a typed lot. */
export async function lotRuleInForce(tx: BridgeEmitTx): Promise<RuleInForce<LotRule>> {
  const r = await readRule(tx, FILL_LOT_SERVER_ASSIGNED, { record_type: 'fill' });
  const problems = lotRuleProblems(r.value);
  if (problems.length) throw new ConflictException(`The ${FILL_LOT_SERVER_ASSIGNED} rule (v${r.version}) is not a valid rule, so this fill is held: ${problems.join(' ')} Ask an admin to fix it on the Rules screen.`);
  return r as RuleInForce<LotRule>;
}
