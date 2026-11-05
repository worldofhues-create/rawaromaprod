/**
 * ScaleService (lane pf-c, plan 12.5) — digital scale pairing.
 *
 * A scale pairs like any device (kind `scale`, one station). Its weight strings reach RawProd
 * through whatever sits next to it (the station tablet or the print agent reading RS-232/USB, or a
 * network scale) with the scale's device token. Only a STABLE reading is stored, as exact integer
 * milligrams: the decimal is read as text, never through a float, and a value finer than 1 mg is
 * refused rather than rounded.
 *
 * resolveWeight is what a station calls with the weight it is about to record: "scale" must name a
 * fresh stable reading from a scale at the same station with the same value; anything else is
 * recorded as "typed". (Whether a typed weight needs a second person is a rules-engine policy,
 * lane A.) Display (formatWeight, max 2 decimals, the scale's resolution) is web/weight.js, lane A.
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import type { Sql } from 'postgres';
import type { PairedDevice } from './devices.service.js';
import { FLOOR_CLOCK } from './floor.tokens.js';
import { iso, systemClock, type Clock } from './floor-util.js';

export const SCALE_READING_FRESH_MS = 60 * 1000;
const FACTOR: Record<string, number> = { mg: 1, g: 1000, kg: 1_000_000 };

/** "125.47", unit g -> 125470. Null when it is finer than 1 mg. */
function decimalToMg(num: string, unit: string): number | null {
  const f = FACTOR[unit];
  if (!f) return null;
  const [int, frac = ''] = num.split('.');
  const places = Math.log10(f);
  const fracTrim = frac.replace(/0+$/, '');
  if (fracTrim.length > places) return null;
  const mg = Number(int) * f + (fracTrim ? Number(fracTrim.padEnd(places, '0')) : 0);
  return Number.isSafeInteger(mg) ? mg : null;
}

/**
 * Parses one weight line. Recognises Mettler SICS ("S S" stable / "S D" dynamic), A&D ("ST," /
 * "US," / "OL,"), Ohaus and generic lines (a trailing "?" means unstable). Null for overload,
 * negative, unreadable or sub-mg values.
 */
export function parseScaleLine(raw: string): { mg: number; stable: boolean } | null {
  const s = String(raw ?? '').trim();
  if (!s || /^(OL|S\s+[+-]|S\s+I)\b/i.test(s) || /^OL,/i.test(s)) return null;
  let stable = true;
  if (/^S\s+D\b/i.test(s) || /^US,/i.test(s) || /\?/.test(s)) stable = false;
  const m = /([+-])?\s*(\d+(?:\.\d+)?)\s*(mg|kg|g)\b/i.exec(s);
  if (!m) return null;
  if (m[1] === '-') return null;
  const mg = decimalToMg(m[2]!, m[3]!.toLowerCase());
  if (mg === null) return null;
  return { mg, stable };
}

@Injectable()
export class ScaleService {
  private readonly clock: Clock;
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql, @Optional() @Inject(FLOOR_CLOCK) clock?: Clock) {
    this.clock = clock ?? systemClock;
  }

  async record(device: PairedDevice, body: { raw?: unknown; mg?: unknown; stable?: unknown }) {
    if (device.kind !== 'scale') throw new ForbiddenException('Only a paired scale sends readings.');
    let reading: { mg: number; stable: boolean } | null;
    if (typeof body.raw === 'string') reading = parseScaleLine(body.raw);
    else if (Number.isSafeInteger(body.mg) && (body.mg as number) >= 0) reading = { mg: body.mg as number, stable: body.stable === true };
    else throw new BadRequestException('Send the scale line as raw, or mg (whole milligrams) with stable.');
    if (!reading) return { stored: false, reason: 'not a weight' };
    if (!reading.stable) return { stored: false, reason: 'not stable' };
    const id = uuidv7();
    await this.sql`
      insert into platform.scale_reading (scale_reading_id, device_id, station, mg, stable, raw, read_at)
      values (${id}::uuid, ${device.deviceId}::uuid, ${device.station}, ${reading.mg}, true,
              ${typeof body.raw === 'string' ? body.raw.slice(0, 200) : null}, ${this.clock().toISOString()}::timestamptz)`;
    return { stored: true, scaleReadingId: id, mg: reading.mg };
  }

  /** The newest stable reading at a station, if it is fresh. */
  async latest(station: string) {
    const cutoff = new Date(this.clock().getTime() - SCALE_READING_FRESH_MS).toISOString();
    const [r] = await this.sql`
      select sr.scale_reading_id, sr.device_id, sr.mg, sr.read_at, dm.config
        from platform.scale_reading sr join platform.device_master dm on dm.device_id = sr.device_id
       where sr.station = ${station} and sr.read_at >= ${cutoff}::timestamptz and dm.status <> 'revoked'
       order by sr.read_at desc limit 1`;
    if (!r) return null;
    const cfg = (r.config ?? {}) as Record<string, unknown>;
    return {
      scaleReadingId: String(r.scale_reading_id),
      deviceId: String(r.device_id),
      mg: Number(r.mg),
      readAt: iso(r.read_at),
      resolutionMg: Number.isSafeInteger(cfg.resolutionMg) ? (cfg.resolutionMg as number) : null,
    };
  }

  async resolveWeight(body: { mg?: unknown; weightSource?: unknown; scaleReadingId?: unknown }, station: string) {
    const mg = body.mg;
    if (!Number.isSafeInteger(mg) || (mg as number) <= 0) throw new BadRequestException('The weight must be a whole number of milligrams above 0.');
    if (body.weightSource === 'typed') return { mg: mg as number, weightSource: 'typed' as const, scaleReadingId: null };
    if (body.weightSource !== 'scale') throw new BadRequestException('weightSource must be scale or typed.');
    const id = typeof body.scaleReadingId === 'string' ? body.scaleReadingId : '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('A weight from the scale names its reading (scaleReadingId).');
    const [r] = await this.sql`select station, mg, read_at from platform.scale_reading where scale_reading_id = ${id}::uuid`;
    if (!r) throw new BadRequestException('That scale reading was not found.');
    if (String(r.station) !== station) throw new ConflictException('That reading came from a scale at another station, not this station.');
    if (this.clock().getTime() - new Date(iso(r.read_at)!).getTime() > SCALE_READING_FRESH_MS) {
      throw new ConflictException('That scale reading is too old. Put it on the scale again.');
    }
    if (Number(r.mg) !== mg) throw new ConflictException('The weight does not match the scale reading.');
    return { mg: mg as number, weightSource: 'scale' as const, scaleReadingId: id };
  }
}
