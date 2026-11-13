/**
 * ALEMBIC's `fg.batch.received` receiver, copied VERBATIM (test fixture only) from
 * alembic packages/domain/src/fulfil/contract.ts (lane/prom, PROM-4, PROM-6), from `export interface
 * FgBatchReceived` to the end of `parseFgBatchReceived`. RawProd's tests run the receipt RawProd builds
 * through the receiver's own parser, so "ALEMBIC would accept the lot's label record and promise block" is
 * proved here rather than assumed. The promise block's parser is ALEMBIC's facts.ts, copied verbatim in
 * alembic-prom.ts. If ALEMBIC changes this parser, re-copy it.
 */
/* eslint-disable */
import { parseFgPromiseBlock, type FgPromiseBlock } from './alembic-prom.js';
export interface FgBatchReceived {
  readonly batchNo: string;
  readonly sku: string;
  readonly packSize: string | null;
  /** Exact decimal string as sent ("12.5"), and its milligrams. */
  readonly qtyKg: string;
  readonly qtyMg: number;
  readonly rack: string;
  readonly releasedAt: string;
  /** QC-GATE, optional: the batch number factory QC released under, when it is
   *  not `batchNo`. RawProd releases the compounded batch and names the lot
   *  after the finished-good batch. */
  readonly qcBatchNo: string | null;
  /** Optional: the requirement this batch answers. */
  readonly requirementId: string | null; /** PROM-4, optional: when the factory applied the label carrying this lot (null from an older sender, or no label before the put-away: the lot page says "Not on file"), and whether its server minted the lot at fill (false: typed before PROM-4; null: older sender). One line so no cited line moves. */ readonly labelAppliedAt: string | null; readonly lotAssignedAtFill: boolean | null; /** PROM-6, optional: the process record of the compounded batch this lot was filled from (rest, QC rounds and reference, continuity key, formula version ref), or null from an older sender. */ readonly promise: FgPromiseBlock | null;
}

const KG = /^\d{1,7}(?:\.\d{1,6})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "12.5" kg -> 12500000 mg, with no float in between. */
export function kgStringToMg(kg: string): number {
  const [w, f = ""] = kg.split(".");
  return Number(w) * 1_000_000 + Number((f + "000000").slice(0, 6));
}

/** Structural validation of an inbound `fg.batch.received` payload. */
export function parseFgBatchReceived(raw: unknown):
  { readonly ok: true; readonly fact: FgBatchReceived } | { readonly ok: false; readonly problems: readonly string[] } {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const problems: string[] = [];
  const batchNo = str(r.batch_no);
  if (!batchNo || batchNo.length > 64) problems.push("batch_no is required (at most 64 characters)");
  const sku = str(r.sku);
  if (!sku || sku.length > 64) problems.push("sku is required: the ALEMBIC SKU code");
  const packSize = str(r.pack_size);
  const qtyRaw = typeof r.qty_kg === "number" ? String(r.qty_kg) : str(r.qty_kg);
  if (!qtyRaw || !KG.test(qtyRaw) || kgStringToMg(qtyRaw) <= 0) problems.push("qty_kg must be a positive decimal, e.g. \"12.500\"");
  const rack = str(r.rack);
  if (!rack || rack.length > 40) problems.push("rack is required: the shelf code the batch was put on, e.g. \"R-B3-S2\"");
  const releasedAt = str(r.released_at);
  if (!releasedAt || Number.isNaN(Date.parse(releasedAt))) problems.push("released_at must be a timestamp");
  const req = r.requirement_id === undefined || r.requirement_id === null ? null : str(r.requirement_id);
  if (req !== null && !UUID.test(req)) problems.push("requirement_id, when sent, must be a uuid");
  if (r.requirement_id !== undefined && r.requirement_id !== null && req === null) problems.push("requirement_id, when sent, must be a uuid");
  const qcBatchNo = r.qc_batch_no === undefined || r.qc_batch_no === null ? null : str(r.qc_batch_no);
  if (r.qc_batch_no !== undefined && r.qc_batch_no !== null && (!qcBatchNo || qcBatchNo.length > 64)) {
    problems.push("qc_batch_no, when sent, must be up to 64 characters");
  }
  /* PROM-4: both optional, so a receipt from an older sender parses exactly as before. */
  const labelAppliedAt = r.label_applied_at === undefined || r.label_applied_at === null ? null : str(r.label_applied_at);
  if (r.label_applied_at !== undefined && r.label_applied_at !== null
    && (!labelAppliedAt || !labelAppliedAt.includes("T") || Number.isNaN(Date.parse(labelAppliedAt)))) {
    problems.push("label_applied_at, when sent, must be an ISO instant");
  }
  const lotAssignedAtFill = r.lot_assigned_at_fill === undefined || r.lot_assigned_at_fill === null ? null : r.lot_assigned_at_fill;
  if (lotAssignedAtFill !== null && typeof lotAssignedAtFill !== "boolean") problems.push("lot_assigned_at_fill, when sent, must be true or false");
  /* PROM-6: optional, so an older sender parses as before; when sent it must name the same batch QC released. */
  const promise = parseFgPromiseBlock(r.promise);
  if (!promise.ok) problems.push(...promise.problems);
  else if (promise.block && qcBatchNo && promise.block.oilBatchNo !== qcBatchNo) problems.push("promise.oil_batch_no must be qc_batch_no: one lot, one compounded batch");
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    fact: {
      qcBatchNo,
      batchNo: batchNo as string, sku: sku as string, packSize,
      qtyKg: qtyRaw as string, qtyMg: kgStringToMg(qtyRaw as string),
      rack: rack as string, releasedAt: releasedAt as string, requirementId: req,
      labelAppliedAt, lotAssignedAtFill: lotAssignedAtFill as boolean | null,
      promise: promise.ok ? promise.block : null,
    },
  };
}
