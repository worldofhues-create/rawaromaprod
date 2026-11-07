/**
 * FLOOR-2 (F7) — finished-goods rack zones, colour coded and initial based (owner, plan §1 "FG rack,
 * QC approved, colour zone"; §12.2's colour-blind rule applies to the FG rack too).
 *
 * A zone is the existing location.zone_master row (racks belong to it). The admin gives it a colour
 * (hex, for screens and coloured stock), the colour's plain NAME and initials, in
 * location.fg_zone_style. The name and the initials always print beside the colour, so colour is
 * never the only signal; no two zones share a colour name or initials, or a picker reading "GR"
 * could walk to the wrong rack. Once finished goods sit in a zone (stock or an open put-away),
 * its colour and initials are fixed: the labels already on those lots say them.
 *
 * A zone the admin has not styled answers its code with colourName/initials null: a label never
 * prints a guessed colour.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';

export interface FgZoneLabel {
  code: string;
  name: string | null;
  colourName: string | null;
  colourHex: string | null;
  initials: string | null;
}

type Q = Sql | TransactionSql;

/** The zone a finished-good lot sits in (its stock), or is going to (its open put-away). */
export async function zoneOfFgBatch(q: Q, fgBatchId: string): Promise<FgZoneLabel | null> {
  const [r] = await q<{ zone_code: string | null; zone_name: string | null; colour_name: string | null; colour_hex: string | null; initials: string | null }[]>`
    with at as (
      select st.bin_id, 1 as pri, st.put_away_dt as t from location.fg_bin_stock st where st.finished_good_batch_id = ${fgBatchId}::uuid and st.qty > 0
      union all
      select t.to_bin_id, 2, t.created_dt from location.shelf_task t
       where t.finished_good_batch_id = ${fgBatchId}::uuid and t.kind = 'PUTAWAY' and t.status = 'OPEN' and t.to_bin_id is not null)
    select zn.zone_code, zn.zone_name, s.colour_name, s.colour_hex, s.initials
      from at join location.bin_master bn on bn.bin_id = at.bin_id
      left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
      left join location.rack_master rk on rk.rack_id = sh.rack_id
      left join location.zone_master zn on zn.zone_id = rk.zone_id
      left join location.fg_zone_style s on s.zone_id = zn.zone_id
     where zn.zone_code is not null
     order by at.pri, at.t limit 1`;
  if (!r || !r.zone_code) return null;
  return { code: r.zone_code, name: r.zone_name, colourName: r.colour_name, colourHex: r.colour_hex, initials: r.initials };
}

@Injectable()
export class FgZoneService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async list() {
    const rows = await this.sql<{ zone_code: string; zone_name: string | null; colour_name: string | null; colour_hex: string | null; initials: string | null; updated_by: string | null; updated_dt: string | null; bins: number; lots: number }[]>`
      select zn.zone_code, zn.zone_name, s.colour_name, s.colour_hex, s.initials, s.updated_by, s.updated_dt::text,
             (select count(*)::int from location.bin_master bn join location.shelf_master sh on sh.shelf_id = bn.shelf_id join location.rack_master rk on rk.rack_id = sh.rack_id where rk.zone_id = zn.zone_id) as bins,
             (select count(distinct st.finished_good_batch_id)::int from location.fg_bin_stock st join location.bin_master bn on bn.bin_id = st.bin_id join location.shelf_master sh on sh.shelf_id = bn.shelf_id
                join location.rack_master rk on rk.rack_id = sh.rack_id where rk.zone_id = zn.zone_id and st.qty > 0) as lots
        from location.zone_master zn left join location.fg_zone_style s on s.zone_id = zn.zone_id
       where zn.zone_code is not null
       order by zn.zone_code`;
    return rows.map((r) => ({ zoneCode: r.zone_code, zoneName: r.zone_name, colourName: r.colour_name, colourHex: r.colour_hex, initials: r.initials, updatedBy: r.updated_by, updatedDt: r.updated_dt, bins: r.bins, lots: r.lots }));
  }

  async set(zoneCode: string, body: { colourName?: unknown; colourHex?: unknown; initials?: unknown }, principal: AuthPrincipal) {
    const code = String(zoneCode ?? '').trim();
    const colourName = String(body.colourName ?? '').trim();
    const colourHex = String(body.colourHex ?? '').trim().toUpperCase();
    const initials = String(body.initials ?? '').trim().toUpperCase();
    if (!/^[A-Za-z]+$/.test(colourName)) throw new BadRequestException('The colour needs a plain name in letters (e.g. Green): it is printed on every label beside the colour.');
    if (!/^#[0-9A-F]{6}$/.test(colourHex)) throw new BadRequestException('The colour needs a hex value like #2E8B57.');
    if (!/^[A-Z]{1,3}$/.test(initials)) throw new BadRequestException('The initials are one to three letters (e.g. GR): they are printed on every label so colour is never the only signal.');
    return this.sql.begin(async (tx) => {
      const [z] = await tx<{ zone_id: string; zone_code: string; zone_name: string | null }[]>`
        select zone_id::text, zone_code, zone_name from location.zone_master where lower(zone_code) = lower(${code}) limit 1 for update`;
      if (!z) throw new NotFoundException(`No zone ${code}. Add it on Rack layout first.`);
      const [have] = await tx<{ colour_name: string; colour_hex: string; initials: string }[]>`select colour_name, colour_hex, initials from location.fg_zone_style where zone_id = ${z.zone_id}`;
      if (have && (have.colour_name.toLowerCase() !== colourName.toLowerCase() || have.colour_hex !== colourHex || have.initials !== initials)) {
        const [used] = await tx<{ n: number }[]>`
          select count(distinct x.fg)::int as n from (
            select st.finished_good_batch_id as fg, st.bin_id from location.fg_bin_stock st where st.qty > 0
            union all select t.finished_good_batch_id, t.to_bin_id from location.shelf_task t where t.kind = 'PUTAWAY' and t.status = 'OPEN') x
            join location.bin_master bn on bn.bin_id = x.bin_id join location.shelf_master sh on sh.shelf_id = bn.shelf_id
            join location.rack_master rk on rk.rack_id = sh.rack_id where rk.zone_id = ${z.zone_id}`;
        if ((used?.n ?? 0) > 0) {
          throw new ConflictException(`${used!.n} finished-good lot(s) in zone ${z.zone_code} are labelled ${have.colour_name} (${have.initials}). Changing it would make those labels wrong: move them out first, or style another zone.`);
        }
      }
      try {
        await tx`insert into location.fg_zone_style (zone_id, colour_name, colour_hex, initials, updated_by)
                 values (${z.zone_id}, ${colourName}, ${colourHex}, ${initials}, ${principal.userId})
                 on conflict (zone_id) do update set colour_name = excluded.colour_name, colour_hex = excluded.colour_hex, initials = excluded.initials,
                   updated_by = excluded.updated_by, updated_dt = now()`;
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          const c = (e as { constraint_name?: string }).constraint_name ?? '';
          throw new ConflictException(/initials/.test(c) ? `Another zone already has the initials ${initials}. Each zone needs its own.` : `Another zone is already ${colourName}. Each zone needs its own colour.`);
        }
        throw e;
      }
      return { zoneCode: z.zone_code, zoneName: z.zone_name, colourName, colourHex, initials };
    });
  }

  forFgBatch(fgBatchId: string): Promise<FgZoneLabel | null> {
    return zoneOfFgBatch(this.sql, fgBatchId);
  }

  /** The FG rack for the TV board: lots on the shelves (or going there), each with its zone. */
  async rack(limit = 40) {
    const rows = await this.sql<{ batch_number: string | null; state: string; bin_code: string | null; zone_code: string | null; colour_name: string | null; colour_hex: string | null; initials: string | null }[]>`
      with at as (
        select st.finished_good_batch_id as fg, st.bin_id, 'ON_RACK' as state, st.put_away_dt as t from location.fg_bin_stock st where st.qty > 0
        union all
        select t.finished_good_batch_id, t.to_bin_id, 'GOING', t.created_dt from location.shelf_task t
         where t.kind = 'PUTAWAY' and t.status = 'OPEN' and t.to_bin_id is not null)
      select f.batch_number, at.state, bn.bin_code, zn.zone_code, s.colour_name, s.colour_hex, s.initials
        from at join packaging.finished_good_batch_master f on f.finished_good_batch_id = at.fg
        join location.bin_master bn on bn.bin_id = at.bin_id
        left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
        left join location.rack_master rk on rk.rack_id = sh.rack_id
        left join location.zone_master zn on zn.zone_id = rk.zone_id
        left join location.fg_zone_style s on s.zone_id = zn.zone_id
       order by at.t desc limit ${limit}`;
    return rows.map((r) => ({ batchNumber: r.batch_number, state: r.state as 'ON_RACK' | 'GOING', bin: r.bin_code, zoneCode: r.zone_code, colourName: r.colour_name, colourHex: r.colour_hex, initials: r.initials }));
  }
}
