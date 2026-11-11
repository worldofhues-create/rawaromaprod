/**
 * ALERT-ROUTING (owner, 2026-11-12): "keep alerts and notifications of any sort to all admin and
 * super admin users always". RawProd's half, PURE:
 *
 *   - who the admins are here (owner = the Factory's superadmin workspace, admin,
 *     platform_super_admin), and that every Ruh insight is visible to them;
 *   - every open floor alert (platform.floor_alert -- LINE_STOPPED, TEMP_EXCURSION,
 *     TEMP_LOG_OVERDUE, a device offline, ...) becomes a Ruh insight for the admins, IN ADDITION
 *     to the station screens and the TV it is already on, and is mirrored to ALEMBIC over the
 *     existing C3 contract so ALEMBIC's admins are told too (kind `floor.*`, which ALEMBIC scopes
 *     as `rawprod.floor.*` and routes as its "RawProd floor" category).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RAWPROD_ADMIN_ROLES, detectFloorAlerts, FLOOR_INSIGHT_KINDS, floorInsightKind, floorSeverity } from '../notify/alert-routing.js';
import { SEES_ALL_ROLES, toC3Signal } from '../ruh/ruh.contract.js';
import { DETECTOR_KINDS } from '../ruh/ruh-detectors.js';

const LINKS = { factory: 'https://rawfactory.example', platform: null, vault: null };

test('the admins: owner, admin and platform_super_admin all see every Ruh insight', () => {
  for (const r of ['owner', 'admin', 'platform_super_admin']) {
    assert.ok(RAWPROD_ADMIN_ROLES.includes(r), r);
    assert.ok(SEES_ALL_ROLES.includes(r), `${r} sees every insight`);
  }
});

test('floor alert kinds map to insight kinds ALEMBIC accepts (area.what, lower case)', () => {
  assert.equal(floorInsightKind('LINE_STOPPED'), 'floor.line_stopped');
  assert.equal(floorInsightKind('device_offline'), 'floor.device_offline');
  assert.equal(floorInsightKind('Weird-Kind!'), 'floor.weird_kind');
  for (const k of FLOOR_INSIGHT_KINDS) assert.match(k, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  assert.deepEqual([...DETECTOR_KINDS.floor], [...FLOOR_INSIGHT_KINDS], 'the floor group is registered with the watch engine');
});

test('a stopped line and a temperature excursion are urgent; an overdue log warns', () => {
  assert.equal(floorSeverity('LINE_STOPPED'), 'urgent');
  assert.equal(floorSeverity('TEMP_EXCURSION'), 'urgent');
  assert.equal(floorSeverity('TEMP_LOG_OVERDUE'), 'warn');
  assert.equal(floorSeverity('maceration_complete'), 'info');
});

test('every open floor alert becomes one admin insight, mirrored to ALEMBIC for its admins', () => {
  const drafts = detectFloorAlerts([
    { floorAlertId: 'a1', kind: 'LINE_STOPPED', station: 'Floor', title: 'Line stopped at Mix', body: 'Mixer 2 is waiting on a weight', dedupeKey: 'line_stopped:j1', raisedAt: '2026-11-12T05:00:00.000Z' },
    { floorAlertId: 'a2', kind: 'TEMP_EXCURSION', station: 'Floor', title: 'Cold room at 31.00 °C', body: null, dedupeKey: 'temp:z1', raisedAt: '2026-11-12T05:01:00.000Z' },
  ]);
  assert.equal(drafts.length, 2);
  const d = drafts[0]!;
  assert.equal(d.kind, 'floor.line_stopped');
  assert.equal(d.severity, 'urgent');
  assert.deepEqual(d.audienceRoles, [...RAWPROD_ADMIN_ROLES]);
  assert.equal(d.mirror, true);
  assert.equal(d.dedupeKey, 'floor:line_stopped:j1');
  assert.match(d.body, /station screens/);
  const c3 = toC3Signal(d, LINKS);
  assert.deepEqual(c3.audienceRoles, ['admin'], 'ALEMBIC side: its admins');
  assert.equal(c3.kind, 'floor.line_stopped');
  assert.ok(c3.deepLink?.startsWith('https://rawfactory.example/#/go/floorboard'));
});

test('a cleared alert is simply not reported, so the watch engine resolves its insight', () => {
  assert.deepEqual(detectFloorAlerts([]), []);
});
