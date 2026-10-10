/**
 * ALEMBIC Books phase 2 — payables facts toward ALEMBIC (backend-kernel events/payables-facts.ts,
 * contract docs/bridge/PAYABLES_FACTS.md in ALEMBIC). Real Postgres, the real PoService/GrnService
 * flows and the real BridgeRelayService with a stubbed transport:
 *
 *   - issue / amend / cancel / GRN each write ONE bridge.outbox row in the domain transaction,
 *     keyed to the ROOT order (amendments are revision 2+ of the same po_id and po_number);
 *   - INR only: a PO in another currency sends nothing (the PO itself still issues);
 *   - the vendor's bank account and IFSC never cross (H-S3);
 *   - the relay signs the envelope with the aggregate type the contract names, and a fact sent
 *     before ALEMBIC accepts it is retried (transient) or parked for replay (permanent), never lost.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PoService } from '../../../cluster-procurement/src/po/po.service.js';
import { GrnService } from '../../../cluster-inventory/src/grn/grn.service.js';
import { BridgeRelayService } from '../bridge/relay.service.js';
import { OUTBOUND_TO_ALEMBIC } from '../bridge/contract.js';
import { sealSecret } from '../bridge/secret-box.js';
import { verifyBody } from '../bridge/signing.js';
import {
  ensureSchema, procurementDb, inventoryDb, bridgeDb, testClient, principal, closeTestClient,
} from '../../../test-support/db.js';

const SECRET = 'payables-facts-test-secret';
const WEBHOOK = 'https://alembic.example.test/api/v1/bridge/rawprod/webhooks/in';
const CREATOR = '00000000-0000-7000-8000-0000000000c1';
const APPROVER = '00000000-0000-7000-8000-0000000000c2';

let po: PoService;
let grn: GrnService;
let relay: BridgeRelayService;

before(async () => {
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = process.env.BRIDGE_HMAC_KEK ?? randomBytes(32).toString('base64');
  await testClient()`insert into bridge.connector_config (id, enabled, webhook_url, hmac_secret_sealed)
            values ('default', true, ${WEBHOOK}, ${sealSecret(SECRET)})
            on conflict (id) do update set enabled = true, webhook_url = excluded.webhook_url,
                                           hmac_secret_sealed = excluded.hmac_secret_sealed`;
  po = new PoService(procurementDb());
  grn = new GrnService(inventoryDb());
  relay = new BridgeRelayService(bridgeDb());
});

after(async () => { relay?.onModuleDestroy(); await closeTestClient(); });

const tag = () => randomUUID().slice(0, 8).toUpperCase();

async function vendor(): Promise<string> {
  const id = randomUUID();
  const t = tag();
  await testClient()`insert into procurement.vendor_details
      (vendor_id, vendor_code, vendor_name, gstin, pan_number, bank_name, bank_account_number, bank_ifsc,
       contact_email, contact_phone, payment_terms)
    values (${id}, ${'V-' + t}, ${'Acme ' + t}, '27AABCA1234B1Z5', 'AABCA1234B', 'HDFC', '001122334455', 'HDFC0001234',
            'ap@acme.example', '+910000000000', 'Net 30 days')`;
  return id;
}

async function material(): Promise<{ materialId: string; code: string }> {
  const materialId = randomUUID();
  const code = 'HED-' + tag();
  await testClient()`insert into masterdata.material (material_id, material_code, material_name) values (${materialId}, ${code}, 'Hedione')`;
  return { materialId, code };
}

async function uom(): Promise<string> {
  const id = randomUUID();
  await testClient()`insert into platform.uom_master (uom_id, uom_code, uom_name) values (${id}, ${'KG' + tag()}, 'Kilogram')`;
  return id;
}

async function currency(code: string): Promise<string> {
  const r = await testClient()`insert into platform.currency_master (currency_code, currency_name) values (${code}, ${code})
    on conflict (currency_code) do update set currency_name = excluded.currency_name returning currency_id`;
  return r[0]!.currency_id as string;
}

async function issuedPo(opts: { currencyId?: string } = {}) {
  const vendorId = await vendor();
  const m = await material();
  const uomId = await uom();
  const created = await po.createPurchaseOrder({
    vendorId, poNumber: 'PO-' + tag(), orderDate: '2026-10-01', currencyId: opts.currencyId ?? null,
    items: [{ materialId: m.materialId, orderedQty: 25, uomId, rate: 10000, amount: 250000 }],
  }, principal({ userId: CREATOR }));
  const id = created.purchaseOrder.purchaseOrderId;
  await po.approvePurchaseOrder(id, {}, principal({ userId: APPROVER }));
  await po.issuePurchaseOrder(id, principal({ userId: APPROVER }));
  return { id, vendorId, m, uomId, poNumber: created.purchaseOrder.poNumber as string };
}

/** The relay drains 50 due rows per pass, oldest first; in the shared full-run DB other files'
 *  rows (answered 200 by the stub) may sit ahead of ours, so pass until ours has been attempted. */
async function drainUntilAttempted(outboxId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await relay.drain();
    const r = await testClient()`select (o.published_at is not null or d.outbox_id is not null) as done
      from bridge.outbox o left join bridge.outbox_delivery d on d.outbox_id = o.id where o.id = ${outboxId}`;
    if (r[0]!.done) return;
  }
  assert.fail('relay never reached the event');
}

async function facts(type: string, aggregateId: string) {
  return testClient()`select id, payload from bridge.outbox where type = ${type} and aggregate_id = ${aggregateId} order by seq`;
}

test('contract: the four payables facts are outbound types', () => {
  for (const t of ['procurement.po.issued', 'procurement.po.amended', 'procurement.po.cancelled', 'inventory.grn.created']) {
    assert.ok((OUTBOUND_TO_ALEMBIC as readonly string[]).includes(t), t);
  }
});

test('issue: one procurement.po.issued fact, root-keyed, INR decimal strings, vendor without bank details', async () => {
  const { id, vendorId, m, poNumber } = await issuedPo();
  const rows = await facts('procurement.po.issued', id);
  assert.equal(rows.length, 1);
  const p = rows[0]!.payload as Record<string, any>;
  assert.equal(p.po_id, id);
  assert.equal(p.po_number, poNumber);
  assert.equal(p.revision, 1);
  assert.equal(p.currency, 'INR');
  assert.equal(p.order_date, '2026-10-01');
  assert.match(String(p.total_amount), /^250000(\.0+)?$/);
  assert.equal(p.lines.length, 1);
  assert.equal(p.lines[0].material_code, m.code);
  assert.equal(p.lines[0].ordered_qty, '25.0000');
  assert.equal(p.lines[0].rate, '10000.0000');
  assert.equal(p.vendor.vendor_id, vendorId);
  assert.equal(p.vendor.gstin, '27AABCA1234B1Z5');
  assert.equal(p.vendor.state_code, '27');
  assert.equal(p.vendor.payment_terms_days, 30);
  assert.equal(p.vendor.bank_account_number, undefined, 'bank account never crosses (H-S3)');
  assert.equal(p.vendor.bank_ifsc, undefined, 'IFSC never crosses (H-S3)');
  assert.ok(!JSON.stringify(p).includes('001122334455'));
});

test('INR only: a PO in USD issues but sends no fact; an explicit INR currency does', async () => {
  const usd = await issuedPo({ currencyId: await currency('USD') });
  assert.equal((await facts('procurement.po.issued', usd.id)).length, 0);
  const inr = await issuedPo({ currencyId: await currency('INR') });
  assert.equal((await facts('procurement.po.issued', inr.id)).length, 1);
});

test('amend: the new revision is reported as revision 2 of the ROOT order and number', async () => {
  const { id, poNumber } = await issuedPo();
  const amended = await po.amendPurchaseOrder(id, { reason: 'rate revised' }, principal({ userId: CREATOR }));
  assert.notEqual(amended.purchaseOrder.purchaseOrderId, id);
  const rows = await facts('procurement.po.amended', id);
  assert.equal(rows.length, 1, 'keyed to the root, not the amendment row');
  const p = rows[0]!.payload as Record<string, any>;
  assert.equal(p.po_id, id);
  assert.equal(p.po_number, poNumber);
  assert.equal(p.revision, 2);
  assert.equal((await facts('procurement.po.amended', amended.purchaseOrder.purchaseOrderId)).length, 0);
});

test('cancel: procurement.po.cancelled with the reason; a rolled-back cancel emits nothing', async () => {
  const { id } = await issuedPo();
  await po.cancelPurchaseOrder(id, { reason: 'vendor withdrew' }, principal({ userId: CREATOR }));
  const rows = await facts('procurement.po.cancelled', id);
  assert.equal(rows.length, 1);
  const p = rows[0]!.payload as Record<string, any>;
  assert.equal(p.po_id, id);
  assert.equal(p.revision, 1);
  assert.equal(p.reason, 'vendor withdrew');
  await assert.rejects(() => po.cancelPurchaseOrder(id, { reason: 'again' }, principal({ userId: CREATOR })));
  assert.equal((await facts('procurement.po.cancelled', id)).length, 1, 'a refused cancel adds no fact');
});

test('GRN: inventory.grn.created names the root order, its lines and accepted quantities', async () => {
  const { id, vendorId, m, uomId } = await issuedPo();
  const lineId = ((await testClient()`select purchase_order_item_id from procurement.purchase_order_items
    where purchase_order_id = ${id}`)[0]!.purchase_order_item_id) as string;
  const r = await grn.createGrn({
    purchaseOrderId: id, vendorId, grnDate: '2026-10-03',
    items: [{ purchaseOrderItemId: lineId, materialId: m.materialId, uomId, receivedQty: 25, acceptedQty: 24, rejectedQty: 1, containers: [] }],
  } as never, principal({ userId: CREATOR }));
  const grnId = r.grn.grnId;
  const rows = await facts('inventory.grn.created', grnId);
  assert.equal(rows.length, 1);
  const p = rows[0]!.payload as Record<string, any>;
  assert.equal(p.grn_id, grnId);
  assert.equal(p.po_id, id);
  assert.equal(p.grn_date, '2026-10-03');
  assert.equal(p.vendor.bank_account_number, undefined);
  assert.equal(p.lines.length, 1);
  assert.equal(p.lines[0].po_line_id, lineId);
  assert.equal(Number(p.lines[0].accepted_qty), 24);
  assert.equal(Number(p.lines[0].rejected_qty), 1);
});

test('relay: signed envelope with the contract aggregate type; event_id is the outbox id (idempotent)', async () => {
  const { id } = await issuedPo();
  const outboxId = (await facts('procurement.po.issued', id))[0]!.id as string;
  const seen: Record<string, any>[] = [];
  relay.fetchImpl = async (_url, init) => {
    const body = String(init?.body ?? '');
    assert.ok(verifyBody(body, SECRET, (init?.headers as Record<string, string>)['x-bridge-signature']), 'signed');
    const env = JSON.parse(body);
    if (env.event_id === outboxId) seen.push(env);
    return new Response('{"outcome":"applied"}', { status: 200 });
  };
  await drainUntilAttempted(outboxId);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.type, 'procurement.po.issued');
  assert.deepEqual(seen[0]!.aggregate, { type: 'purchase_order', id });
  assert.equal(seen[0]!.source, 'rawprod');
  const pub = await testClient()`select published_at from bridge.outbox where id = ${outboxId}`;
  assert.ok(pub[0]!.published_at, 'delivered once, then marked published');
});

test('relay: ALEMBIC not yet deployed — a 404/503 backs off and the fact stays queued for retry', async () => {
  const { id } = await issuedPo();
  const outboxId = (await facts('procurement.po.issued', id))[0]!.id as string;
  relay.fetchImpl = async (_url, init) => {
    const env = JSON.parse(String(init?.body ?? ''));
    return env.event_id === outboxId ? new Response('not here', { status: 503 })
      : new Response('{"outcome":"applied"}', { status: 200 });
  };
  await drainUntilAttempted(outboxId);
  const d = (await testClient()`select d.attempts, d.parked_at, d.next_attempt_at > now() as backed_off, o.published_at
    from bridge.outbox o join bridge.outbox_delivery d on d.outbox_id = o.id where o.id = ${outboxId}`)[0]!;
  assert.equal(d.attempts, 1);
  assert.equal(d.parked_at, null);
  assert.equal(d.backed_off, true);
  assert.equal(d.published_at, null);
});
