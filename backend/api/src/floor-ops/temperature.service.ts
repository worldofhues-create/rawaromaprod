/**
 * FLOOR-TEMP-1 — temperature record-keeping and enforcement for storage and production zones.
 *
 *   zones      quality.storage_zone: a named STORAGE or PRODUCTION area, the bins in it, and the interval
 *              it must be logged at. A zone with no reading inside its interval is OVERDUE, and the floor
 *              sweep raises a TEMP_LOG_OVERDUE alert on every station screen and the TV until it is logged.
 *   source     the TemperatureSource of a zone is decided, never configured by hand: a zone with a paired,
 *              unrevoked temp_sensor device (platform.device_master, paired through the ordinary device
 *              pairing: 6-digit code -> device token) is SENSOR; every other zone is MANUAL and must be
 *              logged at the kiosk at its interval. A sensor zone whose sensor goes quiet past the
 *              interval is overdue in exactly the same way, so it falls back to a person with a thermometer.
 *   readings   quality.temperature_reading, in hundredths of a degree C (an integer, parsed from the text,
 *              never through a float). Append-only. MANUAL: typed at the kiosk. SENSOR: posted by the paired
 *              device with its token, for the zone its config names. The server stamps the time either way,
 *              so a reading cannot be back-dated.
 *   limits     quality.material_temp_limit: a material's min and/or max, ONLY with a source (SDS section,
 *              supplier specification, CoA). No limits ship with this code and none are guessed. The old
 *              masterdata.material_storage_rules min/max are free text with no source, so they are not
 *              read here.
 *   bounds     a zone may carry its own min/max (the house's storage specification for that room), only with
 *              the document that sets it. A reading outside them holds every lot in the zone.
 *   excursion  a reading outside a lot's material limit holds that lot (inventory.lot_hold, source
 *              TEMP_EXCURSION), records the excursion, and raises a TEMP_EXCURSION alert. A held lot cannot
 *              be picked or issued; QC releases the hold with a reason (prodfloor holds).
 *
 * Fail closed on what we do not hold: a lot whose material has no sourced limit is counted and reported
 * as "no limit on file". It is never reported as within limits.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { GENERAL_STATION, clearAlert, raiseAlert } from './floor-alerts.js';
import { holdSubject } from '../prodfloor/lot-trace.service.js';
import { scanCode } from '../floor/scan-code.js';

/** '31.25' -> 3125. At most two decimals, within ±99.99 °C. Anything else is null (refused, not rounded). */
export function parseCentiC(v: unknown): number | null {
  const t = String(v ?? '').trim();
  const m = /^(-?)(\d{1,2})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const n = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || 0);
  return m[1] ? -n : n;
}

/** Optional min/max with the document that sets them; both null when none is given. */
function boundsOf(body: { minC?: unknown; maxC?: unknown; boundsSource?: unknown; source?: unknown }, sourceKey: 'boundsSource' | 'source' = 'boundsSource') {
  const has = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== '';
  const min = has(body.minC) ? parseCentiC(body.minC) : null;
  const max = has(body.maxC) ? parseCentiC(body.maxC) : null;
  if ((has(body.minC) && min === null) || (has(body.maxC) && max === null)) throw new BadRequestException('Type a temperature in °C, to at most two decimals.');
  if (min !== null && max !== null && min >= max) throw new BadRequestException('The min must be below the max.');
  const source = String(body[sourceKey] ?? '').trim().slice(0, 300) || null;
  if ((min !== null || max !== null) && !source) throw new BadRequestException('Name the document these bounds come from. Bounds with no source are not recorded.');
  return { min, max, source };
}

/** 3125 -> '31.25 °C'. */
export function centiText(c: number): string {
  const neg = c < 0 ? '-' : '';
  const a = Math.abs(c);
  return `${neg}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')} °C`;
}

export interface ZoneView {
  zoneId: string; code: string; name: string; kind: string; logIntervalMin: number; bins: string[];
  /** SENSOR when a paired sensor serves the zone, else MANUAL. */
  source: 'SENSOR' | 'MANUAL'; sensor: { deviceId: string; name: string; status: string } | null;
  bounds: { minCentiC: number | null; maxCentiC: number | null; source: string } | null;
  lastReading: { centiC: number; text: string; readAt: string; source: string; by: string } | null;
  dueAt: string | null; overdue: boolean; openExcursions: number;
}

@Injectable()
export class TemperatureService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async createZone(body: { code?: unknown; name?: unknown; kind?: unknown; logIntervalMin?: unknown; bins?: unknown; minC?: unknown; maxC?: unknown; boundsSource?: unknown }, principal: AuthPrincipal) {
    const code = String(body.code ?? '').trim().toUpperCase();
    const name = String(body.name ?? '').trim();
    const kind = String(body.kind ?? '').toUpperCase();
    const interval = Number(body.logIntervalMin);
    if (!/^[A-Z0-9-]{1,40}$/.test(code)) throw new BadRequestException('A zone code is letters, digits and dashes.');
    if (!name) throw new BadRequestException('Name the zone.');
    if (kind !== 'STORAGE' && kind !== 'PRODUCTION') throw new BadRequestException('A zone is STORAGE or PRODUCTION.');
    if (!Number.isInteger(interval) || interval < 5 || interval > 1440) throw new BadRequestException('Set the logging interval in minutes, between 5 and 1440.');
    const bins = Array.isArray(body.bins) ? body.bins.map((b) => scanCode(b)).filter(Boolean) : [];
    const b = boundsOf(body);
    return this.sql.begin(async (tx) => {
      const [dup] = await tx`select 1 from quality.storage_zone where zone_code = ${code}`;
      if (dup) throw new ConflictException(`Zone ${code} already exists.`);
      const [z] = await tx<{ zone_id: string }[]>`insert into quality.storage_zone (zone_code, zone_name, kind, log_interval_min, min_centi_c, max_centi_c, bounds_source, created_by)
        values (${code}, ${name}, ${kind}, ${interval}, ${b.min}, ${b.max}, ${b.source}, ${principal.userId}) returning zone_id::text`;
      for (const b of bins) await this.addBinTx(tx, z!.zone_id, b, principal);
      return { zoneId: z!.zone_id, code, name, kind, logIntervalMin: interval, bins };
    });
  }

  async addBin(zoneId: string, binCode: unknown, principal: AuthPrincipal) {
    return this.sql.begin(async (tx) => {
      const [z] = await tx`select 1 from quality.storage_zone where zone_id = ${zoneId}`;
      if (!z) throw new NotFoundException('No such zone.');
      await this.addBinTx(tx, zoneId, scanCode(binCode), principal);
      return { zoneId, bin: scanCode(binCode).toUpperCase() };
    });
  }

  private async addBinTx(tx: TransactionSql, zoneId: string, code: string, principal: AuthPrincipal) {
    const [b] = await tx<{ bin_id: string }[]>`select bin_id::text from location.bin_master where upper(bin_code) = upper(${code})`;
    if (!b) throw new BadRequestException(`No bin ${code}.`);
    const [other] = await tx<{ zone_code: string }[]>`select z.zone_code from quality.storage_zone_bin zb join quality.storage_zone z on z.zone_id = zb.zone_id where zb.bin_id = ${b.bin_id}`;
    if (other) throw new ConflictException(`Bin ${code} is already in zone ${other.zone_code}.`);
    await tx`insert into quality.storage_zone_bin (zone_id, bin_id, created_by) values (${zoneId}, ${b.bin_id}, ${principal.userId})`;
  }

  /** A material's limit, from a source. A new limit supersedes the current one; the old row stays. */
  async setLimit(materialId: string, body: { minC?: unknown; maxC?: unknown; source?: unknown }, principal: AuthPrincipal) {
    const source = String(body.source ?? '').trim().slice(0, 300);
    if (!source) throw new BadRequestException('Name the source of this limit (SDS section, supplier specification or CoA). A limit with no source is not recorded.');
    const { min, max } = boundsOf(body, 'source');
    if (min === null && max === null) throw new BadRequestException('Give a min or a max.');
    return this.sql.begin(async (tx) => {
      const [m] = await tx`select 1 from masterdata.material where material_id = ${materialId}`;
      if (!m) throw new NotFoundException('No such material.');
      await tx`update quality.material_temp_limit set superseded_dt = now() where material_id = ${materialId} and superseded_dt is null`;
      const [r] = await tx<{ id: string }[]>`insert into quality.material_temp_limit (material_id, min_centi_c, max_centi_c, source, set_by)
        values (${materialId}, ${min}, ${max}, ${source}, ${principal.userId}) returning material_temp_limit_id::text as id`;
      return { materialTempLimitId: r!.id, materialId, minCentiC: min, maxCentiC: max, source };
    });
  }

  async setLimitByCode(body: { materialCode?: unknown; minC?: unknown; maxC?: unknown; source?: unknown }, principal: AuthPrincipal) {
    const code = String(body.materialCode ?? '').trim();
    const rows = await this.sql<{ id: string }[]>`select material_id::text as id from masterdata.material where upper(material_code) = upper(${code}) limit 2`;
    if (rows.length !== 1) throw new NotFoundException(rows.length ? `More than one material is coded ${code}.` : `No material coded ${code}.`);
    return this.setLimit(rows[0]!.id, body, principal);
  }

  /** Current sourced limits. The material is named for QC (who holds reveal); the floor never calls this. */
  async limits() {
    const rows = await this.sql<{ id: string; material_id: string; code: string | null; name: string | null; min: number | null; max: number | null; source: string; set_dt: string }[]>`
      select l.material_temp_limit_id::text as id, l.material_id::text, m.material_code as code, m.material_name as name,
             l.min_centi_c as min, l.max_centi_c as max, l.source, l.set_dt::text
        from quality.material_temp_limit l left join masterdata.material m on m.material_id = l.material_id
       where l.superseded_dt is null order by m.material_code nulls last`;
    return { items: rows.map((r) => ({ materialTempLimitId: r.id, materialId: r.material_id, materialCode: r.code, materialName: r.name, minCentiC: r.min, maxCentiC: r.max, source: r.source, setDt: r.set_dt })) };
  }

  /**
   * A reading for a zone. In one transaction: the reading, every lot in the zone checked against its
   * material's sourced limit, a hold and an excursion row for each lot outside it, and the alerts.
   */
  async recordReading(zoneId: string, body: { tempC?: unknown; note?: unknown }, principal: AuthPrincipal) {
    const c = parseCentiC(body.tempC);
    if (c === null) throw new BadRequestException('Type the thermometer reading in °C, to at most two decimals (for example 22.5).');
    const note = String(body.note ?? '').trim().slice(0, 300) || null;
    return this.ingest(zoneId, c, 'MANUAL', null, principal.userId, note);
  }

  /** The sensor adapter: a paired temp_sensor posts {tempC}; the zone is the one its config names. */
  async recordSensorReading(device: { deviceId: string; kind: string; name: string; config: Record<string, unknown> }, body: { tempC?: unknown }) {
    if (device.kind !== 'temp_sensor') throw new ConflictException('Only a paired temperature sensor posts temperature readings.');
    const zoneId = String(device.config.zoneId ?? '');
    if (!zoneId) throw new ConflictException('This sensor names no zone. Set its zone on the Devices screen.');
    const c = parseCentiC(body.tempC);
    if (c === null) throw new BadRequestException('tempC is a temperature in °C to at most two decimals, sent as text (for example "18.25").');
    return this.ingest(zoneId, c, 'SENSOR', device.deviceId, `device:${device.deviceId}`, null);
  }

  private async ingest(zoneId: string, c: number, source: 'MANUAL' | 'SENSOR', deviceId: string | null, by: string, note: string | null) {
    return this.sql.begin(async (tx) => {
      const [z] = await tx<{ zone_code: string; zone_name: string; status: string; min: number | null; max: number | null; bsrc: string | null }[]>`
        select zone_code, zone_name, status, min_centi_c as min, max_centi_c as max, bounds_source as bsrc from quality.storage_zone where zone_id = ${zoneId} for update`;
      if (!z) throw new NotFoundException('No such zone.');
      if (z.status !== 'ACTIVE') throw new ConflictException(`Zone ${z.zone_code} is not in use.`);
      const [r] = await tx<{ id: string; read_at: string }[]>`insert into quality.temperature_reading (zone_id, centi_c, source, device_id, read_at, recorded_by, note)
        values (${zoneId}, ${c}, ${source}, ${deviceId}, clock_timestamp(), ${by}, ${note}) returning temperature_reading_id::text as id, read_at::text`;
      const zoneBreach = (z.min !== null && c < z.min) ? `zone min ${centiText(z.min)}` : (z.max !== null && c > z.max) ? `zone max ${centiText(z.max)}` : null;
      const lots = await tx<{ inventory_batch_id: string; rm_batch_id: string; batch_number: string | null; limit_id: string | null; min: number | null; max: number | null; source: string | null }[]>`
        select ib.inventory_batch_id::text, ib.rm_batch_id::text, rb.batch_number,
               l.material_temp_limit_id::text as limit_id, l.min_centi_c as min, l.max_centi_c as max, l.source
          from quality.storage_zone_bin zb
          join inventory.inventory_batch ib on ib.storage_location_id = zb.bin_id and ib.quantity_on_hand > 0
          join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
          left join quality.material_temp_limit l on l.material_id = ib.material_id and l.superseded_dt is null
         where zb.zone_id = ${zoneId}
         order by rb.batch_number`;
      const excursions: Array<{ lot: string; limit: string; source: string }> = [];
      let noLimitOnFile = 0;
      for (const lot of lots) {
        if (!lot.limit_id) noLimitOnFile += 1;
        const below = lot.limit_id !== null && lot.min !== null && c < lot.min, above = lot.limit_id !== null && lot.max !== null && c > lot.max;
        // The material's own limit decides first; the zone's bounds hold every lot in the room, limit or not.
        const basis = below || above ? 'MATERIAL' : zoneBreach ? 'ZONE' : null;
        if (!basis) continue;
        const limit = basis === 'ZONE' ? zoneBreach! : above ? `max ${centiText(lot.max!)}` : `min ${centiText(lot.min!)}`;
        lot.source = basis === 'ZONE' ? z.bsrc : lot.source;
        lot.limit_id = basis === 'ZONE' ? null : lot.limit_id;
        const reason = `Temperature excursion: ${centiText(c)} in zone ${z.zone_code} against ${limit} (source: ${lot.source}). QC decides whether the lot is still fit.`;
        await holdSubject(tx, 'RM_LOT', lot.rm_batch_id, reason, 'TEMP_EXCURSION', by);
        const [h] = await tx<{ id: string }[]>`select lot_hold_id::text as id from inventory.lot_hold where subject_type = 'RM_LOT' and subject_id = ${lot.rm_batch_id} and released_dt is null`;
        await tx`insert into quality.temperature_excursion (temperature_reading_id, zone_id, rm_batch_id, inventory_batch_id, material_temp_limit_id, basis, centi_c, lot_hold_id)
          values (${r!.id}, ${zoneId}, ${lot.rm_batch_id}, ${lot.inventory_batch_id}, ${lot.limit_id}, ${basis}, ${c}, ${h?.id ?? null})`;
        excursions.push({ lot: lot.batch_number ?? lot.inventory_batch_id, limit, source: lot.source! });
      }
      const at = new Date();
      await clearAlert(tx as unknown as Sql, `temp_overdue:${zoneId}`, at);
      if (excursions.length || zoneBreach) {
        // One open alarm per zone; a later excursion in the same zone is in the same alarm until QC clears it.
        await raiseAlert(tx as unknown as Sql, {
          kind: 'TEMP_EXCURSION', station: GENERAL_STATION, subjectType: 'STORAGE_ZONE', subjectId: zoneId,
          title: `Temperature excursion in ${z.zone_code} (${z.zone_name}): ${centiText(c)}`,
          body: `${source === 'SENSOR' ? 'Sensor' : 'Logged'} reading${zoneBreach ? `, outside the ${zoneBreach}` : ''}. ${excursions.length} lot(s) put on hold${excursions.length ? ': ' + excursions.map((e) => `${e.lot} (${e.limit})`).join(', ') : ''}. Next: QC checks each lot and releases or rejects it from Holds.`,
          dedupeKey: `temp_excursion:${zoneId}`,
        }, at);
      }
      return { temperatureReadingId: r!.id, zoneId, source, centiC: c, text: centiText(c), readAt: r!.read_at, zoneBreach, checked: lots.length - noLimitOnFile, noLimitOnFile, excursions };
    });
  }

  async zones(now: Date = new Date()): Promise<ZoneView[]> {
    const rows = await this.sql<{ zone_id: string; zone_code: string; zone_name: string; kind: string; log_interval_min: number; bins: string[] | null;
      centi_c: number | null; read_at: string | null; source: string | null; by: string | null; open_exc: number;
      bmin: number | null; bmax: number | null; bsrc: string | null; dev_id: string | null; dev_name: string | null; dev_status: string | null }[]>`
      select z.zone_id::text, z.zone_code, z.zone_name, z.kind, z.log_interval_min,
             (select array_agg(b.bin_code order by b.bin_code) from quality.storage_zone_bin zb join location.bin_master b on b.bin_id = zb.bin_id where zb.zone_id = z.zone_id) as bins,
             r.centi_c, r.read_at::text, r.source, coalesce(u.user_name, u.email, r.recorded_by) as by,
             (select count(*)::int from quality.temperature_excursion e join inventory.lot_hold h on h.lot_hold_id = e.lot_hold_id and h.released_dt is null where e.zone_id = z.zone_id) as open_exc,
             z.min_centi_c as bmin, z.max_centi_c as bmax, z.bounds_source as bsrc, d.device_id::text as dev_id, d.name as dev_name, d.status as dev_status
        from quality.storage_zone z
        left join lateral (select device_id, name, status from platform.device_master dm where dm.kind = 'temp_sensor' and dm.status <> 'revoked' and dm.status <> 'pending'
                            and dm.config->>'zoneId' = z.zone_id::text limit 1) d on true
        left join lateral (select centi_c, read_at, source, recorded_by from quality.temperature_reading t where t.zone_id = z.zone_id order by read_at desc limit 1) r on true
        left join iam.user_master u on u.user_id::text = r.recorded_by
       where z.status = 'ACTIVE' order by z.zone_code`;
    return rows.map((r) => {
      const due = r.read_at ? new Date(Date.parse(r.read_at) + r.log_interval_min * 60_000) : null;
      return {
        zoneId: r.zone_id, code: r.zone_code, name: r.zone_name, kind: r.kind, logIntervalMin: r.log_interval_min, bins: r.bins ?? [],
        source: r.dev_id ? 'SENSOR' as const : 'MANUAL' as const,
        sensor: r.dev_id ? { deviceId: r.dev_id, name: r.dev_name!, status: r.dev_status! } : null,
        bounds: r.bsrc ? { minCentiC: r.bmin, maxCentiC: r.bmax, source: r.bsrc } : null,
        lastReading: r.centi_c === null ? null : { centiC: r.centi_c, text: centiText(r.centi_c), readAt: r.read_at!, source: r.source!, by: r.by ?? '' },
        dueAt: due ? due.toISOString() : null, overdue: !due || due.getTime() <= now.getTime(), openExcursions: r.open_exc,
      };
    });
  }

  async readings(zoneId: string, limit = 50) {
    const rows = await this.sql<{ centi_c: number; read_at: string; source: string; by: string | null; note: string | null }[]>`
      select t.centi_c, t.read_at::text, t.source, coalesce(u.user_name, u.email, t.recorded_by) as by, t.note
        from quality.temperature_reading t left join iam.user_master u on u.user_id::text = t.recorded_by
       where t.zone_id = ${zoneId} order by t.read_at desc limit ${Math.min(Math.max(limit, 1), 500)}`;
    return { items: rows.map((r) => ({ centiC: r.centi_c, text: centiText(r.centi_c), readAt: r.read_at, source: r.source, by: r.by, note: r.note })) };
  }

  /** The floor sweep: an alert for each zone past its interval (or never logged). A reading clears it. */
  async sweepOverdue(now: Date = new Date()): Promise<number> {
    let raised = 0;
    for (const z of await this.zones(now)) {
      if (!z.overdue) continue;
      const ok = await raiseAlert(this.sql, {
        kind: 'TEMP_LOG_OVERDUE', station: GENERAL_STATION, subjectType: 'STORAGE_ZONE', subjectId: z.zoneId,
        title: z.source === 'SENSOR' ? `Temperature sensor silent: ${z.code} (${z.name}). Log it by hand` : `Temperature log overdue: ${z.code} (${z.name})`,
        body: z.lastReading ? `Last logged ${z.lastReading.text} at ${z.lastReading.readAt}; due every ${z.logIntervalMin} min. Next: read the thermometer and log it at the Temperatures screen.`
          : `Never logged; due every ${z.logIntervalMin} min. Next: read the thermometer and log it at the Temperatures screen.`,
        dedupeKey: `temp_overdue:${z.zoneId}`,
      }, now);
      if (ok) raised += 1;
    }
    return raised;
  }
}
