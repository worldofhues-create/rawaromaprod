/**
 * PROM-5 (LD-85, ALEMBIC docs/plan/program/process-promises.md P-04, P-05, P-08): what "the same oil"
 * means, and detecting when it stops being true.
 *
 *   DEFINITION, stated once (pure, below): two batches of one product (a RawProd product row is one
 *   code and grade) are the same oil when they share
 *     (a) the formula version,
 *     (b) the set of raw-material identities, each with its supplier(s), and
 *     (c) the active retained reference they are compared with.
 *   A different raw lot from the SAME supplier is not a change: QC 1 and QC 2 against the reference
 *   cover lot-to-lot variation.
 *
 *   THE CONTINUITY KEY is ck1:sha256 over exactly those three, canonicalised. It is opaque: no material
 *   name, supplier, percentage or formula content can be read back from it (D-1, VAULT.md rule 1), and
 *   the inputs are opaque ids in the first place.
 *
 *   `continuity.supplier_change_is_material` (factory rule, default { isMaterial: true }, OQ-PROM-5): with
 *   it off the key is built from the identities alone, so a supplier swap is not a change.
 *
 *   RULE 3: when an input is not on file (no formula version on the order, a raw lot with no supplier
 *   from its goods receipt, a product that cannot be told) the key is NULL and the reason is recorded.
 *   No key means no claim: the batch neither proves continuity nor raises a change.
 *
 * The recorder runs in the caller's transaction (the oil-batch create, the reference approval), writes
 * production.batch_continuity / product_continuity / material_change, and sends `product.continuity.current`
 * and `product.material.changed` over the bridge: product code, kind, keys, first batch number and when.
 * No person, product name, material or supplier crosses.
 */
import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { bridge as bridgeContracts } from '@core/contracts';
import { emitBridgeManualEvent, type BridgeEmitTx } from './bridge-emit.js';
import { evaluateRules, type PolicyBody } from './policy-engine.js';
import { CONTINUITY_SUPPLIER_CHANGE, FACTORY_RULE_DEFAULTS, supplierChangeRuleProblems, type SupplierChangeRule } from './factory-rules.js';

export const CONTINUITY_SUPPLIER_RULE = CONTINUITY_SUPPLIER_CHANGE;
export type SupplierRule = SupplierChangeRule;
export const SUPPLIER_RULE_DEFAULT: SupplierRule = FACTORY_RULE_DEFAULTS[CONTINUITY_SUPPLIER_CHANGE];
export const supplierRuleProblems = supplierChangeRuleProblems;

export const PRODUCT_CONTINUITY_CURRENT = bridgeContracts.PRODUCT_CONTINUITY_CURRENT;
export const PRODUCT_MATERIAL_CHANGED = bridgeContracts.PRODUCT_MATERIAL_CHANGED;
export const MATERIAL_CHANGE_KINDS = bridgeContracts.MATERIAL_CHANGE_KINDS;
export type MaterialChangeKind = bridgeContracts.MaterialChangeKindWire;

export interface ContinuityInputs {
  /** The formula version the batch was made to (opaque ref), or null when the order names none. */
  formulaVersionRef: string | null;
  /** One entry per raw lot used: its material identity (opaque) and its supplier (opaque, or null). */
  lots: ReadonlyArray<{ identityRef: string; supplierRef: string | null }>;
  /** The active retained reference's code, or null when the product has none yet (its first batches). */
  referenceRef: string | null;
  /** continuity.supplier_change_is_material. */
  supplierIsMaterial: boolean;
}

export interface ContinuityComponents {
  formulaVersionRef: string;
  /** sha256 of the canonical identity -> suppliers map (suppliers omitted when they are not material). */
  materialsHash: string;
  /** Identity -> sorted suppliers, kept to tell a supplier swap from a changed identity set. */
  materials: Readonly<Record<string, readonly string[]>>;
  referenceRef: string | null;
}

export type ContinuityResult =
  | { ok: true; key: string; components: ContinuityComponents }
  | { ok: false; missing: string[] };

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Pure: the continuity key, or what is missing. Deterministic: lot order and duplicates do not matter. */
export function continuityKey(input: ContinuityInputs): ContinuityResult {
  const missing: string[] = [];
  if (!input.formulaVersionRef) missing.push('formula_version');
  if (input.lots.length === 0) missing.push('raw_lots');
  const noSupplier = input.lots.filter((l) => !l.supplierRef).length;
  if (input.supplierIsMaterial && noSupplier > 0) missing.push(`supplier (${noSupplier} raw lot${noSupplier === 1 ? '' : 's'} with no supplier on file)`);
  if (missing.length) return { ok: false, missing };
  // The record keeps every supplier on file; the KEY includes them only while a supplier change is material.
  const map = new Map<string, Set<string>>();
  for (const l of input.lots) {
    const set = map.get(l.identityRef) ?? new Set<string>();
    if (l.supplierRef) set.add(l.supplierRef);
    map.set(l.identityRef, set);
  }
  const materials: Record<string, string[]> = {};
  for (const id of [...map.keys()].sort()) materials[id] = [...map.get(id)!].sort();
  const canonicalMaterials = Object.entries(materials).map(([id, s]) => (input.supplierIsMaterial ? `${id}=${s.join('+')}` : id)).join(',');
  const materialsHash = sha(`m1|${input.supplierIsMaterial ? 's' : 'n'}|${canonicalMaterials}`);
  const key = 'ck1:' + sha(`ck1|fv:${input.formulaVersionRef}|m:${materialsHash}|r:${input.referenceRef ?? '-'}`);
  return { ok: true, key, components: { formulaVersionRef: input.formulaVersionRef as string, materialsHash, materials, referenceRef: input.referenceRef } };
}

/**
 * Pure: the kinds of change between the product's current continuity and a new one. The first reference
 * a product ever gets is not a change (its first batches compared with nothing); replacing one is.
 * A different identity set under the same formula version is the recipe as made changing, so it reads
 * as a formula_version change rather than being dropped.
 */
export function changeKinds(prev: ContinuityComponents, next: ContinuityComponents, supplierIsMaterial = true): MaterialChangeKind[] {
  const out: MaterialChangeKind[] = [];
  const prevIds = Object.keys(prev.materials).sort().join(','), nextIds = Object.keys(next.materials).sort().join(',');
  // Suppliers are compared identity by identity, and only while a supplier change is material: switching
  // the rule moves the key, but it is not a change of material.
  const supplierMoved = supplierIsMaterial && Object.keys(next.materials).some((id) => (prev.materials[id] ?? []).join('+') !== (next.materials[id] ?? []).join('+'));
  if (prev.formulaVersionRef !== next.formulaVersionRef || prevIds !== nextIds) out.push('formula_version');
  else if (supplierMoved) out.push('supplier');
  if (prev.referenceRef !== null && prev.referenceRef !== next.referenceRef) out.push('reference');
  return out;
}

/* ── the recorder (I/O, in the caller's transaction) ───────────────────────────────────────── */

type Rows<T> = T[];
const rows = async <T>(tx: BridgeEmitTx, q: unknown): Promise<Rows<T>> => Array.from((await tx.execute(q)) as unknown as T[]);

async function supplierRuleInForce(tx: BridgeEmitTx): Promise<{ value: SupplierRule; version: number }> {
  const [row] = await rows<{ version: number; body: string }>(tx, sql`
    select version, body::text as body from platform.policy_version
     where policy_key = ${CONTINUITY_SUPPLIER_RULE} and created_dt <= now() order by version desc limit 1`);
  if (!row) return { value: SUPPLIER_RULE_DEFAULT, version: 0 };
  const e = evaluateRules(JSON.parse(String(row.body)) as PolicyBody, { record_type: 'oil_batch' });
  if (!e.resolved) throw new ConflictException(`The ${CONTINUITY_SUPPLIER_RULE} rule (v${row.version}) has no rule for this case and no default, so this batch is held. Ask an admin to fix it on the Rules screen.`);
  const problems = supplierRuleProblems(e.value);
  if (problems.length) throw new ConflictException(`The ${CONTINUITY_SUPPLIER_RULE} rule (v${row.version}) is not a valid rule, so this batch is held: ${problems.join(' ')} Ask an admin to fix it on the Rules screen.`);
  return { value: e.value as SupplierRule, version: Number(row.version) };
}

interface CurrentRow { continuity_key: string; formula_version_ref: string; materials: unknown; reference_ref: string | null; materials_hash: string }

function componentsOf(r: CurrentRow): ContinuityComponents {
  const m = (typeof r.materials === 'string' ? JSON.parse(r.materials) : r.materials) as Record<string, string[]>;
  return { formulaVersionRef: r.formula_version_ref, materialsHash: r.materials_hash, materials: m, referenceRef: r.reference_ref };
}

async function currentOf(tx: BridgeEmitTx, productId: string): Promise<CurrentRow | null> {
  const [r] = await rows<CurrentRow>(tx, sql`
    select continuity_key, formula_version_ref::text as formula_version_ref, materials, reference_ref, materials_hash
      from production.product_continuity where product_id = ${productId}::uuid order by created_dt desc, product_continuity_id desc limit 1`);
  return r ?? null;
}

async function setCurrent(tx: BridgeEmitTx, a: {
  productId: string; productCode: string; key: string; c: ContinuityComponents; source: 'batch' | 'reference';
  oilBatchId: string | null; batchNo: string | null; at: string; recordedBy: string;
}): Promise<void> {
  const [row] = await rows<{ id: string }>(tx, sql`
    insert into production.product_continuity (product_id, continuity_key, formula_version_ref, materials, materials_hash, reference_ref,
                                               source, first_oil_batch_id, effective_from, recorded_by)
    values (${a.productId}::uuid, ${a.key}, ${a.c.formulaVersionRef}::uuid, ${JSON.stringify(a.c.materials)}::jsonb, ${a.c.materialsHash},
            ${a.c.referenceRef}, ${a.source}, ${a.oilBatchId}::uuid, ${a.at}::timestamptz, ${a.recordedBy})
    returning product_continuity_id::text as id`);
  const wire: bridgeContracts.ProductContinuityCurrentWire = { product_code: a.productCode, grade: null, continuity_key: a.key, effective_from: a.at, first_batch_no: a.batchNo };
  const problems = bridgeContracts.checkProductContinuityCurrentWire(wire);
  if (problems.length) throw new ConflictException(`The continuity of ${a.productCode} could not be recorded for ALEMBIC: ${problems.join(', ')}.`);
  bridgeContracts.assertNoFormulaContent(wire);
  await emitBridgeManualEvent(tx, PRODUCT_CONTINUITY_CURRENT, row!.id, wire as unknown as Record<string, unknown>);
}

async function recordChanges(tx: BridgeEmitTx, a: {
  productId: string; productCode: string; kinds: MaterialChangeKind[]; fromKey: string; toKey: string;
  oilBatchId: string | null; batchNo: string | null; at: string; recordedBy: string;
}): Promise<void> {
  for (const kind of a.kinds) {
    const [row] = await rows<{ id: string }>(tx, sql`
      insert into production.material_change (product_id, product_code, kind, from_key, to_key, first_oil_batch_id, first_batch_no, approved_at, recorded_by)
      values (${a.productId}::uuid, ${a.productCode}, ${kind}, ${a.fromKey}, ${a.toKey}, ${a.oilBatchId}::uuid, ${a.batchNo}, ${a.at}::timestamptz, ${a.recordedBy})
      returning material_change_id::text as id`);
    const wire: bridgeContracts.ProductMaterialChangedWire = { product_code: a.productCode, grade: null, kind, from_key: a.fromKey, to_key: a.toKey, first_batch_no: a.batchNo, approved_at: a.at };
    const problems = bridgeContracts.checkProductMaterialChangedWire(wire);
    if (problems.length) throw new ConflictException(`The material change of ${a.productCode} could not be recorded for ALEMBIC: ${problems.join(', ')}.`);
    bridgeContracts.assertNoFormulaContent(wire);
    await emitBridgeManualEvent(tx, PRODUCT_MATERIAL_CHANGED, row!.id, wire as unknown as Record<string, unknown>);
  }
}

/**
 * At compounding: the batch's continuity, from the raw lots it consumed, the formula version its order
 * names and the product's active reference. Records the batch's key (or what is missing), and when the
 * key differs from the product's current one records each change and sends both facts. The first keyed
 * batch of a product sets its current continuity and raises no change.
 */
export async function recordBatchContinuity(tx: BridgeEmitTx, oilBatchId: string, recordedBy: string): Promise<{ key: string | null; missing: string[]; changes: MaterialChangeKind[] }> {
  const [b] = await rows<{ batch_number: string | null; formula_version_id: string | null; formula_id: string | null }>(tx, sql`
    select o.batch_number, po.formula_version_id::text as formula_version_id, pi.formula_id::text as formula_id
      from production.oil_batch_master o
      left join production.production_order po on po.production_order_id = o.production_order_id
      left join production.production_plan_items pi on pi.production_plan_item_id = po.production_plan_item_id
     where o.oil_batch_id = ${oilBatchId}::uuid`);
  if (!b) throw new Error(`oil batch ${oilBatchId} not found for its continuity`);
  const products = b.formula_id ? await rows<{ product_id: string; product_code: string | null }>(tx, sql`
    select product_id::text as product_id, product_code from packaging.product_master where formula_id = ${b.formula_id}::uuid order by product_id limit 2`) : [];
  const product = products.length === 1 && products[0]!.product_code ? products[0]! : null;
  const lots = await rows<{ identity_ref: string | null; supplier_ref: string | null }>(tx, sql`
    select ib.material_id::text as identity_ref, g.vendor_id::text as supplier_ref
      from production.oil_batch_consumption c
      left join inventory.inventory_batch ib on ib.inventory_batch_id = c.consumed_for_document_id
      left join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
      left join inventory.grn_items gi on gi.grn_item_id = rb.grn_item_id
      left join inventory.grn_master g on g.grn_id = gi.grn_id
     where c.oil_batch_id = ${oilBatchId}::uuid`);
  const [ref] = product ? await rows<{ reference_code: string }>(tx, sql`
    select reference_code from quality.reference_standard where product_id = ${product.product_id}::uuid and status = 'ACTIVE' limit 1`) : [];
  const rule = await supplierRuleInForce(tx);
  const missing: string[] = [];
  if (!product) missing.push(products.length > 1 ? 'product (the formula is on more than one product)' : 'product');
  const unknownIdentity = lots.filter((l) => !l.identity_ref).length;
  if (unknownIdentity) missing.push(`material identity (${unknownIdentity} raw lot${unknownIdentity === 1 ? '' : 's'} not on file)`);
  const result = continuityKey({
    formulaVersionRef: b.formula_version_id, referenceRef: ref?.reference_code ?? null, supplierIsMaterial: rule.value.isMaterial,
    lots: lots.filter((l) => l.identity_ref).map((l) => ({ identityRef: l.identity_ref as string, supplierRef: l.supplier_ref })),
  });
  if (!result.ok) missing.push(...result.missing);
  const key = missing.length === 0 && result.ok ? result.key : null;
  await tx.execute(sql`
    insert into production.batch_continuity (oil_batch_id, product_id, continuity_key, formula_version_ref, reference_ref, supplier_is_material,
                                             supplier_rule_version, missing, recorded_by)
    values (${oilBatchId}::uuid, ${product?.product_id ?? null}::uuid, ${key}, ${b.formula_version_id}::uuid, ${ref?.reference_code ?? null},
            ${rule.value.isMaterial}, ${rule.version}, ${missing.length ? JSON.stringify(missing) : null}::jsonb, ${recordedBy})
    on conflict (oil_batch_id) do nothing`);
  if (!key || !product || !result.ok) return { key: null, missing, changes: [] };
  const at = new Date().toISOString();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'product_continuity:' + product.product_id}))`);
  const cur = await currentOf(tx, product.product_id);
  if (cur && cur.continuity_key === key) return { key, missing: [], changes: [] };
  const changes = cur ? changeKinds(componentsOf(cur), result.components, rule.value.isMaterial) : [];
  if (cur && changes.length) {
    await recordChanges(tx, { productId: product.product_id, productCode: product.product_code as string, kinds: changes, fromKey: cur.continuity_key, toKey: key,
      oilBatchId, batchNo: b.batch_number, at, recordedBy });
  }
  await setCurrent(tx, { productId: product.product_id, productCode: product.product_code as string, key, c: result.components, source: 'batch',
    oilBatchId, batchNo: b.batch_number, at, recordedBy });
  return { key, missing: [], changes };
}

/**
 * When a second person approves a product's reference: the product's current continuity moves to the new
 * reference for the batches that follow. Replacing a reference is a change (`reference`); a product's first
 * reference is not (its earlier batches compared with nothing), so only the current key is re-sent. A
 * product with no keyed batch yet has nothing to move.
 */
export async function recordReferenceContinuity(tx: BridgeEmitTx, a: { productId: string; referenceCode: string; replacesRef: string | null; recordedBy: string }): Promise<{ key: string | null; changed: boolean }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'product_continuity:' + a.productId}))`);
  const cur = await currentOf(tx, a.productId);
  if (!cur) return { key: null, changed: false };
  const [p] = await rows<{ product_code: string | null }>(tx, sql`select product_code from packaging.product_master where product_id = ${a.productId}::uuid`);
  if (!p?.product_code) return { key: null, changed: false };
  const prev = componentsOf(cur);
  const next: ContinuityComponents = { ...prev, referenceRef: a.referenceCode };
  const key = 'ck1:' + sha(`ck1|fv:${next.formulaVersionRef}|m:${next.materialsHash}|r:${a.referenceCode}`);
  if (key === cur.continuity_key) return { key, changed: false };
  const at = new Date().toISOString();
  const kinds = changeKinds(prev, next, false);
  await recordChanges(tx, { productId: a.productId, productCode: p.product_code, kinds, fromKey: cur.continuity_key, toKey: key, oilBatchId: null, batchNo: null, at, recordedBy: a.recordedBy });
  await setCurrent(tx, { productId: a.productId, productCode: p.product_code, key, c: next, source: 'reference', oilBatchId: null, batchNo: null, at, recordedBy: a.recordedBy });
  return { key, changed: kinds.length > 0 };
}
