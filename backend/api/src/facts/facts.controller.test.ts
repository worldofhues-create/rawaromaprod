/**
 * FactsController — real Postgres (real FactsService, no mocks), the controller method
 * called directly the way `bridge-config-controller.test.ts` calls `BridgeController.
 * configure()` directly: Nest's decorators are metadata the framework reads at request
 * time, not something a unit test needs re-implemented to exercise the handler body.
 * `req`/`reply` are minimal fakes carrying only the two properties `query()` actually
 * touches (`rawBody`, `status()`) — the same shape of cast `BridgeController.receive`
 * itself uses (`req as unknown as { rawBody?: string }`).
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

async function call(body: unknown, signature: string | undefined) {
  await seedConnector();
  const raw = JSON.stringify(body);
  const { reply, status } = fakeReply();
  const result = await controller.query(fakeReq(raw), reply, {}, signature);
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
  const { result, status } = await call(body, signBody(JSON.stringify(body), "not-the-real-secret"));
  assert.equal(status, 401);
  assert.equal(result.reason, "unauthenticated");
});

test("a Vault/formula-shaped fact kind is FORBIDDEN with a permitted next action, even correctly signed", async () => {
  const body = {
    factKind: "formula_composition",
    params: {},
    caller: { staffId: "s1", roles: ["formulator"] },
  };
  const { result, status } = await call(body, signBody(JSON.stringify(body), SECRET));
  assert.equal(status, 403);
  assert.equal(result.reason, "forbidden");
  assert.match(String(result.permittedNextAction), /vault_approver/);
  // Refusing is not leaking: the boundary text may NAME "formula" (it has to, to explain
  // the refusal) but must never carry a number — no percentage, no ratio, no quantity —
  // which is what an actual composition leak would look like.
  assert.doesNotMatch(JSON.stringify(result), /\d/);
});

test("a caller whose RawProd roles hold nothing is FORBIDDEN, whatever ALEMBIC believes about them", async () => {
  const body = {
    factKind: "production_requirement_status",
    params: { orderRef: "RAC-DOES-NOT-MATTER" },
    caller: { staffId: "s1", roles: [`unmapped-role-${randomUUID()}`] },
  };
  const { result, status } = await call(body, signBody(JSON.stringify(body), SECRET));
  assert.equal(status, 403);
  assert.equal(result.reason, "forbidden");
  assert.match(String(result.boundary), /production:production_order:read/);
});

test("an unknown fact kind is refused as forbidden, not a raw 400/500", async () => {
  const body = { factKind: "something_nobody_registered", params: {}, caller: { staffId: "s1", roles: [] } };
  const { result, status } = await call(body, signBody(JSON.stringify(body), SECRET));
  assert.equal(status, 403);
  assert.equal(result.reason, "forbidden");
});

test("a permitted, signed, known request returns real data and 404s honestly when there is none", async () => {
  const sql = testClient();
  const roleCode = `dispatch-role-${randomUUID()}`;
  const [role] = await sql`
    insert into iam.role_master (role_code, status) values (${roleCode}, 'ACTIVE') returning role_id`;
  const [perm] = await sql`
    insert into iam.permission_master (permission_code, status)
    values ('sales:dispatch_master:read', 'ACTIVE')
    on conflict (permission_code) do update set status = 'ACTIVE'
    returning permission_id`;
  await sql`
    insert into iam.role_permission_mapping (role_id, permission_id, status)
    values (${role!.role_id}, ${perm!.permission_id}, 'ACTIVE')
    on conflict (role_id, permission_id) do nothing`;

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
    caller: { staffId: "s1", roles: [roleCode] },
  };
  const ok = await call(okBody, signBody(JSON.stringify(okBody), SECRET));
  assert.equal(ok.status, undefined); // no explicit status call on the success path -> Nest's default 200/201
  assert.equal(ok.result.ok, true);
  assert.equal((ok.result.data as Record<string, unknown>).soNumber, soNumber);
  // The whole success envelope, scanned as one string, never mentions formula anything.
  assert.doesNotMatch(JSON.stringify(ok.result), /formula/i);

  const missingBody = {
    factKind: "dispatch_status",
    params: { soNumber: `no-such-so-${randomUUID()}` },
    caller: { staffId: "s1", roles: [roleCode] },
  };
  const missing = await call(missingBody, signBody(JSON.stringify(missingBody), SECRET));
  assert.equal(missing.status, 404);
  assert.equal(missing.result.reason, "not_found");
});
