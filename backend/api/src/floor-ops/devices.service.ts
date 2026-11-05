/**
 * DevicesService (lane pf-c, plan section 2) — the device registry: label printers (through the
 * print agent), TV displays, kiosk tablets and scales, each bound to ONE station.
 *
 *   create        Admin -> Platform -> Devices -> Add device. Returns a 6-digit code (and the page
 *                 draws it as a QR) valid for 10 minutes. Only the code's sha-256 is stored.
 *   pair          the device sends the code and receives its station-scoped token, once. Pairing
 *                 again (a new code) revokes the old token. The token is NOT a user login: a
 *                 paired kiosk shows its station's screen, and a person still signs in to act.
 *   authenticate  token -> device; a revoked token or device is refused at once.
 *   heartbeat     every 60 s; marks the device seen and clears its offline alert.
 *   sweepOffline  a device silent for OFFLINE_AFTER_MS is marked offline and raises an alert at
 *                 its station (the worker runs this; the TV and the station screens show it).
 *   revoke        instant: the device, its tokens and any open code stop working.
 *
 * Wrong pairing codes are throttled (a 6-digit code is only safe because there are few tries).
 */
import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import type { Sql } from 'postgres';
import { clearAlert, openAlerts, raiseAlert } from './floor-alerts.js';
import { FLOOR_CLOCK } from './floor.tokens.js';
import { iso, newDeviceToken, sha256, sixDigitCode, systemClock, text, type Clock } from './floor-util.js';

export const DEVICE_KINDS = ['label_printer', 'display', 'kiosk', 'scale'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** Heartbeat is every 60 s; two missed beats make a device offline. */
export const OFFLINE_AFTER_MS = 2 * 60 * 1000;
/** Wrong codes allowed per minute, across all callers, before pairing pauses for the minute. */
export const PAIR_FAILS_PER_MINUTE = 20;

export interface PairedDevice {
  deviceId: string;
  kind: DeviceKind;
  station: string;
  name: string;
  config: Record<string, unknown>;
}

const KIND_WORD: Record<DeviceKind, string> = { label_printer: 'Printer', display: 'Display', kiosk: 'Kiosk', scale: 'Scale' };

@Injectable()
export class DevicesService {
  private failWindowStart = 0;
  private failCount = 0;

  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    @Optional() @Inject(FLOOR_CLOCK) clock?: Clock,
  ) {
    this.clock = clock ?? systemClock;
  }
  private readonly clock: Clock;

  async create(body: Record<string, unknown>, principal: AuthPrincipal) {
    const kind = String(body.kind ?? '') as DeviceKind;
    if (!DEVICE_KINDS.includes(kind)) throw new BadRequestException(`kind must be one of ${DEVICE_KINDS.join(', ')}.`);
    const station = text(body, 'station', 80)!;
    const name = text(body, 'name', 120)!;
    const site = text(body, 'site', 80, false);
    const config = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? (body.config as Record<string, unknown>) : {};
    if (JSON.stringify(config).length > 4000) throw new BadRequestException('config is too large.');
    const deviceId = uuidv7();
    const now = this.clock();
    const [row] = await this.sql`
      insert into platform.device_master (device_id, kind, station, site, name, status, config, created_by, created_at, updated_at)
      values (${deviceId}::uuid, ${kind}, ${station}, ${site}, ${name}, 'pending', ${JSON.stringify(config)}::text::jsonb, ${principal.userId}::uuid,
              ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)
      returning *`;
    const pairing = await this.issueCode(deviceId, principal);
    return { device: this.shape(row!), pairing };
  }

  /** A fresh code for a device (re-pair, or the first code expired). Older open codes stop working. */
  async newPairingCode(deviceId: string, principal: AuthPrincipal) {
    const [dev] = await this.sql`select status from platform.device_master where device_id = ${deviceId}::uuid`;
    if (!dev) throw new NotFoundException('That device was not found.');
    if (dev.status === 'revoked') throw new ConflictException('That device was revoked. Add it again to pair it.');
    return this.issueCode(deviceId, principal);
  }

  private async issueCode(deviceId: string, principal: AuthPrincipal) {
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
    await this.sql`update platform.device_pairing set used_at = ${now.toISOString()}::timestamptz where device_id = ${deviceId}::uuid and used_at is null`;
    // A collision with another device's OPEN code is astronomically rare but would make a code
    // ambiguous; the partial unique index refuses it, and we draw again.
    for (let i = 0; i < 5; i++) {
      const code = sixDigitCode();
      try {
        await this.sql`
          insert into platform.device_pairing (pairing_id, device_id, code_hash, expires_at, created_by, created_at)
          values (${uuidv7()}::uuid, ${deviceId}::uuid, ${sha256(code)}, ${expiresAt.toISOString()}::timestamptz, ${principal.userId}::uuid, ${now.toISOString()}::timestamptz)`;
        return { code, expiresAt: expiresAt.toISOString(), validMinutes: PAIRING_TTL_MS / 60000 };
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
      }
    }
    throw new ConflictException('Could not issue a pairing code. Try again.');
  }

  async pair(code: unknown, info?: Record<string, unknown>) {
    const c = typeof code === 'string' ? code.trim() : '';
    if (!/^\d{6}$/.test(c)) throw new BadRequestException('The pairing code is 6 digits.');
    this.checkThrottle();
    const now = this.clock();
    return this.sql.begin(async (tx) => {
      const [p] = await tx`
        select dp.pairing_id, dp.device_id, dp.expires_at > ${now.toISOString()}::timestamptz as fresh, dm.status
          from platform.device_pairing dp
          join platform.device_master dm on dm.device_id = dp.device_id
         where dp.code_hash = ${sha256(c)} and dp.used_at is null
         for update of dp`;
      if (!p || !p.fresh || p.status === 'revoked') {
        this.noteFailure();
        throw new UnauthorizedException('That pairing code is not valid. Codes last 10 minutes and work once; ask for a new one.');
      }
      await tx`update platform.device_pairing set used_at = ${now.toISOString()}::timestamptz where pairing_id = ${p.pairing_id}::uuid`;
      await tx`update platform.device_token set revoked_at = ${now.toISOString()}::timestamptz where device_id = ${p.device_id}::uuid and revoked_at is null`;
      const [dev] = await tx`
        update platform.device_master
           set status = 'active', paired_at = ${now.toISOString()}::timestamptz, last_seen_at = ${now.toISOString()}::timestamptz,
               updated_at = ${now.toISOString()}::timestamptz,
               config = config || ${JSON.stringify({ agent: info && typeof info === 'object' ? JSON.stringify(info).slice(0, 300) : null })}::text::jsonb
         where device_id = ${p.device_id}::uuid
         returning *`;
      const token = newDeviceToken();
      await tx`
        insert into platform.device_token (device_token_id, device_id, station, token_hash, created_at)
        values (${uuidv7()}::uuid, ${p.device_id}::uuid, ${dev!.station}, ${sha256(token)}, ${now.toISOString()}::timestamptz)`;
      return { token, device: this.paired(dev!) };
    });
  }

  async authenticate(token: unknown): Promise<PairedDevice> {
    const t = typeof token === 'string' ? token.trim() : '';
    if (!t.startsWith('rdt_')) throw new UnauthorizedException('This device is not paired.');
    const [row] = await this.sql`
      select dm.*, dt.device_token_id
        from platform.device_token dt
        join platform.device_master dm on dm.device_id = dt.device_id
       where dt.token_hash = ${sha256(t)} and dt.revoked_at is null and dm.status <> 'revoked'`;
    if (!row) throw new UnauthorizedException('This device token is not recognised or was revoked. Pair the device again.');
    await this.sql`update platform.device_token set last_used_at = ${this.clock().toISOString()}::timestamptz where device_token_id = ${row.device_token_id}::uuid`;
    return this.paired(row);
  }

  async heartbeat(device: PairedDevice) {
    const now = this.clock();
    await this.sql`
      update platform.device_master
         set last_seen_at = ${now.toISOString()}::timestamptz,
             status = case when status = 'offline' then 'active' else status end,
             updated_at = ${now.toISOString()}::timestamptz
       where device_id = ${device.deviceId}::uuid and status <> 'revoked'`;
    await clearAlert(this.sql, `device_offline:${device.deviceId}`, now);
    return { ok: true, at: now.toISOString(), nextInSeconds: 60 };
  }

  async sweepOffline() {
    const now = this.clock();
    const cutoff = new Date(now.getTime() - OFFLINE_AFTER_MS).toISOString();
    const gone = await this.sql`
      update platform.device_master
         set status = 'offline', updated_at = ${now.toISOString()}::timestamptz
       where status = 'active' and coalesce(last_seen_at, paired_at) < ${cutoff}::timestamptz
       returning device_id, kind, station, name`;
    const stillOff = await this.sql`select device_id, kind, station, name from platform.device_master where status = 'offline'`;
    for (const d of stillOff) {
      await raiseAlert(this.sql, {
        kind: 'device_offline',
        station: String(d.station),
        subjectType: 'device',
        subjectId: String(d.device_id),
        title: `${KIND_WORD[d.kind as DeviceKind] ?? 'Device'} offline: ${d.name}`,
        body: d.kind === 'label_printer'
          ? 'Labels for this station are queued. Use browser print, or check the printer and the print agent.'
          : 'No heartbeat for over 2 minutes. Check its power and network.',
        dedupeKey: `device_offline:${d.device_id}`,
      }, now);
    }
    return { offline: gone.map((g) => String(g.device_id)) };
  }

  async revoke(deviceId: string, principal: AuthPrincipal) {
    const now = this.clock().toISOString();
    return this.sql.begin(async (tx) => {
      const [dev] = await tx`
        update platform.device_master set status = 'revoked', revoked_at = ${now}::timestamptz, revoked_by = ${principal.userId}::uuid, updated_at = ${now}::timestamptz
         where device_id = ${deviceId}::uuid returning *`;
      if (!dev) throw new NotFoundException('That device was not found.');
      await tx`update platform.device_token set revoked_at = ${now}::timestamptz where device_id = ${deviceId}::uuid and revoked_at is null`;
      await tx`update platform.device_pairing set used_at = ${now}::timestamptz where device_id = ${deviceId}::uuid and used_at is null`;
      await tx`update platform.floor_alert set cleared_at = ${now}::timestamptz where dedupe_key = ${'device_offline:' + deviceId} and cleared_at is null`;
      return this.shape(dev);
    });
  }

  async update(deviceId: string, body: Record<string, unknown>) {
    const name = text(body, 'name', 120, false);
    const station = text(body, 'station', 80, false);
    const config = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? (body.config as Record<string, unknown>) : null;
    const [dev] = await this.sql`
      update platform.device_master
         set name = coalesce(${name}, name), station = coalesce(${station}, station),
             config = case when ${config ? 'y' : 'n'} = 'y' then ${JSON.stringify(config ?? {})}::text::jsonb else config end,
             updated_at = ${this.clock().toISOString()}::timestamptz
       where device_id = ${deviceId}::uuid and status <> 'revoked'
       returning *`;
    if (!dev) throw new NotFoundException('That device was not found or was revoked.');
    // A device moved to another station keeps no token for the old one.
    if (station) await this.sql`update platform.device_token set station = ${station} where device_id = ${deviceId}::uuid and revoked_at is null`;
    return this.shape(dev);
  }

  async list() {
    const rows = await this.sql`select * from platform.device_master order by station, kind, name`;
    return rows.map((r) => this.shape(r));
  }

  alerts(station?: string | null) {
    return openAlerts(this.sql, station);
  }

  private shape(r: Record<string, unknown>) {
    const lastSeen = iso(r.last_seen_at);
    const online = r.status === 'active' && !!lastSeen && this.clock().getTime() - new Date(lastSeen).getTime() <= OFFLINE_AFTER_MS;
    return {
      deviceId: String(r.device_id),
      kind: r.kind as DeviceKind,
      station: String(r.station),
      site: (r.site as string | null) ?? null,
      name: String(r.name),
      status: String(r.status),
      online,
      config: (typeof r.config === 'string' ? JSON.parse(r.config) : r.config) as Record<string, unknown>,
      lastSeenAt: lastSeen,
      pairedAt: iso(r.paired_at),
      revokedAt: iso(r.revoked_at),
      createdAt: iso(r.created_at),
    };
  }

  private paired(r: Record<string, unknown>): PairedDevice {
    const s = this.shape(r);
    return { deviceId: s.deviceId, kind: s.kind, station: s.station, name: s.name, config: s.config };
  }

  private checkThrottle() {
    const t = this.clock().getTime();
    if (t - this.failWindowStart > 60_000) { this.failWindowStart = t; this.failCount = 0; }
    if (this.failCount >= PAIR_FAILS_PER_MINUTE) {
      throw new HttpException('Too many wrong pairing codes. Wait a minute and try again.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
  private noteFailure() {
    this.failCount++;
  }
}
