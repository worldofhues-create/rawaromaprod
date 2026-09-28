/**
 * ShelfLayoutService — racks entered IN THE APP by warehouse staff (owner decision 2026-09-29):
 * the location master + fast keyboard/scan entry are the primary path, CSV import optional.
 *
 * Reuses the Phase-1A hierarchy (location.zone_master → rack_master → shelf_master → bin_master;
 * every code unique) rather than a parallel location list, and adds only the rack walking order
 * (location.rack_walk_order).
 *
 *   quickRack()   one form: zone, rack code, number of shelves, bins per shelf → the rack, its
 *                 shelves `<rack>-S1..Sn` and bins `<rack>-S1-B1..` in one transaction, plus its
 *                 place in the walk (default: after the last rack). Refuses an existing rack code.
 *   importCsv()   `zone,rack,shelf,bin[,walk_seq]` lines — creates whatever code is missing,
 *                 leaves what exists; reports per line. Idempotent.
 *   locations()   every bin with its rack/shelf/zone codes, printed label, walk order, what is
 *                 stocked on it and its open tasks — the location master screen and the pickers.
 *   resolve()     a typed or scanned code → one bin (bin code, or its printed label).
 *   setWalk()     a rack's walking position.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { bridge as bridgeContracts } from '@core/contracts';
import type { AuthPrincipal } from '@core/backend-kernel';
import { SHELF_DB, type ShelfDb, type ShelfTx } from './shelf.tokens.js';

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.\-/]{0,39}$/;

export interface QuickRackInput {
  zoneCode: string;
  zoneName?: string | null;
  rackCode: string;
  rackName?: string | null;
  shelves: number;
  binsPerShelf: number;
  walkSeq?: number | null;
}

export interface BinLocation {
  binId: string;
  binCode: string;
  shelfCode: string | null;
  rackCode: string | null;
  zoneCode: string | null;
  label: string;
  walkSeq: number | null;
  stockQty: number;
  batchCount: number;
  openTasks: number;
}

/** The sort every sheet and display uses: rack walk order, then codes. */
export const WALK_ORDER_SQL = sql`coalesce(wo.walk_seq, 2147483647), rk.rack_code, sh.shelf_code, bn.bin_code`;

@Injectable()
export class ShelfLayoutService {
  constructor(@Inject(SHELF_DB) private readonly db: ShelfDb) {}

  async quickRack(body: QuickRackInput, principal: AuthPrincipal) {
    const zoneCode = String(body.zoneCode ?? '').trim();
    const rackCode = String(body.rackCode ?? '').trim();
    if (!CODE.test(zoneCode)) throw new BadRequestException('Zone code: letters, digits, - _ . / (up to 40).');
    if (!CODE.test(rackCode)) throw new BadRequestException('Rack code: letters, digits, - _ . / (up to 40).');
    const shelves = Math.trunc(Number(body.shelves));
    const bins = Math.trunc(Number(body.binsPerShelf));
    if (!(shelves >= 1 && shelves <= 30)) throw new BadRequestException('Shelves: 1 to 30.');
    if (!(bins >= 1 && bins <= 50)) throw new BadRequestException('Bins per shelf: 1 to 50.');
    const who = principal.userId;
    return this.db.transaction(async (tx) => {
      const zoneId = await this.zone(tx, zoneCode, body.zoneName ?? null, who);
      const exists = ((await tx.execute(sql`select 1 from location.rack_master where lower(rack_code) = lower(${rackCode})`)) as unknown as unknown[]).length;
      if (exists) throw new ConflictException(`Rack ${rackCode} already exists. Pick another code, or add bins to it on the Bins screen.`);
      const rack = ((await tx.execute(sql`
        insert into location.rack_master (zone_id, rack_code, rack_name, status, created_by, updated_by)
        values (${zoneId}::uuid, ${rackCode}, ${body.rackName ?? `Rack ${rackCode}`}, 'ACTIVE', ${who}, ${who})
        returning rack_id::text
      `)) as unknown as Array<{ rack_id: string }>)[0]!;
      const created: string[] = [];
      for (let s = 1; s <= shelves; s++) {
        const shelfCode = `${rackCode}-S${s}`;
        const shelf = ((await tx.execute(sql`
          insert into location.shelf_master (rack_id, shelf_code, shelf_name, status, created_by, updated_by)
          values (${rack.rack_id}::uuid, ${shelfCode}, ${`Shelf ${s}`}, 'ACTIVE', ${who}, ${who})
          returning shelf_id::text
        `)) as unknown as Array<{ shelf_id: string }>)[0]!;
        for (let b = 1; b <= bins; b++) {
          const binCode = `${shelfCode}-B${b}`;
          await tx.execute(sql`
            insert into location.bin_master (shelf_id, bin_code, bin_name, status, created_by, updated_by)
            values (${shelf.shelf_id}::uuid, ${binCode}, ${`Bin ${b}`}, 'ACTIVE', ${who}, ${who})
          `);
          created.push(binCode);
        }
      }
      const walkSeq = await this.setWalkTx(tx, rack.rack_id, body.walkSeq ?? null, who);
      return { rackId: rack.rack_id, rackCode, zoneCode, walkSeq, shelves, binsPerShelf: bins, binCodes: created };
    });
  }

  /** `zone,rack,shelf,bin[,walk_seq]` per line (a header line is skipped). */
  async importCsv(text: string, principal: AuthPrincipal) {
    const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) throw new BadRequestException('Paste at least one line: zone,rack,shelf,bin[,walk order].');
    if (lines.length > 2000) throw new BadRequestException('At most 2000 lines at a time.');
    const who = principal.userId;
    const results: Array<{ line: number; bin: string | null; outcome: 'created' | 'exists' | 'error'; message?: string }> = [];
    await this.db.transaction(async (tx) => {
      for (let i = 0; i < lines.length; i++) {
        const cells = lines[i]!.split(',').map((c) => c.trim());
        if (i === 0 && /^zone$/i.test(cells[0] ?? '')) continue;
        const [zone, rack, shelf, bin, walk] = cells;
        if (!zone || !rack || !shelf || !bin || ![zone, rack, shelf, bin].every((c) => CODE.test(c))) {
          results.push({ line: i + 1, bin: bin ?? null, outcome: 'error', message: 'needs zone,rack,shelf,bin codes (letters, digits, - _ . /)' });
          continue;
        }
        // Shelf and bin codes are unique across the whole warehouse, so a short code is prefixed
        // with its parent's ("A01", "2", "3" → shelf "A01-2", bin "A01-2-3", printed "A01-2-3").
        const shelfCode = shelf.toLowerCase().startsWith(`${rack.toLowerCase()}-`) ? shelf : `${rack}-${shelf}`;
        const binCode = bin.toLowerCase().startsWith(`${shelfCode.toLowerCase()}-`) ? bin : `${shelfCode}-${bin}`;
        const zoneId = await this.zone(tx, zone, null, who);
        const rackId = await this.upsert(tx, 'rack', rack, zoneId, who);
        const shelfId = await this.upsert(tx, 'shelf', shelfCode, rackId, who);
        const binExisted = ((await tx.execute(sql`select 1 from location.bin_master where lower(bin_code) = lower(${binCode})`)) as unknown as unknown[]).length > 0;
        await this.upsert(tx, 'bin', binCode, shelfId, who);
        if (walk && /^\d{1,9}$/.test(walk)) await this.setWalkTx(tx, rackId, Number(walk), who);
        else await this.setWalkTx(tx, rackId, null, who, true);
        results.push({ line: i + 1, bin: binCode, outcome: binExisted ? 'exists' : 'created' });
      }
    });
    return {
      created: results.filter((r) => r.outcome === 'created').length,
      existing: results.filter((r) => r.outcome === 'exists').length,
      errors: results.filter((r) => r.outcome === 'error'),
    };
  }

  async locations(zoneCode?: string | null): Promise<BinLocation[]> {
    const rows = (await this.db.execute(sql`
      select bn.bin_id::text, bn.bin_code, sh.shelf_code, rk.rack_code, zn.zone_code, wo.walk_seq,
             coalesce(st.qty, 0)::float as stock_qty, coalesce(st.batches, 0)::int as batch_count,
             coalesce(tk.open, 0)::int as open_tasks
        from location.bin_master bn
        left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
        left join location.rack_master rk on rk.rack_id = sh.rack_id
        left join location.zone_master zn on zn.zone_id = rk.zone_id
        left join location.rack_walk_order wo on wo.rack_id = rk.rack_id
        left join (select bin_id, sum(qty) as qty, count(*) filter (where qty > 0) as batches
                     from location.fg_bin_stock group by bin_id) st on st.bin_id = bn.bin_id
        left join (select b, count(*) as open from (
                     select to_bin_id as b from location.shelf_task where status = 'OPEN' and kind in ('PUTAWAY', 'MOVE')
                     union all select from_bin_id from location.shelf_task where status = 'OPEN' and kind = 'PICK') t
                    group by b) tk on tk.b = bn.bin_id
       where (bn.status is null or bn.status = 'ACTIVE')
         and (${zoneCode ?? null}::text is null or lower(zn.zone_code) = lower(${zoneCode ?? null}::text))
       order by ${WALK_ORDER_SQL}
       limit 5000
    `)) as unknown as Array<{ bin_id: string; bin_code: string; shelf_code: string | null; rack_code: string | null; zone_code: string | null; walk_seq: number | null; stock_qty: number; batch_count: number; open_tasks: number }>;
    return rows.map((r) => ({
      binId: r.bin_id, binCode: r.bin_code, shelfCode: r.shelf_code, rackCode: r.rack_code, zoneCode: r.zone_code,
      label: bridgeContracts.locationLabel(r.rack_code, r.shelf_code, r.bin_code) ?? r.bin_code,
      walkSeq: r.walk_seq, stockQty: Number(r.stock_qty), batchCount: r.batch_count, openTasks: r.open_tasks,
    }));
  }

  /** A typed or scanned code → one bin: its bin code, or its printed label, case-insensitively. */
  async resolve(code: string, tx?: ShelfTx): Promise<BinLocation> {
    const c = String(code ?? '').trim();
    if (!c) throw new BadRequestException('Scan or type a bin code.');
    const q = tx ?? this.db;
    const rows = (await q.execute(sql`
      select bn.bin_id::text, bn.bin_code, sh.shelf_code, rk.rack_code, zn.zone_code, wo.walk_seq
        from location.bin_master bn
        left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
        left join location.rack_master rk on rk.rack_id = sh.rack_id
        left join location.zone_master zn on zn.zone_id = rk.zone_id
        left join location.rack_walk_order wo on wo.rack_id = rk.rack_id
       where lower(bn.bin_code) = lower(${c})
          or lower(concat_ws('-', rk.rack_code, sh.shelf_code, bn.bin_code)) = lower(${c})
       limit 2
    `)) as unknown as Array<{ bin_id: string; bin_code: string; shelf_code: string | null; rack_code: string | null; zone_code: string | null; walk_seq: number | null }>;
    const r = rows[0];
    if (!r) throw new NotFoundException(`No bin with code ${c}. Check the label on the shelf, or add the bin on the Rack layout screen.`);
    return {
      binId: r.bin_id, binCode: r.bin_code, shelfCode: r.shelf_code, rackCode: r.rack_code, zoneCode: r.zone_code,
      label: bridgeContracts.locationLabel(r.rack_code, r.shelf_code, r.bin_code) ?? r.bin_code,
      walkSeq: r.walk_seq, stockQty: 0, batchCount: 0, openTasks: 0,
    };
  }

  async setWalk(rackCode: string, walkSeq: number, principal: AuthPrincipal) {
    if (!Number.isInteger(walkSeq) || walkSeq < 0 || walkSeq > 1_000_000) throw new BadRequestException('Walk order: a whole number 0..1000000.');
    return this.db.transaction(async (tx) => {
      const rack = ((await tx.execute(sql`select rack_id::text from location.rack_master where lower(rack_code) = lower(${rackCode})`)) as unknown as Array<{ rack_id: string }>)[0];
      if (!rack) throw new NotFoundException(`No rack ${rackCode}.`);
      return { rackCode, walkSeq: await this.setWalkTx(tx, rack.rack_id, walkSeq, principal.userId) };
    });
  }

  /** Sets (or, with `keepExisting`, only fills in) a rack's walk position; default = after the last. */
  private async setWalkTx(tx: ShelfTx, rackId: string, walkSeq: number | null, who: string, keepExisting = false): Promise<number> {
    if (keepExisting) {
      const cur = ((await tx.execute(sql`select walk_seq from location.rack_walk_order where rack_id = ${rackId}::uuid`)) as unknown as Array<{ walk_seq: number }>)[0];
      if (cur) return cur.walk_seq;
    }
    const seq = walkSeq ?? Number(((await tx.execute(sql`select coalesce(max(walk_seq), 0) + 10 as n from location.rack_walk_order`)) as unknown as Array<{ n: number }>)[0]?.n ?? 10);
    await tx.execute(sql`
      insert into location.rack_walk_order (rack_id, walk_seq, updated_dt, updated_by) values (${rackId}::uuid, ${seq}, now(), ${who})
      on conflict (rack_id) do update set walk_seq = excluded.walk_seq, updated_dt = now(), updated_by = excluded.updated_by
    `);
    return seq;
  }

  private async zone(tx: ShelfTx, code: string, name: string | null, who: string): Promise<string> {
    const found = ((await tx.execute(sql`select zone_id::text from location.zone_master where lower(zone_code) = lower(${code})`)) as unknown as Array<{ zone_id: string }>)[0];
    if (found) return found.zone_id;
    return ((await tx.execute(sql`
      insert into location.zone_master (zone_code, zone_name, status, created_by, updated_by)
      values (${code}, ${name ?? `Zone ${code}`}, 'ACTIVE', ${who}, ${who}) returning zone_id::text
    `)) as unknown as Array<{ zone_id: string }>)[0]!.zone_id;
  }

  private async upsert(tx: ShelfTx, level: 'rack' | 'shelf' | 'bin', code: string, parentId: string, who: string): Promise<string> {
    if (level === 'rack') {
      const f = ((await tx.execute(sql`select rack_id::text as id from location.rack_master where lower(rack_code) = lower(${code})`)) as unknown as Array<{ id: string }>)[0];
      if (f) return f.id;
      return ((await tx.execute(sql`insert into location.rack_master (zone_id, rack_code, rack_name, status, created_by, updated_by)
        values (${parentId}::uuid, ${code}, ${`Rack ${code}`}, 'ACTIVE', ${who}, ${who}) returning rack_id::text as id`)) as unknown as Array<{ id: string }>)[0]!.id;
    }
    if (level === 'shelf') {
      const f = ((await tx.execute(sql`select shelf_id::text as id from location.shelf_master where lower(shelf_code) = lower(${code})`)) as unknown as Array<{ id: string }>)[0];
      if (f) return f.id;
      return ((await tx.execute(sql`insert into location.shelf_master (rack_id, shelf_code, shelf_name, status, created_by, updated_by)
        values (${parentId}::uuid, ${code}, ${`Shelf ${code}`}, 'ACTIVE', ${who}, ${who}) returning shelf_id::text as id`)) as unknown as Array<{ id: string }>)[0]!.id;
    }
    const f = ((await tx.execute(sql`select bin_id::text as id from location.bin_master where lower(bin_code) = lower(${code})`)) as unknown as Array<{ id: string }>)[0];
    if (f) return f.id;
    return ((await tx.execute(sql`insert into location.bin_master (shelf_id, bin_code, bin_name, status, created_by, updated_by)
      values (${parentId}::uuid, ${code}, ${`Bin ${code}`}, 'ACTIVE', ${who}, ${who}) returning bin_id::text as id`)) as unknown as Array<{ id: string }>)[0]!.id;
  }
}
