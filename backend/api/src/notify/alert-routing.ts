/**
 * ALERT-ROUTING (owner, 2026-11-12): "keep alerts and notifications of any sort to all admin and
 * super admin users always and keep it configurable in admin console so user can change it
 * themselves". RawProd's half of the rule ALEMBIC holds in packages/domain notify/alert-routing.ts.
 *
 * WHO IS AN ADMIN HERE. `owner` (the Factory's "Owner (superadmin)" workspace), `admin`, and
 * `platform_super_admin`; `super_admin` is kept because SEES_ALL_ROLES already named it. Every Ruh
 * insight is visible to all of them (ruh.contract.ts SEES_ALL_ROLES), whatever its audience.
 *
 * THE FLOOR ALERTS. `platform.floor_alert` rows (floor-ops/floor-alerts.ts) were shown only on the
 * station screens and the TV. Each open one is now ALSO a Ruh insight addressed to the admins --
 * the in-app half -- and mirrored to ALEMBIC over the existing C3 signal (no new endpoint, table or
 * event: same `POST /api/v1/internal/rawprod/ruh/signal`, same body). ALEMBIC scopes the kind as
 * `rawprod.floor.*`, routes it as its "RawProd floor" category, and emails its admins by their
 * Notifications settings. The station screens are unchanged.
 *
 * CONFIGURABLE where the owner asked for it: ALEMBIC's Admin -> Notifications (mute, channels,
 * email for the tenant). RawProd sends no email of its own (no RESEND_API_KEY on the box), so there
 * is nothing to configure on this side beyond who sees the insight, which is fixed: every admin.
 *
 * PURE: no clock, no I/O. The watch engine (ruh-watch.service.ts) reads the open rows and resolves
 * an insight whose alert was cleared, because a cleared alert is simply not reported here.
 */
import type { InsightDraft, RuhSeverity } from '../ruh/ruh.contract.js';

export const RAWPROD_ADMIN_ROLES: readonly string[] = ['owner', 'admin', 'platform_super_admin', 'super_admin'];

/** The floor kinds raised today (raiseAlert call sites), and the insight kind each becomes. */
const FLOOR_KINDS = [
  'LINE_STOPPED', 'TEMP_EXCURSION', 'TEMP_LOG_OVERDUE', 'STOCK_DEBIT_REFUSED', 'STOCK_OVER_PICK',
  'device_offline', 'print_parked', 'shipment_hold', 'maceration_overdue', 'maceration_complete',
] as const;

export function floorInsightKind(kind: string): string {
  const k = kind.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'alert';
  return `floor.${/^[a-z]/.test(k) ? k : `x${k}`}`;
}

/** Every kind the floor group may report, plus `floor.other` for a kind added later. */
export const FLOOR_INSIGHT_KINDS: readonly string[] = [...FLOOR_KINDS.map(floorInsightKind), 'floor.other'];

const URGENT = new Set(['LINE_STOPPED', 'TEMP_EXCURSION', 'STOCK_DEBIT_REFUSED']);
const INFO = new Set(['maceration_complete', 'TEST']);

export function floorSeverity(kind: string): RuhSeverity {
  if (URGENT.has(kind)) return 'urgent';
  if (INFO.has(kind)) return 'info';
  return 'warn';
}

export interface OpenFloorAlert {
  floorAlertId: string;
  kind: string;
  station: string | null;
  title: string;
  body: string | null;
  dedupeKey: string;
  raisedAt: string | null;
}

export function detectFloorAlerts(rows: readonly OpenFloorAlert[]): InsightDraft[] {
  const known = new Set(FLOOR_INSIGHT_KINDS);
  return rows.filter((r) => r.kind !== 'TEST').map((r) => {
    const mapped = floorInsightKind(r.kind);
    const kind = known.has(mapped) ? mapped : 'floor.other';
    const where = r.station ? ` (${r.station})` : '';
    return {
      kind,
      severity: floorSeverity(r.kind),
      audienceRoles: [...RAWPROD_ADMIN_ROLES],
      console: 'factory' as const,
      subject: { type: 'floor_alert', id: r.floorAlertId },
      title: `${r.title}${where}`.slice(0, 200),
      body: `${r.body ? `${r.body} ` : ''}It is on the station screens and the floor TV until it is cleared.`.slice(0, 2000),
      deepLink: '#/go/floorboard',
      prediction: null,
      dedupeKey: `floor:${r.dedupeKey}`.slice(0, 240),
      mirror: true,
    };
  });
}
