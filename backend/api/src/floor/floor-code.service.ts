/**
 * PROD-A-4 — floor codes, lot barcodes and scan-resolve (production-floor plan §3, §12.2).
 *
 *   Family colours  The admin's ingredient family -> colour table (citrus = yellow …). A family's
 *                   colour cannot be changed once codes are printed under it: every label in the
 *                   rack would then say the wrong colour.
 *   Floor codes     One per material: the family colour + a RANDOM number inside the family
 *                   (YELLOW-0417). Random, not alphabetical or by CAS, so the code says nothing
 *                   beyond the family. Every label prints the colour NAME and its initial too, so
 *                   colour is never the only signal (colour-blind safety).
 *   Lot barcodes    The payload printed on a raw lot is only an opaque id (L-7Q3K9XA): no name, no
 *                   CAS, no percentage. It means nothing off this system.
 *   Scan-resolve    A scan is answered under the scanner's own permissions. The floor sees floor
 *                   code, colour, bin, lot, quantity left, expiry and the hazard line; only a holder
 *                   of masterdata:material:reveal also gets the real material.
 *
 * Hazard: no raw-material classification is sourced on this box yet, so every lot answers
 * "Classification pending: handle as hazardous". It never prints a pictogram it does not hold.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import type { Sql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { scanCode } from './scan-code.js';

export const REVEAL = 'masterdata:material:reveal';
export const HAZARD_PENDING = 'Classification pending: handle as hazardous';
/** Crockford base32 without I, L, O, U: nothing a person can misread off a smudged label. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const LOT_BARCODE_RE = /^L-[0-9A-HJKMNP-TV-Z]{7}$/;

export interface FamilyInput {
  familyCode: string;
  familyName: string;
  colourName: string;
  colourHex: string;
  initial?: string;
}

export interface FloorCode {
  materialId: string;
  code: string;
  familyCode: string;
  colourName: string;
  colourHex: string;
  initial: string;
  number: number;
}

/** Stored quantity → integer mg, when its unit is a mass unit we know. null otherwise (never a guess). */
export function qtyToMg(qty: string | number | null, uomCode: string | null): number | null {
  if (qty === null || qty === undefined || qty === '') return null;
  const u = String(uomCode ?? '').trim().toLowerCase();
  const factor = ['kg', 'kgs', 'kilogram', 'kilograms'].includes(u) ? 1_000_000
    : ['g', 'gm', 'gms', 'gram', 'grams'].includes(u) ? 1_000
      : ['mg', 'milligram', 'milligrams'].includes(u) ? 1 : null;
  if (factor === null) return null;
  // numeric(18,4) text: exact decimal → mg without float drift.
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(qty).trim());
  if (!m) return null;
  const frac = (m[3] ?? '').padEnd(4, '0').slice(0, 4);
  const tenThousandths = BigInt(m[2]!) * 10000n + BigInt(frac);
  const mg = (tenThousandths * BigInt(factor)) / 10000n;
  return Number(m[1] === '-' ? -mg : mg);
}

export function codeText(colourName: string, n: number): string {
  return `${colourName.toUpperCase().replace(/[^A-Z]/g, '')}-${String(n).padStart(4, '0')}`;
}

@Injectable()
export class FloorCodeService {
  /** Injectable for tests: a number in [1, 9999] and the 7 barcode characters. */
  drawNumber: () => number = () => randomInt(1, 10000);
  drawBarcode: () => string = () => {
    const b = randomBytes(7);
    let s = '';
    for (let i = 0; i < 7; i++) s += CROCKFORD[b[i]! % 32];
    return `L-${s}`;
  };

  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async families() {
    return this.sql`
      select f.family_code as "familyCode", f.family_name as "familyName", f.colour_name as "colourName", f.colour_hex as "colourHex",
             f.initial, f.updated_by as "updatedBy", f.updated_dt::text as "updatedDt",
             (select count(*)::int from masterdata.floor_code c where c.family_code = f.family_code) as "codes"
        from masterdata.floor_family_colour f order by f.family_code`;
  }

  async setFamily(input: FamilyInput, principal: AuthPrincipal) {
    const familyCode = String(input.familyCode ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    const familyName = String(input.familyName ?? '').trim();
    const colourName = String(input.colourName ?? '').trim();
    const colourHex = String(input.colourHex ?? '').trim();
    if (!familyCode || !familyName) throw new BadRequestException('Give the family a code and a name.');
    if (!/^[A-Za-z]+$/.test(colourName)) throw new BadRequestException('The colour needs a plain name in letters (e.g. Yellow): it is printed on every label.');
    if (!/^#[0-9A-Fa-f]{6}$/.test(colourHex)) throw new BadRequestException('The colour needs a hex value like #E8C547.');
    const initial = String(input.initial ?? colourName.charAt(0)).trim().toUpperCase();
    if (!/^[A-Z]$/.test(initial)) throw new BadRequestException('The initial is one letter.');
    const [existing] = await this.sql<{ colour_name: string; colour_hex: string; codes: number }[]>`
      select colour_name, colour_hex, (select count(*)::int from masterdata.floor_code c where c.family_code = f.family_code) as codes
        from masterdata.floor_family_colour f where family_code = ${familyCode}`;
    if (existing && existing.codes > 0 && (existing.colour_name.toLowerCase() !== colourName.toLowerCase() || existing.colour_hex.toLowerCase() !== colourHex.toLowerCase())) {
      throw new ConflictException(`${existing.codes} code(s) are already printed as ${existing.colour_name}. Changing the colour would make those labels wrong; add a new family instead.`);
    }
    try {
      await this.sql`
        insert into masterdata.floor_family_colour (family_code, family_name, colour_name, colour_hex, initial, updated_by)
        values (${familyCode}, ${familyName}, ${colourName}, ${colourHex.toUpperCase()}, ${initial}, ${principal.userId})
        on conflict (family_code) do update set family_name = excluded.family_name, colour_name = excluded.colour_name,
          colour_hex = excluded.colour_hex, initial = excluded.initial, updated_by = excluded.updated_by, updated_dt = now()`;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException(`Another family is already ${colourName}. Each family needs its own colour.`);
      throw e;
    }
    return { familyCode, familyName, colourName, colourHex: colourHex.toUpperCase(), initial };
  }

  async codeFor(materialId: string): Promise<FloorCode | null> {
    const [r] = await this.sql<{ family_code: string; number: number; colour_name: string; colour_hex: string; initial: string }[]>`
      select c.family_code, c.number, f.colour_name, f.colour_hex, f.initial
        from masterdata.floor_code c join masterdata.floor_family_colour f on f.family_code = c.family_code
       where c.material_id = ${materialId}`;
    if (!r) return null;
    return { materialId, code: codeText(r.colour_name, r.number), familyCode: r.family_code, colourName: r.colour_name, colourHex: r.colour_hex, initial: r.initial, number: r.number };
  }

  /** File a material under a family: draws a random free number in that family. Idempotent. */
  async assignCode(materialId: string, familyCode: string, principal: AuthPrincipal): Promise<FloorCode> {
    const have = await this.codeFor(materialId);
    if (have) {
      if (have.familyCode !== familyCode) throw new ConflictException(`This material is already ${have.code}. A code is never re-issued under another family.`);
      return have;
    }
    const [fam] = await this.sql`select 1 from masterdata.floor_family_colour where family_code = ${familyCode}`;
    if (!fam) throw new NotFoundException(`No family "${familyCode}". Add it to the colour table first.`);
    const [mat] = await this.sql`select 1 from masterdata.material where material_id = ${materialId}`;
    if (!mat) throw new NotFoundException('No such material.');
    const [cnt] = await this.sql<{ used: number }[]>`select count(*)::int as used from masterdata.floor_code where family_code = ${familyCode}`;
    const used = cnt?.used ?? 0;
    if (used >= 9999) throw new ConflictException('This family has no free numbers left.');
    for (let attempt = 0; attempt < 50; attempt++) {
      const n = this.drawNumber();
      const rows = await this.sql`
        insert into masterdata.floor_code (material_id, family_code, number, created_by)
        values (${materialId}, ${familyCode}, ${n}, ${principal.userId})
        on conflict do nothing returning material_id`;
      if (rows.length) return (await this.codeFor(materialId))!;
      const again = await this.codeFor(materialId);
      if (again) return again; // a concurrent assign for the same material won
    }
    throw new ConflictException('Could not draw a free number in this family. Try again.');
  }

  /** The opaque barcode for a lot, minted once. */
  async lotBarcode(inventoryBatchId: string, principal: AuthPrincipal | null): Promise<string> {
    const [have] = await this.sql<{ barcode: string }[]>`select barcode from inventory.lot_barcode where inventory_batch_id = ${inventoryBatchId}`;
    if (have) return have.barcode;
    const [lot] = await this.sql`select 1 from inventory.inventory_batch where inventory_batch_id = ${inventoryBatchId}`;
    if (!lot) throw new NotFoundException('No such lot.');
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = this.drawBarcode();
      const rows = await this.sql`insert into inventory.lot_barcode (barcode, inventory_batch_id, created_by)
        values (${code}, ${inventoryBatchId}, ${principal?.userId ?? 'system'}) on conflict do nothing returning barcode`;
      if (rows.length) return code;
      const [again] = await this.sql<{ barcode: string }[]>`select barcode from inventory.lot_barcode where inventory_batch_id = ${inventoryBatchId}`;
      if (again) return again.barcode;
    }
    throw new ConflictException('Could not mint a lot barcode. Try again.');
  }

  /** Scan a lot label. Answered under the scanner's permissions. */
  async resolve(raw: string, principal: AuthPrincipal) {
    const barcode = scanCode(raw).toUpperCase(); // SCAN-3: ]Q1 / ]C0 prefixes and suffixes off
    if (!LOT_BARCODE_RE.test(barcode)) throw new BadRequestException('That is not a lot label. Lot labels read L- and seven characters.');
    const [r] = await this.sql<{
      inventory_batch_id: string; material_id: string | null; qty: string | null; uom_code: string | null; batch_number: string | null;
      expiry_date: string | null; bin_code: string | null; qc: string | null; rm_batch_id: string | null; material_name: string | null; material_code: string | null;
    }[]>`
      select ib.inventory_batch_id::text, ib.material_id::text, ib.quantity_on_hand::text as qty, u.uom_code, rb.batch_number,
             rb.expiry_date::text, b.bin_code, qc.overall_result as qc, ib.rm_batch_id::text, m.material_name, m.material_code
        from inventory.lot_barcode lb
        join inventory.inventory_batch ib on ib.inventory_batch_id = lb.inventory_batch_id
        left join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
        left join platform.uom_master u on u.uom_id = ib.uom_id
        left join location.bin_master b on b.bin_id = ib.storage_location_id
        left join masterdata.material m on m.material_id = ib.material_id
        left join lateral (select overall_result from quality.qc_inspections q where q.rm_batch_id = ib.rm_batch_id order by created_dt desc limit 1) qc on true
       where lb.barcode = ${barcode}`;
    if (!r) throw new NotFoundException('This lot label is not known here.');
    const fc = r.material_id ? await this.codeFor(r.material_id) : null;
    const today = new Date().toISOString().slice(0, 10);
    const expired = !!r.expiry_date && r.expiry_date < today;
    const released = !!r.rm_batch_id && ['ACCEPT', 'PASS'].includes(String(r.qc ?? '').toUpperCase());
    const out: Record<string, unknown> = {
      kind: 'lot',
      barcode,
      inventoryBatchId: r.inventory_batch_id,
      floorCode: fc?.code ?? null,
      colourName: fc?.colourName ?? null,
      colourHex: fc?.colourHex ?? null,
      initial: fc?.initial ?? null,
      bin: r.bin_code,
      lot: r.batch_number,
      quantityLeftMg: qtyToMg(r.qty, r.uom_code),
      quantityLeft: r.qty === null ? null : `${r.qty} ${r.uom_code ?? ''}`.trim(),
      expiry: r.expiry_date,
      expired,
      pickable: released && !expired && Number(r.qty ?? 0) > 0,
      status: expired ? 'EXPIRED' : released ? 'RELEASED' : 'QUARANTINE',
      hazard: HAZARD_PENDING,
    };
    // FLOOR-1 (R8): a child lot names the lot it was split from (or came back from the verifier as).
    const [split] = await this.sql<{ parent: string | null; kind: string }[]>`
      select plb.barcode as parent, ls.kind from inventory.lot_split ls
        left join inventory.lot_barcode plb on plb.inventory_batch_id = ls.parent_inventory_batch_id
       where ls.child_inventory_batch_id = ${r.inventory_batch_id}`;
    out.splitFrom = split?.parent ?? null;
    out.splitKind = split?.kind ?? null;
    if ((principal.permissions ?? []).includes(REVEAL)) {
      out.materialId = r.material_id;
      out.materialName = r.material_name;
      out.materialCode = r.material_code;
    }
    return out;
  }
}
