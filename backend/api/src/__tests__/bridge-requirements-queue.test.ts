/**
 * Golden journey lane/j2 — the planner's incoming ALEMBIC-requirements queue
 * (`GET /v1/bridge/requirements`, RequirementsQueueService). Before this, nothing exposed
 * `bridge.production_requirement`, so a planner could not learn the `alembicRequirementId` to
 * link a production order to without SQL. Covers: rows listed oldest need first, the
 * `unlinked` filter drops a requirement a production order already claims, and the route
 * carries a real permission (production:production_order:read).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { ResponseEnvelopeInterceptor } from '@core/backend-kernel';
import { RequirementsQueueService, type BridgeRequirementRow } from '../bridge/requirements-queue.service.js';
import { BridgeController, requirementsQuery } from '../bridge/bridge.controller.js';
import { META_PERMISSIONS } from '../../../backend-kernel/src/decorators/metadata.keys.js';
import { ensureSchema, testClient, closeTestClient } from '../../../test-support/db.js';

let svc: RequirementsQueueService;
const tag = randomUUID().slice(0, 8);

before(async () => {
  await ensureSchema();
  svc = new RequirementsQueueService(testClient());
  const sql = testClient();
  const insert = (orderRef: string, neededBy: string, productionOrderId: string | null) => sql`
    insert into bridge.production_requirement
      (alembic_requirement_id, org_id, correlation_id, order_ref, mapped_sku, qty, uom, needed_by, lifecycle_status, production_order_id)
    values (${randomUUID()}, ${randomUUID()}, ${randomUUID()}, ${orderRef}, 'AVT-1KG', 1000000, 'mg', ${neededBy}, 'ACCEPTED', ${productionOrderId})`;
  await insert(`Q-${tag}-LATE`, '2099-02-01T00:00:00Z', null);
  await insert(`Q-${tag}-EARLY`, '2099-01-01T00:00:00Z', null);
  await insert(`Q-${tag}-LINKED`, '2099-01-15T00:00:00Z', randomUUID());
});
after(async () => {
  // This file's own rows only (every order ref it writes carries its tag): the backlog tests below queue
  // 260+ requirements, which would otherwise sit in front of every later run's rows.
  await testClient()`delete from bridge.production_requirement where order_ref like ${`Q-${tag}-%`}`;
  await closeTestClient();
});

// RC7: the whole queue, page by page (it was the first 200 rows, which on a database holding more than 200
// requirements needed before 2099 did not reach these rows at all -- the bug item 6 fixes).
async function whole(opts: { unlinkedOnly?: boolean } = {}): Promise<BridgeRequirementRow[]> {
  return (await walk({ ...opts, limit: 200 })).flat();
}

test('requirements queue: lists every requirement, oldest need first', async () => {
  const mine = (await whole()).filter((r) => r.orderRef.startsWith(`Q-${tag}`));
  assert.deepEqual(mine.map((r) => r.orderRef), [`Q-${tag}-EARLY`, `Q-${tag}-LINKED`, `Q-${tag}-LATE`]);
  assert.equal(mine[0]!.mappedSku, 'AVT-1KG');
  assert.equal(mine[0]!.uom, 'mg');
});

test('requirements queue: unlinked=true drops a requirement a production order already claims', async () => {
  const mine = (await whole({ unlinkedOnly: true })).filter((r) => r.orderRef.startsWith(`Q-${tag}`));
  assert.deepEqual(mine.map((r) => r.orderRef), [`Q-${tag}-EARLY`, `Q-${tag}-LATE`]);
});

test('requirements queue: the route is permission-gated on production_order:read', () => {
  const perms = new Reflector().get<string[]>(META_PERMISSIONS, BridgeController.prototype.listRequirements);
  assert.deepEqual(perms, ['production:production_order:read']);
});

// ── RC7 item 6: paging + a filter by order. The queue used to return at most 200 rows, oldest need first, with
// neither — so past 200 queued requirements (the live demo) a new one was unreachable from the planner screen.

async function queue(orderRef: string, neededBy: string, n = 1): Promise<void> {
  await testClient()`
    insert into bridge.production_requirement
      (alembic_requirement_id, org_id, correlation_id, order_ref, mapped_sku, qty, uom, needed_by, lifecycle_status)
    select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), ${orderRef}, 'AVT-1KG', 1000, 'mg', ${neededBy}, 'ACCEPTED'
      from generate_series(1, ${n})`;
}

/** Every row the queue serves, walking `nextCursor` page by page exactly as a client would. */
async function walk(opts: { limit: number; orderRef?: string; unlinkedOnly?: boolean }): Promise<BridgeRequirementRow[][]> {
  const pages: BridgeRequirementRow[][] = [];
  let cursor: string | undefined;
  do {
    const page = await svc.page({ ...opts, cursor });
    pages.push(page.items);
    cursor = page.nextCursor ?? undefined;
    assert.ok(pages.length < 10_000, 'the cursor never ran out');
  } while (cursor);
  return pages;
}

test('requirements queue: a new requirement behind 200+ earlier ones is reachable by paging and by its order', async () => {
  const early = `Q-${tag}-BACKLOG`;
  const target = `Q-${tag}-NEW`;
  await queue(early, '1990-01-01T00:00:00Z', 201); // more than a whole max-size page, all needed earlier
  await queue(target, '1990-01-02T00:00:00Z');

  const firstPage = await svc.list({ limit: 200 });
  assert.equal(firstPage.length, 200, 'a page is still capped at 200');
  assert.equal(firstPage.some((r) => r.orderRef === target), false, 'precondition: the new one is past the first page');

  const pages = await walk({ limit: 200 });
  const all = pages.flat();
  assert.ok(all.some((r) => r.orderRef === target), 'paging reaches it');
  assert.equal(new Set(all.map((r) => r.alembicRequirementId)).size, all.length, 'no row served twice across pages');
  for (let i = 1; i < all.length; i++) {
    const [a, b] = [all[i - 1]!, all[i]!];
    assert.ok(new Date(a.neededBy) <= new Date(b.neededBy), `oldest need first across pages (${a.neededBy} then ${b.neededBy})`);
  }

  const byOrder = await svc.page({ orderRef: target });
  assert.deepEqual(byOrder.items.map((r) => r.orderRef), [target], 'the order filter finds it directly');
  assert.equal(byOrder.nextCursor, null);
  const byId = await svc.page({ alembicRequirementId: byOrder.items[0]!.alembicRequirementId });
  assert.deepEqual(byId.items.map((r) => r.alembicRequirementId), [byOrder.items[0]!.alembicRequirementId]);
});

test('requirements queue: pages of one order are disjoint, ordered, and end with a null cursor', async () => {
  const order = `Q-${tag}-PAGED`;
  await queue(order, '2098-05-01T00:00:00Z', 2);
  await queue(order, '2098-04-01T00:00:00Z', 3); // needed sooner, arrived later

  const pages = await walk({ limit: 2, orderRef: order });
  assert.deepEqual(pages.map((p) => p.length), [2, 2, 1]);
  const all = pages.flat();
  assert.equal(new Set(all.map((r) => r.alembicRequirementId)).size, 5);
  assert.deepEqual(all.map((r) => new Date(r.neededBy).toISOString().slice(0, 10)),
    ['2098-04-01', '2098-04-01', '2098-04-01', '2098-05-01', '2098-05-01']);
  // The same order's rows as one page, for comparison: paging changes nothing but the cut points.
  assert.deepEqual(all.map((r) => r.alembicRequirementId), (await svc.list({ orderRef: order, limit: 200 })).map((r) => r.alembicRequirementId));
  // The order filter combines with unlinked=true.
  assert.equal((await svc.list({ orderRef: order, unlinkedOnly: true })).length, 5);
});

test('requirements queue: the default is unchanged -- 50 rows, capped at 200, never fewer than 1', async () => {
  await queue(`Q-${tag}-BULK`, '1990-01-03T00:00:00Z', 60);
  assert.equal((await svc.list()).length, 50);
  assert.equal((await svc.list({ limit: 1000 })).length, 200);
  assert.equal((await svc.list({ limit: 0 })).length, 1);
  await assert.rejects(svc.page({ cursor: randomUUID() }), /cursor does not name a queued requirement/);
});

test('requirements queue route: the standard cursor page, lifted into data + meta.cursor by the envelope', async () => {
  const controller = new BridgeController(null as never, null as never, svc, null as never);
  const order = `Q-${tag}-ROUTE`;
  await queue(order, '2097-01-01T00:00:00Z', 3);
  const query = requirementsQuery.parse({ orderRef: order, limit: '2' });
  const page = await controller.listRequirements(query);
  assert.equal(page.items.length, 2);
  assert.ok(page.nextCursor);

  const ctx = { switchToHttp: () => ({ getRequest: () => ({ requestId: 'rq-1' }) }) } as never;
  const envelope = (await firstValueFrom(new ResponseEnvelopeInterceptor().intercept(ctx, { handle: () => of(page) }))) as {
    data: unknown; meta: { cursor?: string | null };
  };
  assert.deepEqual(envelope.data, page.items, 'data is the rows array, as before');
  assert.equal(envelope.meta.cursor, page.nextCursor, 'meta.cursor is what ?cursor= takes back');

  const next = await controller.listRequirements(requirementsQuery.parse({ orderRef: order, limit: '2', cursor: envelope.meta.cursor }));
  assert.equal(next.items.length, 1);
  assert.equal(next.nextCursor, null);

  // Old query strings still parse: unlinked is only narrowed by 'true', an empty limit is the default.
  assert.deepEqual(requirementsQuery.parse({ unlinked: 'yes', limit: '' }), { unlinked: 'yes', limit: undefined });
  assert.throws(() => requirementsQuery.parse({ cursor: 'not-a-uuid' }));
  assert.throws(() => requirementsQuery.parse({ alembicRequirementId: 'nope' }));
});
