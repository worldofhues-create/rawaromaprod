/**
 * Payables facts toward ALEMBIC (Books phase 2, owner 2026-10-09): a purchase order as issued,
 * amended or cancelled, and a goods receipt -- each carrying its vendor -- so ALEMBIC's Books can
 * match a vendor's bill against the order and what was received (three-way match) without anyone
 * re-typing either. Contract: docs/bridge/PAYABLES_FACTS.md (ALEMBIC repo, mirrored here).
 *
 * Raw cross-schema SQL, the same idiom bridge-emit.ts uses, so this file adds no workspace
 * dependency. Called INSIDE the caller's transaction, beside the recordOutbox it accompanies, so
 * the bridge row commits (or rolls back) with the domain write.
 *
 * PO IDENTITY ACROSS AMENDMENTS: an amendment here creates a NEW purchase_order row that
 * `replacement_of_po_id`-links to the one it replaces. ALEMBIC keys an order by ONE id, so every
 * fact names the ROOT of that chain as `po_id`, and `revision` is the chain depth (1 for the
 * original). Money and quantities go as the numeric(18,4) DECIMAL STRINGS the database holds;
 * ALEMBIC converts them to integers once, at its side of the bridge.
 *
 * NO BANK DETAILS (H-S3): the contract allows `bank_account_number`/`bank_ifsc` on the vendor, but
 * this side never sends them. A vendor's bank account is what a payment goes to; letting a value
 * typed into RawProd silently change where ALEMBIC pays is exactly the redirect-fraud path H-S3
 * warns about. ALEMBIC's Books keep the bank details a person enters (and a second person checks)
 * there. Only identity, tax and contact fields cross.
 *
 * IDEMPOTENCY + DELIVERY: each fact is one bridge.outbox row written in the caller's transaction;
 * its row id is the envelope's `event_id` (relay.service.ts), so a redelivery is deduped by ALEMBIC
 * and a rolled-back domain write never emits. The relay signs it (HMAC, same as every bridge
 * event), retries transient failures with backoff and parks a permanent refusal for replay -- so a
 * fact emitted before ALEMBIC accepts these types waits rather than being lost.
 */
import { sql } from 'drizzle-orm';
import { emitBridgeManualEvent, type BridgeEmitTx } from './bridge-emit.js';

interface VendorRow {
  vendor_id: string; vendor_code: string | null; vendor_name: string | null; gstin: string | null; pan_number: string | null;
  contact_email: string | null; contact_phone: string | null; payment_terms: string | null;
}

async function vendorOf(tx: BridgeEmitTx, vendorId: string): Promise<Record<string, unknown> | null> {
  const rows = (await tx.execute(sql`
    select vendor_id, vendor_code, vendor_name, gstin, pan_number, contact_email, contact_phone,
           payment_terms
      from procurement.vendor_details where vendor_id = ${vendorId}
  `)) as unknown as VendorRow[];
  const v = rows[0];
  if (!v || !v.vendor_code || !v.vendor_name) return null;
  const terms = /(\d{1,3})/.exec(v.payment_terms ?? '');
  const out: Record<string, unknown> = { vendor_id: v.vendor_id, vendor_code: v.vendor_code, vendor_name: v.vendor_name };
  if (v.gstin) { out.gstin = v.gstin; out.state_code = v.gstin.slice(0, 2); }
  if (v.pan_number) out.pan_number = v.pan_number;
  if (v.contact_email) out.email = v.contact_email;
  if (v.contact_phone) out.phone = v.contact_phone;
  if (terms && Number(terms[1]) <= 365) out.payment_terms_days = Number(terms[1]);
  return out;
}

/** The root of a PO's amendment chain and the chain's depth (1 = never amended). */
async function rootOf(tx: BridgeEmitTx, poId: string): Promise<{ rootId: string; revision: number; rootNumber: string | null }> {
  // depth < 1000: a defensive stop should a bad edit ever link the chain into a loop.
  const rows = (await tx.execute(sql`
    with recursive chain(id, prev, depth, po_number) as (
      select purchase_order_id, replacement_of_po_id, 1, po_number from procurement.purchase_order where purchase_order_id = ${poId}
      union all
      select p.purchase_order_id, p.replacement_of_po_id, c.depth + 1, p.po_number
        from procurement.purchase_order p join chain c on p.purchase_order_id = c.prev
       where c.depth < 1000
    )
    select id, depth, po_number from chain order by depth desc limit 1
  `)) as unknown as { id: string; depth: number; po_number: string | null }[];
  const r = rows[0];
  return { rootId: r?.id ?? poId, revision: r ? Number(r.depth) : 1, rootNumber: r?.po_number ?? null };
}

/**
 * Emits procurement.po.issued / procurement.po.amended for `poId` (the row just issued or the new
 * amendment row). Emits NOTHING for a PO whose currency is not INR -- ALEMBIC keeps its books in
 * rupees and refuses a converted figure -- or whose vendor lacks a code or name.
 */
export async function emitPurchaseOrderFact(tx: BridgeEmitTx, type: 'procurement.po.issued' | 'procurement.po.amended',
  poId: string): Promise<void> {
  const head = ((await tx.execute(sql`
    select p.purchase_order_id, p.po_number, p.vendor_id, coalesce(p.order_date, p.created_dt::date)::text as order_date, p.total_amount::text as total_amount,
           p.currency_id, c.currency_code
      from procurement.purchase_order p left join platform.currency_master c on c.currency_id = p.currency_id
     where p.purchase_order_id = ${poId}
  `)) as unknown as { purchase_order_id: string; po_number: string | null; vendor_id: string | null; order_date: string | null;
    total_amount: string | null; currency_id: string | null; currency_code: string | null }[])[0];
  if (!head || !head.vendor_id || !head.po_number || !head.order_date) return;
  // No currency on the order means the organisation's own (rupees). A currency that IS set must
  // resolve to INR: a non-INR order, or one naming a currency row that does not exist, is not sent.
  if (head.currency_id && (head.currency_code ?? '').toUpperCase() !== 'INR') return;
  const vendor = await vendorOf(tx, head.vendor_id);
  if (!vendor) return;
  const lines = (await tx.execute(sql`
    select i.purchase_order_item_id, m.material_code, m.material_name, i.ordered_qty::text as ordered_qty, u.uom_code, i.rate::text as rate
      from procurement.purchase_order_items i
      left join masterdata.material m on m.material_id = i.material_id
      left join platform.uom_master u on u.uom_id = i.uom_id
     where i.purchase_order_id = ${poId}
     order by i.purchase_order_item_id
  `)) as unknown as { purchase_order_item_id: string; material_code: string | null; material_name: string | null;
    ordered_qty: string | null; uom_code: string | null; rate: string | null }[];
  // An amendment row carries its own number (PO-0042-AMD-…); the bill names the ORIGINAL order,
  // so the fact carries the root's number alongside the root's id.
  const { rootId, revision, rootNumber } = await rootOf(tx, poId);
  await emitBridgeManualEvent(tx, type, rootId, {
    po_id: rootId, po_number: rootNumber ?? head.po_number, vendor, order_date: head.order_date, revision, currency: 'INR',
    total_amount: head.total_amount ?? '0',
    lines: lines.map((l) => ({ po_line_id: l.purchase_order_item_id, material_code: l.material_code ?? l.purchase_order_item_id,
      description: l.material_name ?? l.material_code ?? 'material', ordered_qty: l.ordered_qty ?? '0', uom: l.uom_code ?? 'NOS',
      rate: l.rate ?? '0' })),
  });
}

/** Emits procurement.po.cancelled for `poId`. */
export async function emitPurchaseOrderCancelled(tx: BridgeEmitTx, poId: string, reason: string | null): Promise<void> {
  const head = ((await tx.execute(sql`select po_number from procurement.purchase_order where purchase_order_id = ${poId}`)) as unknown as
    { po_number: string | null }[])[0];
  if (!head?.po_number) return;
  const { rootId, revision, rootNumber } = await rootOf(tx, poId);
  await emitBridgeManualEvent(tx, 'procurement.po.cancelled', rootId,
    { po_id: rootId, po_number: rootNumber ?? head.po_number, revision, ...(reason ? { reason: reason.slice(0, 300) } : {}) });
}

/** Emits inventory.grn.created for `grnId`, its order named by the ROOT po id. */
export async function emitGoodsReceiptFact(tx: BridgeEmitTx, grnId: string): Promise<void> {
  const head = ((await tx.execute(sql`
    select grn_id, grn_number, purchase_order_id, vendor_id, coalesce(grn_date, created_dt::date)::text as grn_date from inventory.grn_master where grn_id = ${grnId}
  `)) as unknown as { grn_id: string; grn_number: string | null; purchase_order_id: string | null; vendor_id: string | null;
    grn_date: string | null }[])[0];
  if (!head || !head.vendor_id || !head.grn_number || !head.grn_date) return;
  const vendor = await vendorOf(tx, head.vendor_id);
  if (!vendor) return;
  const lines = (await tx.execute(sql`
    select g.grn_item_id, g.purchase_order_item_id, m.material_code, g.received_qty::text as received_qty,
           g.accepted_qty::text as accepted_qty, g.rejected_qty::text as rejected_qty, u.uom_code
      from inventory.grn_items g
      left join masterdata.material m on m.material_id = g.material_id
      left join platform.uom_master u on u.uom_id = g.uom_id
     where g.grn_id = ${grnId} order by g.grn_item_id
  `)) as unknown as { grn_item_id: string; purchase_order_item_id: string | null; material_code: string | null; received_qty: string | null;
    accepted_qty: string | null; rejected_qty: string | null; uom_code: string | null }[];
  const po = head.purchase_order_id ? (await rootOf(tx, head.purchase_order_id)).rootId : null;
  await emitBridgeManualEvent(tx, 'inventory.grn.created', grnId, {
    grn_id: grnId, grn_number: head.grn_number, ...(po ? { po_id: po } : {}), vendor, grn_date: head.grn_date,
    lines: lines.map((l) => ({ grn_line_id: l.grn_item_id, ...(l.purchase_order_item_id ? { po_line_id: l.purchase_order_item_id } : {}),
      material_code: l.material_code ?? l.grn_item_id, received_qty: l.received_qty ?? '0', accepted_qty: l.accepted_qty ?? '0',
      rejected_qty: l.rejected_qty ?? '0', uom: l.uom_code ?? 'NOS' })),
  });
}
