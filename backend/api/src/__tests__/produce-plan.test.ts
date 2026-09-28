/**
 * Lane produce — "Produce next", one click: requirement → plan item → MASTER RUN, pre-filled with
 * SKU / pack / quantity and the product's APPROVED formula, shown as CODE + VERSION only. Real
 * Postgres, the real PlanningService + ProducePlanService; the Vault is a stub (its HTTP half is
 * vault-port-http-client.test.ts, the two-process path vault-isolation-harness.test.ts).
 *
 *   created   a new plan item on today's plan + a run for the requirement's kg, ingredients from the
 *             Vault's coded pick list, the requirement linked, `ProductionScheduled` to it.
 *   extended  a second requirement for the same approved formula JOINS the open run: its size and
 *             bill of materials grow, only the new requirement hears ProductionScheduled.
 *   blocked   no approved formula (or no formula linked to the product) → a plain refusal
 *             ("No approved formula for this product in the Vault — a formulator must seal and
 *             approve one"), the reason recorded on the requirement, the formula roles alerted,
 *             nothing created.
 *   MASKED    no formula name, material identity or percentage reaches any main-box payload or log:
 *             the stub Vault deliberately over-shares a formula NAME, and none of the response, the
 *             bridge / production outboxes, the alert log or the process output ever carries it;
 *             every bridge payload passes assertNoFormulaContent; ProductionScheduled no longer
 *             carries formula_version_id.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bridge as contracts } from '@core/contracts';
import type { PickLine, VaultPort } from '@ra/cluster-formula';
import { PlanningService } from '../../../cluster-production/src/planning/planning.service.js';
import { ProducePlanService, PlanBlockedException } from '../../../cluster-production/src/produce/produce-plan.service.js';
import { ProduceQueueService } from '../../../cluster-production/src/produce/produce-queue.service.js';
import { ensureSchema, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { productWithSku, requirement, kgUom } from '../../../test-support/produce-fixtures.js';

const SECRET_FORMULA_NAME = 'Oud Royale Secret Accord';
const SECRET_MATERIAL_NAME = 'Ambroxan Crystal Reserve';

/** formulaId → approved version (or none). The stub over-shares a name the real Vault never sends. */
const approved = new Map<string, { formulaVersionId: string; versionNumber: number } | null>();
const pickCalls: Array<{ formulaVersionId: string; orderQty: number }> = [];

const vaultApi = {
  async formulaLabels(q: { formulaVersionIds: string[]; formulaIds: string[] }) {
    const byVersion = new Map<string, { formulaId: string; versionNumber: number }>();
    for (const [formulaId, v] of approved) if (v) byVersion.set(v.formulaVersionId, { formulaId, versionNumber: v.versionNumber });
    return {
      versions: q.formulaVersionIds.filter((id) => byVersion.has(id)).map((id) => ({
        formulaVersionId: id, formulaId: byVersion.get(id)!.formulaId,
        formulaCode: `FRM-${byVersion.get(id)!.formulaId.slice(0, 4).toUpperCase()}`,
        versionNumber: byVersion.get(id)!.versionNumber, status: 'APPROVED', formulaName: SECRET_FORMULA_NAME,
      })),
      formulas: q.formulaIds.map((formulaId) => ({
        formulaId, formulaCode: `FRM-${formulaId.slice(0, 4).toUpperCase()}`,
        formulaName: SECRET_FORMULA_NAME, // must never be picked up by the main box
        approvedVersion: approved.get(formulaId) ?? null,
      })),
      recent: null,
    };
  },
};

let materials: string[] = [];
const vaultPort: VaultPort = {
  async resolveManufacturingInstruction() { return null; },
  async resolvePickList(formulaVersionId, orderQty): Promise<PickLine[]> {
    pickCalls.push({ formulaVersionId, orderQty });
    return materials.map((materialId, i) => ({ materialId, requiredQty: (orderQty * (i + 1) / 10).toFixed(4), sequenceNo: i + 1 }));
  },
};

let planning: PlanningService;
let plan: ProducePlanService;
let queue: ProduceQueueService;
const out: string[] = [];
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);

before(async () => {
  await ensureSchema();
  await kgUom();
  const sql = testClient();
  materials = [randomUUID(), randomUUID()];
  for (const m of materials) {
    await sql`insert into masterdata.material (material_id, material_code, material_name, status)
              values (${m}, ${`MAT-${m.slice(0, 8)}`}, ${SECRET_MATERIAL_NAME}, 'ACTIVE')`;
  }
  planning = new PlanningService(productionDb(), vaultPort);
  plan = new ProducePlanService(productionDb(), planning, vaultApi as never);
  queue = new ProduceQueueService(productionDb(), vaultApi as never);
  // Capture everything this process prints while the produce flow runs (logs included).
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => { out.push(String(chunk)); return (origOut as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { out.push(String(chunk)); return (origErr as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
});
after(async () => {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  await closeTestClient();
});

async function bridgeOutbox(reqId: string) {
  return testClient()`select type, payload from bridge.outbox where aggregate_id = ${reqId} order by seq`;
}

test('created: plan item + run for the requirement\'s kg, pre-filled, linked, ProductionScheduled to it', async () => {
  const p = await productWithSku();
  const versionId = randomUUID();
  approved.set(p.formulaId, { formulaVersionId: versionId, versionNumber: 4 });
  const r = await requirement({ sku: p.skuCode, qtyKg: 75 });
  const user = principal({ roles: ['production'] });
  pickCalls.length = 0;

  const res = await plan.planRequirement(r.id, user);
  assert.equal(res.mode, 'created');
  assert.equal(res.runQtyKg, 75);
  assert.deepEqual(res.formula, { code: `FRM-${p.formulaId.slice(0, 4).toUpperCase()}`, version: 4 });
  assert.deepEqual(pickCalls, [{ formulaVersionId: versionId, orderQty: 75 }]);
  assert.equal(res.ingredientCount, 2);

  const [order] = await testClient()`select status, order_qty::float, formula_version_id::text, production_plan_item_id::text
                                       from production.production_order where production_order_id = ${res.productionOrderId}`;
  assert.deepEqual({ ...order }, { status: 'PLANNING', order_qty: 75, formula_version_id: versionId, production_plan_item_id: res.productionPlanItemId });
  const [item] = await testClient()`select i.formula_id::text, i.planned_qty::float, p.plan_date::text, p.status
                                      from production.production_plan_items i join production.production_plan p on p.production_plan_id = i.production_plan_id
                                     where i.production_plan_item_id = ${res.productionPlanItemId}`;
  assert.deepEqual({ ...item }, { formula_id: p.formulaId, planned_qty: 75, plan_date: new Date().toISOString().slice(0, 10), status: 'DRAFT' });
  const [req] = await testClient()`select production_order_id::text from bridge.production_requirement where alembic_requirement_id = ${r.id}`;
  assert.equal(req!.production_order_id, res.productionOrderId);

  const events = await bridgeOutbox(r.id);
  assert.deepEqual(events.map((e) => e.type), ['ProductionScheduled']);
  assert.equal((events[0]!.payload as Record<string, unknown>).production_order_id, res.productionOrderId);
  assert.equal('formula_version_id' in (events[0]!.payload as Record<string, unknown>), false, 'no formula.* field crosses the bridge');

  // The queue now shows it PLANNED with the run's formula as code + version.
  const row = (await queue.queue(500)).items.find((i) => i.alembicRequirementId === r.id);
  assert.equal(row?.stage, 'PLANNED');
  await assert.rejects(() => plan.planRequirement(r.id, user), /already planned/);
});

test('extended: the next requirement for the same approved formula joins the open run', async () => {
  const p = await productWithSku();
  const versionId = randomUUID();
  approved.set(p.formulaId, { formulaVersionId: versionId, versionNumber: 2 });
  const first = await requirement({ sku: p.skuCode, qtyKg: 50 });
  const second = await requirement({ sku: p.skuCode, qtyKg: 25 });
  const user = principal({ roles: ['production'] });
  const a = await plan.planRequirement(first.id, user);
  const before = (await bridgeOutbox(first.id)).length;
  pickCalls.length = 0;
  const b = await plan.planRequirement(second.id, user);
  assert.equal(b.mode, 'extended');
  assert.equal(b.productionOrderId, a.productionOrderId);
  assert.equal(b.runQtyKg, 75);
  assert.equal(b.addedQtyKg, 25);
  assert.deepEqual(pickCalls, [{ formulaVersionId: versionId, orderQty: 75 }], 'the bill of materials is re-resolved for the new size');
  const [order] = await testClient()`select order_qty::float from production.production_order where production_order_id = ${a.productionOrderId}`;
  assert.equal(order!.order_qty, 75);
  const ing = await testClient()`select required_qty::float from production.production_order_ingredients
                                  where production_order_id = ${a.productionOrderId} order by required_qty`;
  assert.deepEqual(ing.map((i) => i.required_qty), [7.5, 15]);
  const [item] = await testClient()`select planned_qty::float from production.production_plan_items where production_plan_item_id = ${a.productionPlanItemId}`;
  assert.equal(item!.planned_qty, 75);
  assert.equal((await bridgeOutbox(first.id)).length, before, 'the first requirement does not hear a second ProductionScheduled');
  assert.deepEqual((await bridgeOutbox(second.id)).map((e) => e.type), ['ProductionScheduled']);
  // A run that has left PLANNING is never extended: a third requirement gets its own run.
  await testClient()`update production.production_order set status = 'INPROGRESS' where production_order_id = ${a.productionOrderId}`;
  const third = await requirement({ sku: p.skuCode, qtyKg: 5 });
  const c = await plan.planRequirement(third.id, user);
  assert.equal(c.mode, 'created');
  assert.notEqual(c.productionOrderId, a.productionOrderId);
});

test('blocked: no approved formula → a plain refusal, recorded, formula roles alerted, nothing created', async () => {
  const p = await productWithSku();
  approved.set(p.formulaId, null);
  const r = await requirement({ sku: p.skuCode, qtyKg: 10 });
  const runsBefore = (await testClient()`select count(*)::int as n from production.production_order`)[0]!.n as number;
  await assert.rejects(() => plan.planRequirement(r.id, principal({ roles: ['production'] })),
    (e: unknown) => e instanceof PlanBlockedException
      && (e as Error).message === 'No approved formula for this product in the Vault — a formulator must seal and approve one');
  const [req] = await testClient()`select produce_block_reason, production_order_id from bridge.production_requirement where alembic_requirement_id = ${r.id}`;
  assert.deepEqual({ ...req }, { produce_block_reason: 'NO_APPROVED_FORMULA', production_order_id: null });
  const alert = await testClient()`select kind, roles, title, detail from production.produce_alert where kind = 'formula_needed' and ref_id = ${p.productId}`;
  assert.equal(alert.length, 1);
  assert.deepEqual([...(alert[0]!.roles as string[])].sort(), ['formulator', 'production', 'vault_approver']);
  assert.match(String(alert[0]!.title), new RegExp(p.productCode));
  assert.equal((await testClient()`select count(*)::int as n from production.production_order`)[0]!.n, runsBefore);
  const row = (await queue.queue(500)).items.find((i) => i.alembicRequirementId === r.id);
  assert.equal(row?.stage, 'BLOCKED');

  // Once the formulator seals and approves one, the same click plans it and clears the block.
  approved.set(p.formulaId, { formulaVersionId: randomUUID(), versionNumber: 1 });
  const ok = await plan.planRequirement(r.id, principal({ roles: ['production'] }));
  assert.equal(ok.mode, 'created');
  const [cleared] = await testClient()`select produce_block_reason from bridge.production_requirement where alembic_requirement_id = ${r.id}`;
  assert.equal(cleared!.produce_block_reason, null);
});

test('blocked: a product not linked to any formula says so', async () => {
  const p = await productWithSku({ formulaId: null });
  const r = await requirement({ sku: p.skuCode, qtyKg: 10 });
  await assert.rejects(() => plan.planRequirement(r.id, principal()),
    (e: unknown) => e instanceof PlanBlockedException && (e as PlanBlockedException).reason === 'NO_FORMULA_LINK'
      && /No approved formula for this product in the Vault/.test((e as Error).message));
  const unknown = await requirement({ sku: `NOPE-${randomUUID().slice(0, 6)}`, qtyKg: 1 });
  await assert.rejects(() => plan.planRequirement(unknown.id, principal()), /not in the factory catalogue/);
});

test('MASKED: no formula name, material identity or percentage in any main-box payload or log', async () => {
  const p = await productWithSku();
  approved.set(p.formulaId, { formulaVersionId: randomUUID(), versionNumber: 7 });
  const r = await requirement({ sku: p.skuCode, qtyKg: 40 });
  const blockedP = await productWithSku();
  approved.set(blockedP.formulaId, null);
  const rb = await requirement({ sku: blockedP.skuCode, qtyKg: 3 });
  const mark = out.length;
  const res = await plan.planRequirement(r.id, principal({ roles: ['production'] }));
  await plan.planRequirement(rb.id, principal({ roles: ['production'] })).catch(() => undefined);
  const q = await queue.queue(500);
  const printed = out.slice(mark).join('');

  const haystacks: Array<[string, string]> = [
    ['plan response', JSON.stringify(res)],
    ['queue response', JSON.stringify(q)],
    ['process output', printed],
  ];
  for (const e of await testClient()`select type, payload from bridge.outbox where aggregate_id in (${r.id}, ${rb.id})`) {
    assert.doesNotThrow(() => contracts.assertNoFormulaContent(e.payload), `bridge ${e.type} carries no formula content`);
    haystacks.push([`bridge ${e.type}`, JSON.stringify(e.payload)]);
  }
  for (const e of await testClient()`select type, payload from production.outbox where aggregate_id = ${res.productionOrderId} or payload->>'title' like ${`%${blockedP.productCode}%`}`) {
    haystacks.push([`production ${e.type}`, JSON.stringify(e.payload)]);
  }
  for (const a of await testClient()`select title, detail from production.produce_alert where ref_id = ${blockedP.productId}`) {
    haystacks.push(['alert', `${a.title} ${a.detail}`]);
  }
  for (const [where, text] of haystacks) {
    assert.ok(!text.includes(SECRET_FORMULA_NAME), `${where} must not carry the formula name`);
    assert.ok(!text.includes(SECRET_MATERIAL_NAME), `${where} must not carry a material name`);
    assert.ok(!/formula_?name|formulaName|material_?name|percentage/i.test(text), `${where} must not carry formula/material fields`);
  }
  // The floor sees the code + version only.
  const row = q.items.find((i) => i.alembicRequirementId === r.id)!;
  assert.deepEqual(Object.keys(row.formula ?? {}).sort(), ['code', 'version']);
});
