/**
 * FactsController — real Postgres (real FactsService, no mocks), the controller method
 * called directly the way `bridge-config-controller.test.ts` calls `BridgeController.
 * configure()` directly: Nest's decorators are metadata the framework reads at request
 * time, not something a unit test needs re-implemented to exercise the handler body.
 * `req`/`reply` are minimal fakes carrying only the two properties `query()` actually
 * touches (`rawBody`, `status()`) — the same shape of cast `BridgeController.receive`
 * itself uses (`req as unknown as { rawBody?: string }`).
 *
 * S3 security review item 5: the signed material is now `${timestamp}.${nonce}.${rawBody}`
 * (see `FactsService.verifySignature`), and authorization is resolved from `caller.staffId`
 * against RawProd's own grants (`user_master.alembic_subject` -> role -> permission), never
 * from `caller.roles` in the body — every test that used to seed a role keyed off an arbitrary
 * `caller.roles` string now binds a real `user_master` row via `alembic_subject` instead.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ensureSchema, testClient, bridgeDb, closeTestClient } from "../../../test-support/db.js";
import { sealSecret } from "../bridge/secret-box.js";
import { signBody } from "../bridge/signing.js";
import { FactsController } from "./facts.controller.js";
import { FactsService } from "./facts.service.js";

const SECRET = "facts-controller-test-secret";
const kekPrior = process.env.BRIDGE_HMAC_KEK;
let controller: FactsController;

/* Re-seals and re-writes the ONE `bridge.connector_config` row ('default' — the same
   singleton row `facts.service.test.ts` and RawProd's own admin console write) immediately
   before every call in this file, rather than once in `before()`. `node --test` isolates
   each *.test.ts FILE in its own process (so `BRIDGE_HMAC_KEK` here never leaks to or from
   another file), but every process still shares the one Postgres row — reseeding right
   before each use is what keeps this file correct however the other file's process
   interleaves its own writes to that row. */
async function seedConnector(): Promise<void> {
  const sql = testClient();
  await sql`
    insert into bridge.connector_config (id, enabled, hmac_secret_sealed, configured_by)
    values ('default', true, ${sealSecret(SECRET)}, 'test')
    on conflict (id) do update set enabled = true, hmac_secret_sealed = ${sealSecret(SECRET)}`;
}

/** Binds a fresh ALEMBIC subject to a real, ACTIVE `iam.user_master` row — optionally holding
 *  one role/permission pair — so a test can prove RawProd resolves authority from ITS OWN
 *  grants (via `alembic_subject`), never from the body's `caller.roles`. Returns the subject
 *  string to put in `caller.staffId`. */
async function makeBoundCaller(opts: { roleCode?: string; permissionCode?: string } = {}): Promise<string> {
  const sql = testClient();
  const staffId = `staff:facts-${randomUUID()}@rawaroma.local`;
  const userId = randomUUID();
  await sql`
    insert into iam.user_master (user_id, email, user_name, is_active, status, alembic_subject)
    values (${userId}, ${`${staffId}-email@rawaroma.local`}, 'Facts Test User', true, 'ACTIVE', ${staffId})`;
  if (opts.roleCode) {
    const [role] = await sql`
      insert into iam.role_master (role_code, status) values (${opts.roleCode}, 'ACTIVE') returning role_id`;
    await sql`
      insert into iam.user_role_mapping (user_id, role_id, status) values (${userId}, ${role!.role_id}, 'ACTIVE')`;
    if (opts.permissionCode) {
      const [perm] = await sql`
        insert into iam.permission_master (permission_code, status)
        values (${opts.permissionCode}, 'ACTIVE')
        on conflict (permission_code) do update set status = 'ACTIVE'
        returning permission_id`;
      await sql`
        insert into iam.role_permission_mapping (role_id, permission_id, status)
        values (${role!.role_id}, ${perm!.permission_id}, 'ACTIVE')
        on conflict (role_id, permission_id) do nothing`;
    }
  }
  return staffId;
}

before(async () => {
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = Buffer.alloc(32, 3).toString("base64");
  await seedConnector();
  controller = new FactsController(new FactsService(testClient(), bridgeDb()));
});

after(async () => {
  if (kekPrior === undefined) delete process.env.BRIDGE_HMAC_KEK;
  else process.env.BRIDGE_HMAC_KEK = kekPrior;
  await closeTestClient();
});

function fakeReq(rawBody: string): FastifyRequest {
  return { rawBody } as unknown as FastifyRequest;
}

function fakeReply(): { reply: FastifyReply; status: () => number | undefined } {
  let code: number | undefined;
  const reply = {
    status(c: number) { code = c; return reply; },
  } as unknown as FastifyReply;
  return { reply, status: () => code };
}

/** Signs `rawBody` the way `rawprod-facts-client.ts` now does — over `timestamp.nonce.body` —
 *  and returns the three headers `FactsController.query` reads. `secret` may deliberately be
 *  the WRONG one (a test proving a bad signature is refused); `timestamp`/`nonce` are always
 *  freshly generated so no two calls in this file ever collide on nonce replay by accident. */
function signedHeaders(rawBody: string, secret: string): { signature: string; timestamp: string; nonce: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  return { signature: signBody(`${timestamp}.${nonce}.${rawBody}`, secret), timestamp, nonce };
}

async function call(body: unknown, secret: string | undefined) {
  await seedConnector();
  const raw = JSON.stringify(body);
  const { reply, status } = fakeReply();
  const headers = secret ? signedHeaders(raw, secret) : undefined;
  const result = await controller.query(
    fakeReq(raw), reply, {}, headers?.signature, headers?.timestamp, headers?.nonce,
  );
  return { result, status: status() };
}

test("an unsigned request is refused before anything is read", async () => {
  const { result, status } = await call(
    { factKind: "production_requirement_status", params: {}, caller: { staffId: "s1", roles: [] } },
    undefined,
  );
  assert.equal(status, 401);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unauthenticated");
});

test("a wrongly signed request is refused the same way as an absent one", async () => {
  const body = { factKind: "production_requirement_status", params: {}, caller: { staffId: "s1", roles: [] } };
  const { result, status } = await call(body, "not-the-real-secret");
  assert.equal(status, 401);
  assert.equal(result.reason, "unauthenticated");
});

test("S3 item 5: a REPLAYED nonce is refused even though the signature itself is perfectly valid", async () => {
  await seedConnector();
  const body = { factKind: "production_requirement_status", params: {}, caller: { staffId: "s1", roles: [] } };
  const raw = JSON.stringify(body);
  const headers = signedHeaders(raw, SECRET);

  const first = await controller.query(fakeReq(raw), fakeReply().reply, {}, headers.signature, headers.timestamp, headers.nonce);
  assert.notEqual(first.reason, "unauthenticated");

  const { reply: reply2, status: status2 } = fakeReply();
  // Same body, same signature, same timestamp+nonce — a byte-for-byte replay.
  const second = await controller.query(fakeReq(raw), reply2, {}, headers.signature, headers.timestamp, headers.nonce);
  assert.equal(status2(), 401);
  assert.equal(second.reason, "unauthenticated");
});

test("S3 item 5: a stale timestamp (beyond the 300s window) is refused even with a valid signature otherwise", async () => {
  await seedConnector();
  const body = { factKind: "production_requirement_status", params: {}, caller: { staffId: "s1", roles: [] } };
  const raw = JSON.stringify(body);
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600);
  const nonce = randomUUID();
  const signature = signBody(`${staleTimestamp}.${nonce}.${raw}`, SECRET);

  const { reply, status } = fakeReply();
  const result = await controller.query(fakeReq(raw), reply, {}, signature, staleTimestamp, nonce);
  assert.equal(status(), 401);
  assert.equal(result.reason, "unauthenticated");
});

test("a Vault/formula-shaped fact kind is FORBIDDEN with a permitted next action, even correctly signed", async () => {
  const body = {
    factKind: "formula_composition",
    params: {},
    caller: { staffId: "s1", roles: ["formulator"] },
  };
  const { result, status } = await call(body, SECRET);
  assert.equal(status, 403);
  assert.equal(result.reason, "forbidden");
  assert.match(String(result.permittedNextAction), /vault_approver/);
  // Refusing is not leaking: the boundary text may NAME "formula" (it has to, to explain
  // the refusal) but must never carry a number — no percentage, no ratio, no quantity —
  // which is what an actual composition leak would look like.
  assert.doesNotMatch(JSON.stringify(result), /\d/);
});

test("a caller bound to NO RawProd user is FORBIDDEN, whatever ALEMBIC's body claims about roles", async () => {
  const body = {
    factKind: "production_requirement_status",
    params: { orderRef: "RAC-DOES-NOT-MATTER" },
    // staffId names nobody on the RawProd side; roles here must carry NO authority at all.
    caller: { staffId: `staff:unbound-${randomUUID()}@rawaroma.local`, roles: ["owner", "admin"] },
  };
  const { result, status } = await call(body, SECRET);
  assert.equal(status, 403);
  assert.equal(result.reason, "forbidden");
  assert.match(String(result.boundary), /production:production_order:read/);
});

test("S3 item 5: a caller BOUND to a RawProd user whose real roles hold nothing is still FORBIDDEN", async () => {
  const staffId = await makeBoundCaller(); // bound, but no role at all
  const body = {
    factKind: "production_requirement_status",
    params: { orderRef: "RAC-DOES-NOT-MATTER" },
    // The body LIES about roles — this must have zero effect on the outcome.
    caller: { staffId, roles: ["owner", "admin", "platform_super_admin"] },
  };
  const { result, status } = await call(body, SECRET);
  assert.equal(status, 403);
  assert.equal(result.reason, "forbidden");
});

test("an unknown fact kind is refused as forbidden, not a raw 400/500", async () => {
  const body = { factKind: "something_nobody_registered", params: {}, caller: { staffId: "s1", roles: [] } };
  const { result, status } = await call(body, SECRET);
  assert.equal(status, 403);
  assert.equal(result.reason, "forbidden");
});

test("S3 item 5: a permitted, signed, known request returns real data — authority resolved from "
  + "RawProd's OWN grants via alembic_subject, and 404s honestly when there is none", async () => {
  const sql = testClient();
  const staffId = await makeBoundCaller({
    roleCode: `dispatch-role-${randomUUID()}`,
    permissionCode: "sales:dispatch_master:read",
  });

  const soNumber = `SO-TEST-${randomUUID().slice(0, 8)}`;
  const [so] = await sql`
    insert into sales.sales_order (so_number, status) values (${soNumber}, 'CONFIRMED')
    returning sales_order_id`;
  await sql`
    insert into sales.dispatch_master (dispatch_id, sales_order_id, status)
    values (${randomUUID()}, ${so!.sales_order_id}, 'DISPATCHED')`;

  const okBody = {
    factKind: "dispatch_status",
    params: { soNumber },
    // The body's roles claim NOTHING useful — real authority comes from the bound user's grant.
    caller: { staffId, roles: [] },
  };
  const ok = await call(okBody, SECRET);
  assert.equal(ok.status, undefined); // no explicit status call on the success path -> Nest's default 200/201
  assert.equal(ok.result.ok, true);
  assert.equal((ok.result.data as Record<string, unknown>).soNumber, soNumber);
  // The whole success envelope, scanned as one string, never mentions formula anything.
  assert.doesNotMatch(JSON.stringify(ok.result), /formula/i);

  const missingBody = {
    factKind: "dispatch_status",
    params: { soNumber: `no-such-so-${randomUUID()}` },
    caller: { staffId, roles: [] },
  };
  const missing = await call(missingBody, SECRET);
  assert.equal(missing.status, 404);
  assert.equal(missing.result.reason, "not_found");
});

test("S3 item 5: a SUSPENDED bound user resolves to no permissions, even holding a valid role", async () => {
  const sql = testClient();
  const staffId = await makeBoundCaller({
    roleCode: `susp-role-${randomUUID().slice(0, 8)}`,
    permissionCode: "sales:dispatch_master:read",
  });
  await sql`update iam.user_master set status = 'SUSPENDED' where alembic_subject = ${staffId}`;

  const body = {
    factKind: "dispatch_status",
    params: { soNumber: "SO-WHATEVER" },
    caller: { staffId, roles: [] },
  };
  const { result, status } = await call(body, SECRET);
  assert.equal(status, 403);
  assert.equal(result.reason, "forbidden");
});

/* OPS-GREEN §16 (lane ARIA): the four new operating fact kinds are re-checked against RawProd's
   OWN grants exactly like the seven before them — a bound caller without the permission gets
   403, one holding it gets the data. */
test("OPS-GREEN: factory_status / po_late / batch_quarantine / production_blockers enforce their permission", async () => {
  const cases = [
    ["factory_status", "production:production_order:read", {}],
    ["production_blockers", "production:production_order:read", {}],
    ["po_late", "procurement:purchase_order:read", {}],
    ["batch_quarantine", "quality:qc_inspections:read", { batchNumber: `NOPE-${randomUUID().slice(0, 6)}` }],
  ] as const;
  for (const [factKind, permissionCode, params] of cases) {
    const denied = await makeBoundCaller({ roleCode: `og-none-${randomUUID()}` });
    const refused = await call({ factKind, params, caller: { staffId: denied, roles: ["admin"] } }, SECRET);
    assert.equal(refused.status, 403, `${factKind} without ${permissionCode}`);
    assert.match(String(refused.result.boundary), new RegExp(permissionCode));

    const allowed = await makeBoundCaller({ roleCode: `og-${randomUUID()}`, permissionCode });
    const ok = await call({ factKind, params, caller: { staffId: allowed, roles: [] } }, SECRET);
    if (factKind === "batch_quarantine") {
      assert.equal(ok.status, 404, "an unknown batch is not_found, never an invented reason");
      assert.equal(ok.result.reason, "not_found");
    } else {
      assert.equal(ok.result.ok, true, factKind);
    }
  }
});
