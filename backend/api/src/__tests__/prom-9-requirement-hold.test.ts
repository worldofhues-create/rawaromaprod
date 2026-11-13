/**
 * PROM-9 (ALEMBIC docs/plan/program/process-promises.md PROM-9, made to order): "If a raw material
 * changes, we tell you before your next order." When a product's continuity key moves between an order
 * and its batch, ALEMBIC tells the customer and HOLDS the requirement until they confirm, on the
 * existing ProductionRequirementChanged event: `hold: { reason_code, since } | null`. RawProd must not
 * plan a held requirement. Real Postgres, the real signed ImporterService path, the real
 * PlanningService and ProducePlanService.
 *
 *   contract  the shared fixture (test-support/fixtures/requirement-hold.json, byte-identical to
 *             ALEMBIC's packages/domain/test/fixtures/requirement-hold.json) validates; an unknown
 *             reason code, an extra key or a bad instant is refused as invalid; a Changed without
 *             `hold` still validates (old payloads keep working);
 *   held      the importer records the hold; "Produce next" refuses it with CUSTOMER_HOLD and creates
 *             nothing; linking it to a run is refused; the queue shows it BLOCKED with the reason;
 *   released  `hold: null` clears it and planning goes on to its ordinary checks;
 *   D-1       the payload carries the requirement and the hold only: no customer, notice or material.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ImporterService } from '../bridge/importer.service.js';
import { sealSecret } from '../bridge/secret-box.js';
import { signBody } from '../bridge/signing.js';
import { validateInboundPayload, requirementHoldOf, REQUIREMENT_HOLD_REASONS } from '../bridge/contract.js';
import { PlanningService } from '../../../cluster-production/src/planning/planning.service.js';
import { ProducePlanService, PlanBlockedException } from '../../../cluster-production/src/produce/produce-plan.service.js';
import { queueStage, BLOCK_MESSAGES } from '../../../cluster-production/src/produce/produce-queue.service.js';
import { ensureSchema, bridgeDb, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { requirement } from '../../../test-support/produce-fixtures.js';

const SECRET = 'prom-9-hold-test-secret';
const WEBHOOK = 'https://alembic.example.test/api/v1/bridge/rawprod/webhooks/in';
const FIXTURE = JSON.parse(readFileSync(new URL('../../../test-support/fixtures/requirement-hold.json', import.meta.url), 'utf8')) as {
  held: { requirement_id: string; hold: { reason_code: string; since: string } };
  released: { requirement_id: string; hold: null };
};

let importer: ImporterService;
let planning: PlanningService;
let plan: ProducePlanService;

before(async () => {
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = process.env.BRIDGE_HMAC_KEK ?? randomBytes(32).toString('base64');
  const sql = testClient();
  await sql`insert into bridge.connector_config (id, enabled, webhook_url, hmac_secret_sealed)
            values ('default', true, ${WEBHOOK}, ${sealSecret(SECRET)})
            on conflict (id) do update set enabled = true, webhook_url = excluded.webhook_url,
                                           hmac_secret_sealed = excluded.hmac_secret_sealed`;
  importer = new ImporterService(bridgeDb(), sql);
  planning = new PlanningService(productionDb(), { async resolveManufacturingInstruction() { return null; }, async resolvePickList() { return []; } } as never);
  plan = new ProducePlanService(productionDb(), planning);
});
after(async () => { await closeTestClient(); });

function changed(r: { id: string; correlationId: string; orgId: string }, version: number, payload: Record<string, unknown>) {
  return {
    event_id: randomUUID(), version, type: 'ProductionRequirementChanged',
    org_id: r.orgId, correlation_id: r.correlationId, causation_id: null,
    occurred_at: new Date().toISOString(), source: 'alembic',
    aggregate: { type: 'production_requirement', id: r.id },
    payload: { ...payload, requirement_id: r.id },
  };
}
function send(env: unknown) {
  const body = JSON.stringify(env);
  return importer.handleAlembicEvent(body, signBody(body, SECRET));
}
const holdOf = async (id: string) => (await testClient()<Array<{ customer_hold_reason: string | null; customer_hold_since: Date | null; production_order_id: string | null }>>`
  select customer_hold_reason, customer_hold_since, production_order_id from bridge.production_requirement where alembic_requirement_id = ${id}`)[0]!;

test('contract: the shared fixture validates; an unknown reason, an extra key or a bad instant is invalid; no hold still validates', () => {
  assert.deepEqual(validateInboundPayload('ProductionRequirementChanged', FIXTURE.held), []);
  assert.deepEqual(validateInboundPayload('ProductionRequirementChanged', FIXTURE.released), []);
  assert.deepEqual(validateInboundPayload('ProductionRequirementChanged', { requirement_id: FIXTURE.held.requirement_id, qty: '10', uom: 'kg' }), [],
    'a Changed without a hold is an old payload and still parses');
  const bad = (hold: unknown) => validateInboundPayload('ProductionRequirementChanged', { requirement_id: FIXTURE.held.requirement_id, hold });
  assert.deepEqual(bad({ reason_code: 'because', since: FIXTURE.held.hold.since }), ['hold:invalid']);
  assert.deepEqual(bad({ ...FIXTURE.held.hold, customer: 'C-1' }), ['hold:invalid'], 'nothing about the customer may ride along');
  assert.deepEqual(bad({ reason_code: 'material_change_unacknowledged', since: 'yesterday' }), ['hold:invalid']);
  assert.deepEqual(bad('held'), ['hold:invalid']);
  assert.deepEqual([...REQUIREMENT_HOLD_REASONS], ['material_change_unacknowledged'], 'the same closed list as ALEMBIC');
  assert.equal(requirementHoldOf({}), undefined, 'absent leaves the hold alone');
  assert.equal(requirementHoldOf(FIXTURE.released), null);
  assert.deepEqual(requirementHoldOf(FIXTURE.held), { reasonCode: 'material_change_unacknowledged', since: new Date(FIXTURE.held.hold.since) });
  assert.deepEqual(Object.keys(FIXTURE.held).sort(), ['hold', 'requirement_id'], 'D-1: the requirement and the hold, nothing else');
});

test('held: the importer records it, "Produce next" refuses it and creates nothing, a run cannot take it, and the queue says why', async () => {
  const r = await requirement({ sku: `FSKU-PROM9-${randomUUID().slice(0, 6)}` }); // last_applied_version 1
  const res = await send(changed(r, 2, { hold: FIXTURE.held.hold }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const h = await holdOf(r.id);
  assert.equal(h.customer_hold_reason, 'material_change_unacknowledged');
  assert.equal(new Date(h.customer_hold_since!).toISOString(), FIXTURE.held.hold.since);

  await assert.rejects(plan.planRequirement(r.id, principal({ roles: ['production'] })),
    (err: unknown) => err instanceof PlanBlockedException && err.reason === 'CUSTOMER_HOLD');
  assert.equal((await holdOf(r.id)).production_order_id, null, 'nothing was planned');

  await assert.rejects(productionDb().transaction((tx) => planning.linkRequirementTx(tx as never, r.id, randomUUID())), /held by ALEMBIC/);
  assert.equal((await holdOf(r.id)).production_order_id, null, 'no run took it');

  assert.equal(queueStage({ lifecycle_status: 'ACCEPTED', produce_block_reason: null, customer_hold_reason: 'material_change_unacknowledged',
    production_order_id: null, run_status: null, mixing_started: false, oil_batch_id: null, coa_status: null, coa_result: null, fg_batch_id: null, rack: null } as never), 'BLOCKED');
  assert.match(BLOCK_MESSAGES.CUSTOMER_HOLD!, /Held by ALEMBIC/);

  // A later quantity change without a hold field leaves the hold in place.
  const qty = await send(changed(r, 3, { qty: '60', uom: 'kg' }));
  assert.equal(qty.status, 200, JSON.stringify(qty.body));
  assert.equal((await holdOf(r.id)).customer_hold_reason, 'material_change_unacknowledged');

  // Released: hold null clears it, and planning goes on to its ordinary checks (this SKU is unknown here).
  const rel = await send(changed(r, 4, { hold: null }));
  assert.equal(rel.status, 200, JSON.stringify(rel.body));
  const after = await holdOf(r.id);
  assert.equal(after.customer_hold_reason, null);
  assert.equal(after.customer_hold_since, null);
  await assert.rejects(plan.planRequirement(r.id, principal({ roles: ['production'] })),
    (err: unknown) => err instanceof PlanBlockedException && err.reason !== 'CUSTOMER_HOLD');
});

test('a malformed hold is refused as permanent and records nothing', async () => {
  const r = await requirement({ sku: `FSKU-PROM9-${randomUUID().slice(0, 6)}` });
  const res = await send(changed(r, 2, { hold: { reason_code: 'material_change_unacknowledged', since: FIXTURE.held.hold.since, notice: 'Told the buyer' } }));
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal((res.body as { permanent?: boolean }).permanent, true);
  assert.equal((await holdOf(r.id)).customer_hold_reason, null);
});
