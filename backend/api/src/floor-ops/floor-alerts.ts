/**
 * Station alerts (platform.floor_alert, lane pf-c): a printer gone offline, a maceration that has
 * reached its minimum time, a shipment held at logistics. One open row per dedupe key, so a sweep
 * that runs again does not raise a second alert; clearing closes it. Shown on the station's
 * screens and on the TV display.
 */
import { uuidv7 } from '@core/data-kernel';
import type { Sql } from 'postgres';
import { iso } from './floor-util.js';

/** STOCK3-3: an alert for the whole floor. Every station's screens and TV carry these as well as their own. */
export const GENERAL_STATION = 'Floor';

export interface AlertDraft {
  kind: string;
  station: string | null;
  subjectType: string | null;
  subjectId: string | null;
  title: string;
  body?: string | null;
  dedupeKey: string;
}

/** Raises an alert unless one with the same key is open. Returns true when a new one was raised. */
export async function raiseAlert(sql: Sql, a: AlertDraft, at: Date): Promise<boolean> {
  const rows = await sql`
    insert into platform.floor_alert (floor_alert_id, kind, station, subject_type, subject_id, title, body, dedupe_key, raised_at)
    values (${uuidv7()}::uuid, ${a.kind}, ${a.station}, ${a.subjectType}, ${a.subjectId}::uuid, ${a.title}, ${a.body ?? null}, ${a.dedupeKey}, ${at.toISOString()}::timestamptz)
    on conflict (dedupe_key) where cleared_at is null do nothing
    returning floor_alert_id`;
  return rows.length > 0;
}

export async function clearAlert(sql: Sql, dedupeKey: string, at: Date): Promise<void> {
  await sql`update platform.floor_alert set cleared_at = ${at.toISOString()}::timestamptz where dedupe_key = ${dedupeKey} and cleared_at is null`;
}

export async function openAlerts(sql: Sql, station?: string | null) {
  const rows = await sql`
    select floor_alert_id, kind, station, subject_type, subject_id, title, body, raised_at, acked_at
      from platform.floor_alert
     where cleared_at is null ${station ? sql`and (station = ${station} or station = ${GENERAL_STATION} or station is null)` : sql``}
     order by raised_at desc
     limit 200`;
  return rows.map((r) => ({
    floorAlertId: String(r.floor_alert_id),
    kind: String(r.kind),
    station: (r.station as string | null) ?? null,
    subjectType: (r.subject_type as string | null) ?? null,
    subjectId: (r.subject_id as string | null) ?? null,
    title: String(r.title),
    body: (r.body as string | null) ?? null,
    raisedAt: iso(r.raised_at),
    ackedAt: iso(r.acked_at),
  }));
}

export async function ackAlert(sql: Sql, id: string, userId: string, at: Date): Promise<boolean> {
  const rows = await sql`
    update platform.floor_alert set acked_at = ${at.toISOString()}::timestamptz, acked_by = ${userId}::uuid
     where floor_alert_id = ${id}::uuid and cleared_at is null and acked_at is null
     returning floor_alert_id`;
  return rows.length > 0;
}
