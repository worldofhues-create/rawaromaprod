/**
 * FLOOR-1 (R8) — lot split and partial return (production-floor plan §6 Verifier, §13).
 *
 *   split    A lot splits across two bins: part of it goes to another bin as a CHILD lot.
 *   return   The verifier's leftover goes back to stock as a partial lot: a child lot too, tied to the
 *            job it came back from.
 *
 * Both make exactly one child: a new inventory.inventory_batch row with its own opaque L- code. The
 * child keeps the parent's RM batch, so its lot number, QC release, hold and expiry are the parent's:
 * FEFO sorts it by the parent's date and a recall of the RM lot finds it. Nothing is re-dated here.
 *
 * The stock ledger balances to the milligram. Two inventory_transaction rows per split (the parent
 * minus, the child plus, both referencing the split) sum to zero, and parent-before = parent-after +
 * child. Quantities are integer mg; a quantity the lot's unit cannot hold exactly (numeric(18,4) of
 * kg holds 0.1 g) is refused, never rounded. What the job's material issue has not debited yet is
 * already spoken for, so it can be neither split nor returned.
 *
 * The child prints its own label (both codes of its L- id, the colour name and initial, the parent
 * it came from, the hazard line from sourced data only). The first print is logged; every later one
 * is a REPRINT with a reason and the person. The genealogy reads both ways: a child names its parent
 * chain, a parent lists its children; a batch_genealogy_history row keeps the RM lot's trail.
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { FloorCodeService, HAZARD_PENDING, LOT_BARCODE_RE, qtyToMg } from './floor-code.service.js';
import { scanCode } from './scan-code.js';

export type SplitKind = 'SPLIT' | 'RETURN';
type Q = Sql | TransactionSql;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function unitFactor(uomCode: string | null): number | null {
  const u = String(uomCode ?? '').trim().toLowerCase();
  return ['kg', 'kgs', 'kilogram', 'kilograms'].includes(u) ? 1_000_000
    : ['g', 'gm', 'gms', 'gram', 'grams'].includes(u) ? 1_000
      : ['mg', 'milligram', 'milligrams'].includes(u) ? 1 : null;
}

/** Integer mg -> the exact numeric(18,4) text in the lot's own unit, or null when that unit cannot hold it exactly. */
export function mgToQty(mg: number, uomCode: string | null): string | null {
  const f = unitFactor(uomCode);
  if (f === null || !Number.isSafeInteger(mg) || mg < 0) return null;
  const scaled = BigInt(mg) * 10000n;
  if (scaled % BigInt(f) !== 0n) return null;
  const t = scaled / BigInt(f);
  return `${t / 10000n}.${String(t % 10000n).padStart(4, '0')}`;
}

/** mg as grams for a message: trailing zeros trimmed ("874.5 g"). */
export function gramsText(mg: number): string {
  const s = `${Math.floor(mg / 1000)}.${String(mg % 1000).padStart(3, '0')}`.replace(/\.?0+$/, '');
  return `${s} g`;
}

interface LotRow {
  inventory_batch_id: string; rm_batch_id: string | null; material_id: string | null; storage_location_id: string | null;
  inventory_status_id: string | null; status: string | null; qty: string | null; uom_id: string | null; uom_code: string | null;
  batch_number: string | null; expiry_date: string | null; bin_code: string | null;
}

export interface ChildLabel {
  lotLabelId: string; kind: SplitKind; reprint: boolean; reason: string | null; barcode: string; splitFrom: string | null;
  jobNo: string | null; lot: string | null; floorCode: string | null; colourName: string | null; colourHex: string | null; initial: string | null;
  bin: string | null; qtyMg: number | null; expiry: string | null; hazard: string; person: string; printedDt: string;
}

@Injectable()
export class LotSplitService {
  /** Injectable for tests: the 7 barcode characters. */
  drawBarcode: () => string = () => {
    const b = randomBytes(7);
    let s = '';
    for (let i = 0; i < 7; i++) s += CROCKFORD[b[i]! % 32];
    return `L-${s}`;
  };

  constructor(@Inject(PG_CLIENT) private readonly sql: Sql, private readonly codes: FloorCodeService) {}

  /* ── lookups ─────────────────────────────────────────────────────────────────────────── */

  private code(raw: unknown): string {
    const v = scanCode(raw).toUpperCase(); // SCAN-3: AIM prefixes and suffixes off
    if (!LOT_BARCODE_RE.test(v)) throw new BadRequestException('Scan the lot label (L- and seven characters).');
    return v;
  }

  private async lotByCode(q: Q, barcode: string, lock: boolean): Promise<LotRow> {
    const rows = lock
      ? await q<LotRow[]>`
          select ib.inventory_batch_id::text, ib.rm_batch_id::text, ib.material_id::text, ib.storage_location_id::text, ib.inventory_status_id::text,
                 ib.status, ib.quantity_on_hand::text as qty, ib.uom_id::text, null::text as uom_code, null::text as batch_number, null::text as expiry_date, null::text as bin_code
            from inventory.lot_barcode lb join inventory.inventory_batch ib on ib.inventory_batch_id = lb.inventory_batch_id
           where lb.barcode = ${barcode} for update of ib`
      : [];
    const [r] = await q<LotRow[]>`
      select ib.inventory_batch_id::text, ib.rm_batch_id::text, ib.material_id::text, ib.storage_location_id::text, ib.inventory_status_id::text,
             ib.status, ib.quantity_on_hand::text as qty, ib.uom_id::text, u.uom_code, rb.batch_number, rb.expiry_date::text, b.bin_code
        from inventory.lot_barcode lb
        join inventory.inventory_batch ib on ib.inventory_batch_id = lb.inventory_batch_id
        left join platform.uom_master u on u.uom_id = ib.uom_id
        left join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
        left join location.bin_master b on b.bin_id = ib.storage_location_id
       where lb.barcode = ${barcode}`;
    if (!r || (lock && !rows.length)) throw new NotFoundException('That lot label is not known here.');
    return r;
  }

  private async binByCode(q: Q, raw: unknown): Promise<{ id: string; code: string }> {
    const v = scanCode(raw);
    if (!v) throw new BadRequestException('Scan the bin the new lot goes to.');
    const [b] = await q<{ id: string; code: string }[]>`select bin_id::text as id, bin_code as code from location.bin_master where upper(bin_code) = upper(${v}) limit 1`;
    if (!b) throw new NotFoundException(`No bin ${v} on file.`);
    return b;
  }

  /** What the job's material issues will still take from this lot (raised, not yet debited), in mg. */
  private async pendingMg(q: Q, inventoryBatchId: string): Promise<number> {
    const rows = await q<{ qty: string | null; uom_code: string | null }[]>`
      select mpli.picked_qty::text as qty, u.uom_code
        from production.material_issue mi
        join production.material_issue_item mii on mii.material_issue_id = mi.material_issue_id
        left join production.material_pick_list_items mpli on mpli.material_pick_list_id = mi.material_pick_list_id and mpli.material_id = mii.material_id
        left join platform.uom_master u on u.uom_id = mpli.uom_id
       where mii.inventory_batch_id = ${inventoryBatchId}
         and not exists (select 1 from inventory.material_issue_applied a where a.material_issue_id = mi.material_issue_id)`;
    let mg = 0;
    for (const r of rows) {
      const v = qtyToMg(r.qty, r.uom_code);
      if (v === null) throw new ConflictException('An issue against this lot is in a unit that is not a weight, so what is left cannot be worked out. Ask the supervisor.');
      mg += v;
    }
    return mg;
  }

  private async person(q: Q, userId: string): Promise<string> {
    const [u] = await q<{ user_name: string | null; email: string | null }[]>`select user_name, email from iam.user_master where user_id::text = ${userId}`;
    return u?.user_name ?? u?.email ?? userId;
  }

  private async mintIn(tx: TransactionSql, inventoryBatchId: string, by: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = this.drawBarcode();
      const rows = await tx`insert into inventory.lot_barcode (barcode, inventory_batch_id, created_by) values (${code}, ${inventoryBatchId}, ${by})
                            on conflict do nothing returning barcode`;
      if (rows.length) return code;
    }
    throw new ConflictException('Could not mint a lot code. Try again.');
  }

  /* ── split / return ──────────────────────────────────────────────────────────────────── */

  async split(rawCode: unknown, body: { qtyMg?: unknown; bin?: unknown; reason?: unknown }, principal: AuthPrincipal) {
    const barcode = this.code(rawCode);
    return this.sql.begin((tx) => this.cut(tx, 'SPLIT', barcode, body, null, null, principal));
  }

  async returnLeftover(jobId: string, body: { lot?: unknown; qtyMg?: unknown; bin?: unknown }, principal: AuthPrincipal) {
    const barcode = this.code(body.lot);
    return this.sql.begin(async (tx) => {
      const [j] = await tx<{ floor_job_id: string; job_no: string; stage: string; picked_by: string | null }[]>`
        select floor_job_id::text, job_no, stage, picked_by from production.floor_job where floor_job_id = ${jobId} for update`;
      if (!j) throw new NotFoundException('No such floor job.');
      if (j.stage === 'PICK') throw new ConflictException(`${j.job_no} has not been picked yet: nothing has come back from it.`);
      const lines = await tx<{ picked_batch_id: string | null; picked_by: string | null }[]>`
        select picked_batch_id::text, picked_by from production.floor_line where floor_job_id = ${jobId}`;
      const [lb] = await tx<{ inventory_batch_id: string }[]>`select inventory_batch_id::text from inventory.lot_barcode where barcode = ${barcode}`;
      if (!lb) throw new NotFoundException('That lot label is not known here.');
      if (!lines.some((l) => l.picked_batch_id === lb.inventory_batch_id)) throw new BadRequestException(`That lot was not picked on this job (${j.job_no}). Only what the tote brought can go back from here.`);
      if (j.picked_by === principal.userId || lines.some((l) => l.picked_by === principal.userId)) {
        throw new ForbiddenException('You picked this job, so someone else must take the leftover back.');
      }
      return this.cut(tx, 'RETURN', barcode, body, jobId, j.job_no, principal);
    });
  }

  private async cut(tx: TransactionSql, kind: SplitKind, barcode: string, body: { qtyMg?: unknown; bin?: unknown; reason?: unknown }, jobId: string | null, jobNo: string | null, principal: AuthPrincipal) {
    const qtyMg = Number(body.qtyMg);
    if (!Number.isSafeInteger(qtyMg) || qtyMg <= 0) throw new BadRequestException('Say how much goes into the new lot (a weight above zero, to the mg).');
    const p = await this.lotByCode(tx, barcode, true);
    if (!p.rm_batch_id) throw new ConflictException('This stock row has no raw lot behind it (no QC result, no lot number to recall by), so it is not split.');
    const [held] = await tx`select 1 from inventory.lot_hold where subject_type = 'RM_LOT' and subject_id = ${p.rm_batch_id} and released_dt is null`;
    if (held) throw new ConflictException('This lot is on hold: it is not split or moved until QC lifts the hold.');
    const bookMg = qtyToMg(p.qty, p.uom_code);
    if (bookMg === null) throw new ConflictException('This lot is not kept in a weight unit (g, kg, mg), so it cannot be split by weight.');
    const f = unitFactor(p.uom_code)!;
    if (mgToQty(qtyMg, p.uom_code) === null) {
      const step = f / 10000;
      throw new BadRequestException(`This lot is kept in ${p.uom_code} to ${gramsText(step)}: enter a multiple of ${gramsText(step)}.`);
    }
    const pending = await this.pendingMg(tx, p.inventory_batch_id);
    const free = bookMg - pending;
    if (kind === 'SPLIT') {
      if (qtyMg > free) throw new ConflictException(`That lot holds only ${gramsText(Math.max(free, 0))}${pending ? ` free (${gramsText(pending)} is still to be issued)` : ''}.`);
      if (qtyMg === free) throw new ConflictException('That is the whole lot: move it to the other bin instead of splitting it.');
    } else if (qtyMg > free) {
      throw new ConflictException(`At most ${gramsText(Math.max(free, 0))} can come back: the lot holds ${gramsText(bookMg)} and the job's issue still takes ${gramsText(pending)}. Weigh the leftover again.`);
    }
    const to = await this.binByCode(tx, body.bin);
    if (to.id === p.storage_location_id) throw new BadRequestException(`The lot is already in ${to.code}: scan the bin the new part goes to.`);
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 300) : null;

    const childId = uuidv7(), splitId = uuidv7(), qty = mgToQty(qtyMg, p.uom_code)!, minus = `-${qty}`;
    await tx`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, inventory_status_id, quantity_on_hand, uom_id, status, created_by, updated_by)
             values (${childId}, ${p.rm_batch_id}, ${p.material_id}, ${to.id}, ${p.inventory_status_id}, ${qty}, ${p.uom_id}, ${p.status ?? 'ACTIVE'}, ${principal.userId}, ${principal.userId})`;
    await tx`update inventory.inventory_batch set quantity_on_hand = quantity_on_hand - ${qty}::numeric, updated_dt = now(), updated_by = ${principal.userId}
              where inventory_batch_id = ${p.inventory_batch_id}`;
    await tx`insert into inventory.lot_split (lot_split_id, kind, parent_inventory_batch_id, child_inventory_batch_id, rm_batch_id, qty_mg, parent_before_mg,
               from_location_id, to_location_id, floor_job_id, reason, created_by)
             values (${splitId}, ${kind}, ${p.inventory_batch_id}, ${childId}, ${p.rm_batch_id}, ${qtyMg}, ${bookMg}, ${p.storage_location_id}, ${to.id}, ${jobId}, ${reason}, ${principal.userId})`;
    const ev = kind === 'SPLIT' ? 'LOT_SPLIT' : 'LOT_RETURN';
    for (const [batch, q, side] of [[p.inventory_batch_id, minus, 'OUT'], [childId, qty, 'IN']] as const) {
      const txnId = uuidv7();
      await tx`insert into inventory.inventory_transaction (inventory_transaction_id, inventory_batch_id, transaction_qty, uom_id, from_location_id, to_location_id,
                 transaction_dt, reference_document_id, status, created_by, updated_by)
               values (${txnId}, ${batch}, ${q}, ${p.uom_id}, ${p.storage_location_id}, ${to.id}, now(), ${splitId}, 'ACTIVE', ${principal.userId}, ${principal.userId})`;
      await tx`insert into inventory.inventory_event_history (inventory_batch_id, event_type, event_dt, inventory_transaction_id, reference_document_id, reference_document_type,
                 event_qty, performed_by, remarks, status, created_by, updated_by)
               values (${batch}, ${`${ev}_${side}`}, now(), ${txnId}, ${splitId}, 'LOT_SPLIT', ${qty}, ${principal.userId},
                 ${`${side === 'OUT' ? 'to' : 'from'} ${side === 'OUT' ? 'child' : 'parent'} lot, ${gramsText(qtyMg)}${jobNo ? `, back from ${jobNo}` : ''}`}, 'ACTIVE', ${principal.userId}, ${principal.userId})`;
    }
    await tx`insert into inventory.batch_genealogy_history (rm_batch_id, relationship_type, recorded_dt, status, created_by, updated_by)
             values (${p.rm_batch_id}, ${ev}, now(), 'ACTIVE', ${principal.userId}, ${principal.userId})`;
    const childCode = await this.mintIn(tx, childId, principal.userId);
    const label = await this.labelTx(tx, childCode, null, principal);
    return {
      lotSplitId: splitId, kind, jobNo,
      parent: { barcode, inventoryBatchId: p.inventory_batch_id, qtyMg: bookMg - qtyMg, bin: p.bin_code },
      child: { barcode: childCode, inventoryBatchId: childId, qtyMg, bin: to.code, expiry: p.expiry_date, lot: p.batch_number },
      label,
    };
  }

  /* ── the child's label ───────────────────────────────────────────────────────────────── */

  private async labelTx(tx: TransactionSql, barcode: string, reason: string | null, principal: AuthPrincipal): Promise<ChildLabel> {
    const lot = await this.lotByCode(tx, barcode, false);
    const [s] = await tx<{ kind: SplitKind; parent: string | null; job_no: string | null }[]>`
      select ls.kind, plb.barcode as parent, j.job_no from inventory.lot_split ls
        left join inventory.lot_barcode plb on plb.inventory_batch_id = ls.parent_inventory_batch_id
        left join production.floor_job j on j.floor_job_id = ls.floor_job_id
       where ls.child_inventory_batch_id = ${lot.inventory_batch_id}`;
    if (!s) throw new ConflictException('That lot was not split from another lot. Its label prints from putaway.');
    const [prior] = await tx`select 1 from inventory.lot_label where inventory_batch_id = ${lot.inventory_batch_id} limit 1`;
    const why = String(reason ?? '').trim();
    if (prior && !why) throw new BadRequestException('A reprint needs a reason: a duplicate lot label is a recall risk.');
    const [row] = await tx<{ lot_label_id: string; printed_dt: string }[]>`
      insert into inventory.lot_label (lot_label_id, inventory_batch_id, barcode, reprint, reason, printed_by)
      values (${uuidv7()}, ${lot.inventory_batch_id}, ${barcode}, ${!!prior}, ${prior ? why.slice(0, 300) : null}, ${principal.userId})
      returning lot_label_id::text, printed_dt::text`;
    const fc = lot.material_id ? await this.codes.codeFor(lot.material_id) : null;
    return {
      lotLabelId: row!.lot_label_id, kind: s.kind, reprint: !!prior, reason: prior ? why.slice(0, 300) : null, barcode, splitFrom: s.parent, jobNo: s.job_no,
      lot: lot.batch_number, floorCode: fc?.code ?? null, colourName: fc?.colourName ?? null, colourHex: fc?.colourHex ?? null, initial: fc?.initial ?? null,
      bin: lot.bin_code, qtyMg: qtyToMg(lot.qty, lot.uom_code), expiry: lot.expiry_date,
      hazard: HAZARD_PENDING, person: await this.person(tx, principal.userId), printedDt: row!.printed_dt,
    };
  }

  /** Print (or reprint, with a reason) a child lot's label from Stock. */
  async printLabel(rawCode: unknown, reason: string | null, principal: AuthPrincipal): Promise<ChildLabel> {
    const barcode = this.code(rawCode);
    return this.sql.begin((tx) => this.labelTx(tx, barcode, reason, principal));
  }

  /** The verifier's reprint: only a lot that came back from this job. */
  async printJobLabel(jobId: string, rawCode: unknown, reason: string | null, principal: AuthPrincipal): Promise<ChildLabel> {
    const barcode = this.code(rawCode);
    return this.sql.begin(async (tx) => {
      const [own] = await tx`select 1 from inventory.lot_split ls join inventory.lot_barcode lb on lb.inventory_batch_id = ls.child_inventory_batch_id
                              where lb.barcode = ${barcode} and ls.kind = 'RETURN' and ls.floor_job_id = ${jobId}`;
      if (!own) throw new ForbiddenException('That lot is not a return from this job: reprint it from Stock.');
      return this.labelTx(tx, barcode, reason, principal);
    });
  }

  /** The leftovers that came back from one job (the verifier's list). */
  async jobReturns(jobId: string) {
    const rows = await this.sql<{ barcode: string; qty_mg: string; bin_code: string | null; created_dt: string }[]>`
      select lb.barcode, ls.qty_mg::text, b.bin_code, ls.created_dt::text from inventory.lot_split ls
        join inventory.lot_barcode lb on lb.inventory_batch_id = ls.child_inventory_batch_id
        left join location.bin_master b on b.bin_id = ls.to_location_id
       where ls.floor_job_id = ${jobId} and ls.kind = 'RETURN' order by ls.created_dt`;
    return rows.map((r) => ({ barcode: r.barcode, qtyMg: Number(r.qty_mg), bin: r.bin_code, at: r.created_dt }));
  }

  /* ── genealogy ───────────────────────────────────────────────────────────────────────── */

  async genealogy(rawCode: unknown) {
    const barcode = this.code(rawCode);
    const lot = await this.lotByCode(this.sql, barcode, false);
    const step = (sql: Q, childId: string) => sql<{ parent_id: string; parent_code: string | null; kind: SplitKind; qty_mg: string; job_no: string | null; who: string; at: string }[]>`
      select ls.parent_inventory_batch_id::text as parent_id, plb.barcode as parent_code, ls.kind, ls.qty_mg::text, j.job_no,
             coalesce(u.user_name, u.email, ls.created_by) as who, ls.created_dt::text as at
        from inventory.lot_split ls
        left join inventory.lot_barcode plb on plb.inventory_batch_id = ls.parent_inventory_batch_id
        left join production.floor_job j on j.floor_job_id = ls.floor_job_id
        left join iam.user_master u on u.user_id::text = ls.created_by
       where ls.child_inventory_batch_id = ${childId}`;
    const ancestors: Array<{ barcode: string | null; kind: SplitKind; qtyMg: number; jobNo: string | null; by: string; at: string }> = [];
    let cur = lot.inventory_batch_id;
    for (let i = 0; i < 50; i++) {
      const [s] = await step(this.sql, cur);
      if (!s) break;
      ancestors.push({ barcode: s.parent_code, kind: s.kind, qtyMg: Number(s.qty_mg), jobNo: s.job_no, by: s.who, at: s.at });
      cur = s.parent_id;
    }
    const children = await this.sql<{ barcode: string | null; kind: SplitKind; qty_mg: string; bin_code: string | null; job_no: string | null; who: string; at: string }[]>`
      select clb.barcode, ls.kind, ls.qty_mg::text, b.bin_code, j.job_no, coalesce(u.user_name, u.email, ls.created_by) as who, ls.created_dt::text as at
        from inventory.lot_split ls
        left join inventory.lot_barcode clb on clb.inventory_batch_id = ls.child_inventory_batch_id
        left join location.bin_master b on b.bin_id = ls.to_location_id
        left join production.floor_job j on j.floor_job_id = ls.floor_job_id
        left join iam.user_master u on u.user_id::text = ls.created_by
       where ls.parent_inventory_batch_id = ${lot.inventory_batch_id} order by ls.created_dt`;
    const fc = lot.material_id ? await this.codes.codeFor(lot.material_id) : null;
    return {
      lot: { barcode, lot: lot.batch_number, bin: lot.bin_code, qtyMg: qtyToMg(lot.qty, lot.uom_code), expiry: lot.expiry_date, floorCode: fc?.code ?? null, colourName: fc?.colourName ?? null, colourHex: fc?.colourHex ?? null, initial: fc?.initial ?? null },
      ancestors,
      children: children.map((c) => ({ barcode: c.barcode, kind: c.kind, qtyMg: Number(c.qty_mg), bin: c.bin_code, jobNo: c.job_no, by: c.who, at: c.at })),
    };
  }
}
