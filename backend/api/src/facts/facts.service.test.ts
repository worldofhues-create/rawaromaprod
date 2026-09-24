/**
 * FactsService — real Postgres (ensureSchema/testClient/bridgeDb from backend/test-support),
 * never a mock: the whole point of `production_requirement_status`'s three blockers is that
 * they come off real joins across production/procurement/quality, and a mock can't lie about
 * whether those joins actually resolve. Own throwaway DB per the parallel-lane rule
 * (TEST_DATABASE_URL=postgres://apple@localhost:5432/rawprod_ar_test for lane L-AR).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ensureSchema, testClient, bridgeDb, closeTestClient,
} from "../../../test-support/db.js";
import { sealSecret } from "../bridge/secret-box.js";
import { signBody } from "../bridge/signing.js";
import { FactsService } from "./facts.service.js";

let facts: FactsService;
const kekPrior = process.env.BRIDGE_HMAC_KEK;

before(async () => {
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = Buffer.alloc(32, 9).toString("base64");
  facts = new FactsService(testClient(), bridgeDb());
});

after(async () => {
  if (kekPrior === undefined) delete process.env.BRIDGE_HMAC_KEK;
  else process.env.BRIDGE_HMAC_KEK = kekPrior;
  await closeTestClient();
});

/** Signs `body` the way `rawprod-facts-client.ts` now does — over `timestamp.nonce.body`
 *  (S3 security review item 5) — and returns the three pieces `verifySignature` takes. */
function signedMaterial(body: string, secret: string, overrides: { timestamp?: string; nonce?: string } = {}) {
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = overrides.nonce ?? randomUUID();
  return { header: signBody(`${timestamp}.${nonce}.${body}`, secret), timestamp, nonce };
}

test("verifySignature: true for a correctly signed body, false when unconfigured or wrong", async () => {
  const sql = testClient();
  const secret = "facts-test-secret";
  await sql`
    insert into bridge.connector_config (id, enabled, hmac_secret_sealed, configured_by)
    values ('default', true, ${sealSecret(secret)}, 'test')
    on conflict (id) do update set enabled = true, hmac_secret_sealed = ${sealSecret(secret)}`;

  const body = JSON.stringify({ hello: "world" });
  const good = signedMaterial(body, secret);
  assert.equal(await facts.verifySignature(body, good.header, good.timestamp, good.nonce), true);

  const wrongSecret = signedMaterial(body, "wrong-secret");
  assert.equal(await facts.verifySignature(body, wrongSecret.header, wrongSecret.timestamp, wrongSecret.nonce), false);

  assert.equal(await facts.verifySignature(body, null, good.timestamp, randomUUID()), false);
});

test("S3 item 5: a replayed nonce is refused on its second presentation", async () => {
  const sql = testClient();
  const secret = "facts-test-secret-replay";
  await sql`
    insert into bridge.connector_config (id, enabled, hmac_secret_sealed, configured_by)
    values ('default', true, ${sealSecret(secret)}, 'test')
    on conflict (id) do update set enabled = true, hmac_secret_sealed = ${sealSecret(secret)}`;

  const body = JSON.stringify({ replay: "test" });
  const { header, timestamp, nonce } = signedMaterial(body, secret);
  assert.equal(await facts.verifySignature(body, header, timestamp, nonce), true);
  // Identical presentation a second time — same signature, same timestamp, same nonce.
  assert.equal(await facts.verifySignature(body, header, timestamp, nonce), false);
});

test("S3 item 5: a timestamp older than 300s is refused even with an otherwise-perfect signature", async () => {
  const sql = testClient();
  const secret = "facts-test-secret-stale";
  await sql`
    insert into bridge.connector_config (id, enabled, hmac_secret_sealed, configured_by)
    values ('default', true, ${sealSecret(secret)}, 'test')
    on conflict (id) do update set enabled = true, hmac_secret_sealed = ${sealSecret(secret)}`;

  const body = JSON.stringify({ stale: "test" });
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);
  const { header, timestamp, nonce } = signedMaterial(body, secret, { timestamp: staleTimestamp });
  assert.equal(await facts.verifySignature(body, header, timestamp, nonce), false);
});

test("S3 item 5: missing timestamp or nonce is refused outright", async () => {
  const body = JSON.stringify({ x: 1 });
  assert.equal(await facts.verifySignature(body, "sha256=whatever", null, randomUUID()), false);
  assert.equal(await facts.verifySignature(body, "sha256=whatever", String(Math.floor(Date.now() / 1000)), null), false);
});

test("permissionsForCaller: S3 item 5 — resolves from RawProd's OWN grant via alembic_subject, "
  + "never from a caller-claimed role list (there is none to trust here)", async () => {
  const sql = testClient();
  const staffId = `staff:facts-svc-${randomUUID()}@rawaroma.local`;
  const userId = randomUUID();
  const roleCode = `facts-role-${randomUUID()}`;
  await sql`
    insert into iam.user_master (user_id, email, user_name, is_active, status, alembic_subject)
    values (${userId}, ${`${roleCode}@rawaroma.local`}, 'Facts Svc Test', true, 'ACTIVE', ${staffId})`;
  const [role] = await sql`
    insert into iam.role_master (role_code, status) values (${roleCode}, 'ACTIVE') returning role_id`;
  const [perm] = await sql`
    insert into iam.permission_master (permission_code, status)
    values ('production:production_order:read', 'ACTIVE')
    on conflict (permission_code) do update set status = 'ACTIVE'
    returning permission_id`;
  await sql`
    insert into iam.user_role_mapping (user_id, role_id, status) values (${userId}, ${role!.role_id}, 'ACTIVE')`;
  await sql`
    insert into iam.role_permission_mapping (role_id, permission_id, status)
    values (${role!.role_id}, ${perm!.permission_id}, 'ACTIVE')
    on conflict (role_id, permission_id) do nothing`;

  const held = await facts.permissionsForCaller(staffId);
  assert.ok(held.has("production:production_order:read"));

  const heldForUnboundStaffId = await facts.permissionsForCaller(`staff:nobody-${randomUUID()}@rawaroma.local`);
  assert.equal(heldForUnboundStaffId.size, 0);
});

/* ── S4 SECURITY REVIEW FINDING N1 — caller resolution by the staff uuid, cross-repo contract ─
 *
 * `permissionsForCaller` already resolves by a straight `alembic_subject = staffId` match
 * (untouched by this finding — see this file's own header on why that is correct regardless of
 * what SHAPE `staffId` is). What N1 fixes is upstream, on ALEMBIC's side: `caller.staffId` on
 * the wire is now the immutable `staff_user` uuid (`apps/api/src/adapters/
 * rawprod-facts-client.ts`'s `resolveStaffUuid`), not `staff:<email>`. This test proves THIS
 * repository's half of that contract — resolution by the uuid ALEMBIC now actually sends,
 * using the SAME example uuid `apps/api/test/rawprod-assertion.test.ts`'s `ADMIN_STAFF_ID`
 * signs in the ALEMBIC repository (see docs/bridge/EVENT_CONTRACT.md's identity-bridge
 * section in both repos). */
test("N1 CONTRACT: permissionsForCaller resolves by the staff uuid ALEMBIC's facts client "
  + "actually sends (not staff:<email>) — the SAME example uuid ALEMBIC's own test signs",
  async () => {
    const sql = testClient();
    const CONTRACT_EXAMPLE_STAFF_UUID = "99999999-9999-9999-9999-999999999999";
    const roleCode = `facts-n1-role-${randomUUID()}`;
    // Idempotent against a re-run on the same database, AND against
    // `auth-service-assertion.test.ts`'s OWN "N1 CONTRACT" test sharing this exact literal
    // (the whole point of a cross-repo/cross-file contract fixture) — the unique partial index
    // on alembic_subject means at most one row anywhere in `iam.user_master` may hold it. Any
    // prior row's `user_role_mapping` children are cleared first (no ON DELETE CASCADE on that
    // FK), then the row itself, before inserting fresh.
    await sql`
      delete from iam.user_role_mapping where user_id in (
        select user_id from iam.user_master where alembic_subject = ${CONTRACT_EXAMPLE_STAFF_UUID})`;
    await sql`delete from iam.user_master where alembic_subject = ${CONTRACT_EXAMPLE_STAFF_UUID}`;
    const userId = randomUUID();
    await sql`
      insert into iam.user_master (user_id, email, user_name, is_active, status, alembic_subject)
      values (${userId}, ${`${roleCode}@rawaroma.local`}, 'Facts N1 Contract Test', true, 'ACTIVE',
        ${CONTRACT_EXAMPLE_STAFF_UUID})`;
    const [role] = await sql`
      insert into iam.role_master (role_code, status) values (${roleCode}, 'ACTIVE') returning role_id`;
    const [perm] = await sql`
      insert into iam.permission_master (permission_code, status)
      values ('production:production_order:read', 'ACTIVE')
      on conflict (permission_code) do update set status = 'ACTIVE'
      returning permission_id`;
    await sql`
      insert into iam.user_role_mapping (user_id, role_id, status) values (${userId}, ${role!.role_id}, 'ACTIVE')`;
    await sql`
      insert into iam.role_permission_mapping (role_id, permission_id, status)
      values (${role!.role_id}, ${perm!.permission_id}, 'ACTIVE')
      on conflict (role_id, permission_id) do nothing`;

    const held = await facts.permissionsForCaller(CONTRACT_EXAMPLE_STAFF_UUID);
    assert.ok(held.has("production:production_order:read"));
  });

test("permissionsForRoles: real role->permission mapping, never trusting the caller's own claim", async () => {
  const sql = testClient();
  const roleCode = `role-${randomUUID()}`;
  const [role] = await sql`
    insert into iam.role_master (role_code, role_name, status)
    values (${roleCode}, 'Facts Test Role', 'ACTIVE') returning role_id`;
  const [perm] = await sql`
    insert into iam.permission_master (permission_code, permission_name, status)
    values ('production:production_order:read', 'Read production orders', 'ACTIVE')
    on conflict (permission_code) do update set permission_name = excluded.permission_name
    returning permission_id`;
  await sql`
    insert into iam.role_permission_mapping (role_id, permission_id, status)
    values (${role!.role_id}, ${perm!.permission_id}, 'ACTIVE')
    on conflict (role_id, permission_id) do nothing`;

  const held = await facts.permissionsForRoles([roleCode]);
  assert.ok(held.has("production:production_order:read"));

  const heldForUnknownRole = await facts.permissionsForRoles([`no-such-role-${randomUUID()}`]);
  assert.equal(heldForUnknownRole.size, 0);

  assert.equal((await facts.permissionsForRoles([])).size, 0);
});

test("production_requirement_status: surfaces material_shortage, qc_hold and pending_approval together", async () => {
  const sql = testClient();
  const productionOrderId = randomUUID();
  const materialId = randomUUID();
  const orderRef = `RAC-TEST-${randomUUID().slice(0, 8)}`;

  await sql`
    insert into production.production_order (production_order_id, status)
    values (${productionOrderId}, 'IN_PROGRESS')`;
  await sql`
    insert into production.production_order_ingredients
      (production_order_id, material_id, required_qty, issued_qty)
    values (${productionOrderId}, ${materialId}, 10, false)`;

  const oilBatchId = randomUUID();
  await sql`
    insert into production.oil_batch_master (oil_batch_id, production_order_id, batch_number, status)
    values (${oilBatchId}, ${productionOrderId}, 'OB-TEST-1', 'ACTIVE')`;
  await sql`
    insert into production.production_qc (oil_batch_id, result, status)
    values (${oilBatchId}, 'HOLD', 'ACTIVE')`;

  const [pr] = await sql`
    insert into procurement.purchase_request (pr_number, status)
    values (${`PR-TEST-${randomUUID().slice(0, 8)}`}, 'OPEN') returning purchase_request_id`;
  await sql`
    insert into procurement.purchase_request_items (purchase_request_id, material_id, required_qty)
    values (${pr!.purchase_request_id}, ${materialId}, 10)`;
  await sql`
    insert into procurement.purchase_request_approval (purchase_request_id, approval_status)
    values (${pr!.purchase_request_id}, 'PENDING')`;

  await sql`
    insert into bridge.production_requirement
      (alembic_requirement_id, org_id, correlation_id, order_ref, mapped_sku, qty, uom,
       needed_by, production_order_id)
    values (${randomUUID()}, ${randomUUID()}, ${randomUUID()}, ${orderRef}, 'FSKU-1', 5, 'kg',
            now() + interval '7 days', ${productionOrderId})`;

  const data = await facts.resolve("production_requirement_status", { orderRef });
  assert.ok(data);
  assert.equal(data!.orderRef, orderRef);
  assert.equal(data!.productionOrderStatus, "IN_PROGRESS");
  const kinds = (data!.blockers as Array<{ kind: string }>).map((b) => b.kind).sort();
  assert.deepEqual(kinds, ["material_shortage", "pending_approval", "qc_hold"]);

  // No formula data in this or any other fact-kind response — the string "formula" never
  // appears anywhere in the payload, the same discipline the controller test proves at the
  // wire level.
  assert.doesNotMatch(JSON.stringify(data), /formula/i);
});

test("production_requirement_status: unknown order ref resolves nothing (NOT_FOUND upstream)", async () => {
  const data = await facts.resolve(
    "production_requirement_status", { orderRef: `no-such-order-${randomUUID()}` });
  assert.equal(data, null);
});

test("material_availability: on-hand minus only ACTIVE reservations", async () => {
  const sql = testClient();
  const materialCode = `MAT-${randomUUID().slice(0, 8)}`;
  const [material] = await sql`
    insert into masterdata.material (material_code, material_name, status)
    values (${materialCode}, 'Facts Test Material', 'ACTIVE') returning material_id`;

  const activeBatchId = randomUUID();
  await sql`
    insert into inventory.inventory_batch (inventory_batch_id, material_id, quantity_on_hand)
    values (${activeBatchId}, ${material!.material_id}, 100)`;
  await sql`
    insert into inventory.stock_reservation (inventory_batch_id, reserved_qty, reserved_dt, released_dt)
    values (${activeBatchId}, 30, now(), null)`;
  // A RELEASED reservation must not reduce availability.
  await sql`
    insert into inventory.stock_reservation (inventory_batch_id, reserved_qty, reserved_dt, released_dt)
    values (${activeBatchId}, 999, now(), now())`;

  const data = await facts.resolve("material_availability", { materialQuery: materialCode.toLowerCase() });
  assert.ok(data);
  const matches = data!.matches as Array<Record<string, unknown>>;
  assert.equal(matches.length, 1);
  assert.equal(Number(matches[0]!.onHandQty), 100);
  assert.equal(Number(matches[0]!.reservedQty), 30);
  assert.equal(Number(matches[0]!.availableQty), 70);
});
