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
 * recorded as "typed", and (FLOOR-FIX-3) only with a second person's sign-off: requestTypedCheck,
 * then signTypedCheck by a verifier, supervisor or admin who is not the typist; resolveWeight uses the
 * signed check once, for that station and that exact figure. Display (formatWeight, max 2 decimals, the scale's resolution) is web/weight.js, lane A.
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import type { Sql } from 'postgres';
import type { PairedDevice } from './devices.service.js';
import { FLOOR_CLOCK } from './floor.tokens.js';
import { iso, systemClock, type Clock } from './floor-util.js';

export const SCALE_READING_FRESH_MS = 60 * 1000;
/** FLOOR-FIX-4 (owner decision): lab and QC scales read to 0.01 g, floor scales to 0.1 g. Stored in mg. */
export const SCALE_PRECISION_MG = { lab: 10, qc: 10, floor: 100 } as const;
export type ScaleCategory = keyof typeof SCALE_PRECISION_MG;
/** A scale's display resolution in mg: an admin's per-device override, else its category's default.
 *  A scale with no category is a floor scale: the coarser default never shows a figure finer than it read. */
export function scaleResolutionMg(cfg: Record<string, unknown>): number {
  const o = cfg.resolutionMg;
  if (Number.isSafeInteger(o) && (o as number) > 0) return o as number;
  return SCALE_PRECISION_MG[scaleCategory(cfg)];
}
function scaleCategory(cfg: Record<string, unknown>): ScaleCategory {
  const c = String(cfg.category ?? 'floor').toLowerCase();
  return (c in SCALE_PRECISION_MG ? c : 'floor') as ScaleCategory;
}
/** FLOOR-FIX-4: a scale's config as stored: category checked, resolutionMg filled from the default
 *  unless the admin set one (then resolutionOverride is true). */
export function scaleConfig(config: Record<string, unknown>): Record<string, unknown> {
  const c = String(config.category ?? 'floor').toLowerCase();
  if (!(c in SCALE_PRECISION_MG)) throw new BadRequestException('A scale category is lab, qc or floor.');
  const o = config.resolutionMg;
  const override = Number.isSafeInteger(o) && (o as number) > 0 && o !== SCALE_PRECISION_MG[c as ScaleCategory];
  return { ...config, category: c, resolutionMg: override ? o : SCALE_PRECISION_MG[c as ScaleCategory], resolutionOverride: override };
}

/** FLOOR-FIX-3: who may sign a typed weight. */
export const TYPED_WEIGHT_SIGNERS = ['verifier', 'supervisor', 'admin'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
      resolutionMg: scaleResolutionMg(typeof cfg === 'string' ? JSON.parse(cfg) : cfg), // FLOOR-FIX-4
    };
  }

  /** FLOOR-FIX-3: the typist asks for a second person to confirm a typed weight. */
  async requestTypedCheck(body: { station?: unknown; mg?: unknown; reason?: unknown }, principal: AuthPrincipal) {
    const station = typeof body.station === 'string' ? body.station.trim().slice(0, 60) : '';
    if (!station) throw new BadRequestException('station is required.');
    if (!Number.isSafeInteger(body.mg) || (body.mg as number) <= 0) throw new BadRequestException('The weight must be a whole number of milligrams above 0.');
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) || null : null;
    const [r] = await this.sql`insert into platform.typed_weight_check (check_id, station, mg, reason, typed_by)
      values (${uuidv7()}::uuid, ${station}, ${body.mg as number}, ${reason}, ${principal.userId}::uuid) returning *`;
    return this.shapeCheck(r!);
  }

  /** FLOOR-FIX-3: a verifier, supervisor or admin who did not type it signs. Audited on the row. */
  async signTypedCheck(id: string, principal: AuthPrincipal) {
    if (!UUID_RE.test(id)) throw new BadRequestException('That is not a typed-weight check.');
    const role = TYPED_WEIGHT_SIGNERS.find((r) => principal.roles.includes(r));
    return this.sql.begin(async (tx) => {
      const [c] = await tx`select * from platform.typed_weight_check where check_id = ${id}::uuid for update`;
      if (!c) throw new BadRequestException('That typed-weight check was not found.');
      if (String(c.typed_by) === principal.userId) throw new ForbiddenException('You typed this weight, so someone else must sign it.');
      if (!role) throw new ForbiddenException('A typed weight is signed by a verifier or supervisor.');
      if (c.status !== 'PENDING') throw new ConflictException('This typed weight is already signed.');
      const [r] = await tx`update platform.typed_weight_check set status = 'APPROVED', signed_by = ${principal.userId}::uuid, signed_role = ${role},
          signed_at = ${this.clock().toISOString()}::timestamptz where check_id = ${id}::uuid returning *`;
      return this.shapeCheck(r!);
    });
  }

  private shapeCheck(r: Record<string, unknown>) {
    return {
      checkId: String(r.check_id), station: String(r.station), mg: Number(r.mg), reason: (r.reason as string | null) ?? null,
      typedBy: String(r.typed_by), status: String(r.status) as 'PENDING' | 'APPROVED' | 'USED',
      signedBy: (r.signed_by as string | null) ?? null, signedRole: (r.signed_role as string | null) ?? null, signedAt: iso(r.signed_at),
    };
  }

  async resolveWeight(body: { mg?: unknown; weightSource?: unknown; scaleReadingId?: unknown; weightCheckId?: unknown }, station: string, principal?: AuthPrincipal, usedFor?: string) {
    const mg = body.mg;
    if (!Number.isSafeInteger(mg) || (mg as number) <= 0) throw new BadRequestException('The weight must be a whole number of milligrams above 0.');
    if (body.weightSource === 'typed') {
      const id = typeof body.weightCheckId === 'string' ? body.weightCheckId : '';
      if (!UUID_RE.test(id)) throw new ConflictException('A typed weight needs a second person: ask a verifier or supervisor to sign it.');
      const [c] = await this.sql`select * from platform.typed_weight_check where check_id = ${id}::uuid`;
      if (!c) throw new ConflictException('That typed-weight check was not found.');
      if (c.status === 'PENDING') throw new ConflictException('This typed weight is not signed yet: a verifier or supervisor signs it first.');
      if (c.status === 'USED') throw new ConflictException('That sign-off was already used. Ask for a new one.');
      if (String(c.station) !== station) throw new ConflictException('That sign-off is for another station, not this station.');
      if (Number(c.mg) !== mg) throw new ConflictException('The weight does not match the signed figure.');
      if (principal && String(c.typed_by) !== principal.userId) throw new ConflictException('That sign-off is for a weight someone else typed.');
      const [used] = await this.sql`update platform.typed_weight_check set status = 'USED', used_at = ${this.clock().toISOString()}::timestamptz, used_for = ${usedFor ?? null}
         where check_id = ${id}::uuid and status = 'APPROVED' returning check_id`;
      if (!used) throw new ConflictException('That sign-off was already used. Ask for a new one.');
      return { mg: mg as number, weightSource: 'typed' as const, scaleReadingId: null, weightCheckId: id };
    }
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
    return { mg: mg as number, weightSource: 'scale' as const, scaleReadingId: id, weightCheckId: null };
  }
}
