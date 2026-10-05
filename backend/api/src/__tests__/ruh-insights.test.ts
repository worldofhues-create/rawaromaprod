/**
 * Always-on Ruh — the insight store and its routes (ruh/ruh-insights.service.ts, ruh.controller.ts).
 * Real Postgres on a Drizzle-wrapped pool (timestamps come back as text there, exactly as in the
 * running API).
 *
 *   sync:      a finding opens an insight once (dedupe key), a changed one updates in place, a gone
 *              one clears — each mirrored one queues a C3 signal / resolve in the same transaction;
 *              a person's "done"/"dismiss" is respected until the finding clears or gets worse;
 *              an ended snooze comes back;
 *   list:      by role (owner sees all), most serious first, per console, and cheap ("unchanged"
 *              after the caller's rev);
 *   act:       snooze / done / dismiss only by someone the note is for; audited; a second decision
 *              is refused;
 *   override:  an urgent note for the admins, an audit row, and a C3 signal carrying `override`.
 *   routes:    the panel's routes are self-service (audience-checked); settings need their permission.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as bridgeSchema from '@ra/data-bridge';
import { ensureSchema, testClient, closeTestClient, TEST_DATABASE_URL, principal } from '../../../test-support/db.js';
import { META_ANY_AUTHENTICATED, META_PERMISSIONS } from '../../../backend-kernel/src/decorators/metadata.keys.js';
import { RuhInsightsService } from '../ruh/ruh-insights.service.js';
import { RuhSettingsService, RUH_DEFAULTS } from '../ruh/ruh-settings.service.js';
import { RuhSignalService } from '../ruh/ruh-signal.service.js';
import { RuhController } from '../ruh/ruh.controller.js';
import type { C3Signal, InsightDraft } from '../ruh/ruh.contract.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';
import { ROLES as RA_ROLES } from '../../../../scripts/ra-roles.js';

const wrapped = postgres(TEST_DATABASE_URL, { max: 3, prepare: false, types: {}, onnotice: () => {} });
drizzle(wrapped);
const config = { get: () => undefined } as never;
let settings: RuhSettingsService;
let signals: RuhSignalService;
let store: RuhInsightsService;

const prod = principal({ userId: randomUUID(), roles: ['production'], permissions: [] });
const wh = principal({ userId: randomUUID(), roles: ['warehouse'], permissions: [] });
const owner = principal({ userId: randomUUID(), roles: ['owner'], permissions: [] });

function draft(over: Partial<InsightDraft> & { dedupeKey: string }): InsightDraft {
  return {
    kind: 'production.late', severity: 'warn', audienceRoles: ['production'], console: 'factory',
    subject: { type: 'production_requirement', id: randomUUID(), code: 'SO-1' }, title: 'Late', body: 'It is late.',
    deepLink: '#/go/produce/x', prediction: null, mirror: true, ...over,
  };
}
const open = async (key: string) => (await testClient()`select * from platform.ruh_insight where dedupe_key = ${key} order by created_at`) as Array<Record<string, unknown>>;
const queued = async (key: string) => (await testClient()`select op, payload from bridge.ruh_signal where dedupe_key = ${key} and delivered_at is null order by seq`) as Array<{ op: string; payload: C3Signal | null }>;
const KINDS = ['production.late', 'qc.coa_missing', 'shelf.tasks_overdue'];

before(async () => {
  await ensureSchema();
  settings = new RuhSettingsService(wrapped);
  signals = new RuhSignalService(wrapped, drizzle(wrapped, { schema: bridgeSchema }), config);
  store = new RuhInsightsService(wrapped, settings, signals);
  for (const [u, e] of [[prod.userId, 'prod'], [wh.userId, 'wh'], [owner.userId, 'owner']] as const) {
    await testClient()`insert into iam.user_master (user_id, user_name, email, is_active, status) values (${u}, ${e}, ${`${e}-${u.slice(0, 6)}@rawaroma.test`}, true, 'ACTIVE')`;
  }
});
beforeEach(async () => {
  await testClient()`delete from platform.ruh_insight`;
  await testClient()`delete from bridge.ruh_signal`;
  await testClient()`delete from platform.ruh_setting`;
  (settings as unknown as { cache: unknown }).cache = null;
});
after(async () => {
  await wrapped.end();
  await closeTestClient();
});

test('sync: opens once, updates in place, clears when gone — mirrored ones queue a signal / resolve', async () => {
  await settings.update({ 'links.factoryUrl': 'https://rawfactory.example.in' }, owner);
  const d = draft({ dedupeKey: 'late:a' });
  const local = draft({ dedupeKey: 'late:b', mirror: false });
  let r = await store.sync(KINDS, [d, local], '2026-10-06T10:00:00.000Z');
  assert.deepEqual(r, { opened: 2, updated: 0, cleared: 0 });
  assert.equal((await open('late:a')).length, 1);
  const q = await queued('late:a');
  assert.equal(q.length, 1);
  assert.deepEqual(q[0]!.payload, {
    kind: 'production.late', severity: 'warn', title: 'Late', body: 'It is late.', dedupeKey: 'late:a',
    audienceRoles: ['ops'], deepLink: 'https://rawfactory.example.in/#/go/produce/x',
  });
  assert.equal((await queued('late:b')).length, 0, 'a local-only kind never leaves the box');

  const rev1 = (await store.list(owner)).rev;
  r = await store.sync(KINDS, [d, local], '2026-10-06T10:05:00.000Z');
  assert.deepEqual(r, { opened: 0, updated: 0, cleared: 0 });
  assert.equal((await store.list(owner, { since: rev1 })).unchanged, true, 'nothing a person sees changed');

  r = await store.sync(KINDS, [{ ...d, severity: 'urgent', title: 'Overdue' }, local], '2026-10-06T10:10:00.000Z');
  assert.equal(r.updated, 1);
  assert.equal((await open('late:a'))[0]!.severity, 'urgent');
  assert.equal((await queued('late:a'))[0]!.payload!.title, 'Overdue', 'the pending signal is refreshed, not duplicated');
  assert.equal((await store.list(owner, { since: rev1 })).unchanged, false);

  r = await store.sync(KINDS, [], '2026-10-06T10:15:00.000Z');
  assert.equal(r.cleared, 2);
  const [row] = await open('late:a');
  assert.equal(row!.status, 'done');
  assert.ok(row!.resolved_at);
  assert.deepEqual((await queued('late:a')).map((x) => x.op), ['resolve']);
  assert.deepEqual((await queued('late:b')).map((x) => x.op), [], 'never mirrored, never resolved there');
});

test('sync touches only the kinds it was given (a detector that failed keeps its notes)', async () => {
  await store.sync(['qc.coa_missing'], [draft({ dedupeKey: 'qc:1', kind: 'qc.coa_missing' })]);
  await store.sync(['production.late'], []);
  assert.equal((await open('qc:1'))[0]!.status, 'open');
});

test('a person\'s decision holds until the finding clears or gets worse; an ended snooze comes back', async () => {
  const d = draft({ dedupeKey: 'late:c' });
  await store.sync(KINDS, [d]);
  const id = String((await open('late:c'))[0]!.ruh_insight_id);
  await store.act(prod, id, 'dismiss');
  await store.sync(KINDS, [d]);
  assert.equal((await open('late:c')).length, 1, 'not reopened while the same finding persists');
  await store.sync(KINDS, [{ ...d, severity: 'urgent' }]);
  const rows = await open('late:c');
  assert.equal(rows.length, 2, 'got worse: a new open note');
  assert.equal(rows[1]!.status, 'open');
  // clears, then comes back → a new note
  await store.sync(KINDS, []);
  await store.sync(KINDS, [d]);
  assert.equal((await open('late:c')).filter((x) => x.status === 'open').length, 1);

  const s = draft({ dedupeKey: 'late:s' });
  await store.sync(KINDS, [s]);
  const sid = String((await open('late:s'))[0]!.ruh_insight_id);
  await store.act(prod, sid, 'snooze', { minutes: 30 });
  assert.equal((await store.list(prod)).counts.warn, (await store.list(prod)).items.filter((i) => i.status === 'open' && i.severity === 'warn').length);
  assert.equal((await store.list(prod)).items.find((i) => i.id === sid)!.status, 'snoozed');
  await store.sync(KINDS, [s], new Date(Date.now() + 31 * 60_000).toISOString());
  assert.equal((await open('late:s'))[0]!.status, 'open', 'snooze over');
});

test('list: by role, owner sees all, most serious first, per console, cheap when unchanged', async () => {
  await store.sync(KINDS, [
    draft({ dedupeKey: 'p:1', severity: 'suggest' }),
    draft({ dedupeKey: 'p:2', severity: 'urgent' }),
    draft({ dedupeKey: 'w:1', kind: 'shelf.tasks_overdue', audienceRoles: ['warehouse'] }),
    draft({ dedupeKey: 'v:1', kind: 'qc.coa_missing', console: 'platform', audienceRoles: ['production'] }),
  ]);
  const p = await store.list(prod);
  assert.ok(!p.unchanged);
  assert.deepEqual(p.items.map((i) => i.title && i.severity), ['urgent', 'warn', 'suggest']);
  assert.ok(p.items.every((i) => i.kind !== 'shelf.tasks_overdue'), 'a warehouse note is not shown to production');
  assert.deepEqual(p.counts, { urgent: 1, warn: 1, suggest: 1, info: 0 });
  assert.equal(p.top, 'urgent');
  assert.equal((await store.list(owner)).items.length, 4);
  assert.deepEqual((await store.list(prod, { console: 'platform' })).items.map((i) => i.kind), ['qc.coa_missing']);
  assert.deepEqual(await store.list(prod, { since: p.rev }), { unchanged: true, rev: p.rev });
  assert.equal((await store.list(wh)).items.length, 1);
});

test('act: only someone the note is for; audited; a second decision is refused; done/dismiss resolve the mirror', async () => {
  await store.sync(KINDS, [draft({ dedupeKey: 'a:1' })]);
  const id = String((await open('a:1'))[0]!.ruh_insight_id);
  await assert.rejects(store.act(wh, id, 'done'), /another role/);
  const after = await store.act(prod, id, 'done', { note: 'planned it' });
  assert.equal(after.status, 'done');
  await assert.rejects(store.act(prod, id, 'dismiss'), /already done/);
  const [audit] = await testClient()`select actor_id::text, action, entity_type, entity_id::text, after from platform.audit_events
                                       where entity_id = ${id}::uuid`;
  assert.equal(audit!.action, 'ruh.insight.done');
  assert.equal(audit!.actor_id, prod.userId);
  assert.deepEqual((audit!.after as Record<string, unknown>).note, 'planned it');
  assert.deepEqual((await queued('a:1')).map((x) => x.op), ['resolve']);
  await assert.rejects(store.act(prod, randomUUID(), 'done'), /no longer exists/);
  // the owner may act on anything
  await store.sync(KINDS, [draft({ dedupeKey: 'a:2', audienceRoles: ['warehouse'] })]);
  const id2 = String((await open('a:2'))[0]!.ruh_insight_id);
  assert.equal((await store.act(owner, id2, 'snooze', { minutes: 60 })).status, 'snoozed');
});

test('override: an urgent note for the admins, an audit row, and a C3 signal carrying override', async () => {
  const subject = { type: 'production_requirement', id: randomUUID(), code: 'SO-9' };
  const r = await store.recordOverride({
    principal: prod, guard: 'production.plan_out_of_order', actionLabel: 'plan SO-9 ahead of higher-ranked orders',
    reason: 'customer collecting today', risks: [{ code: 'HIGHER_PRIORITY_WAITING', title: '2 higher-ranked orders are waiting', detail: 'SO-1, SO-2', severity: 'warn' }],
    console: 'factory', deepLink: '#/go/produce/x', subject, route: 'POST /v1/produce/requirements/:id/plan',
  });
  const [row] = await testClient()`select * from platform.ruh_insight where ruh_insight_id = ${r.insightId}::uuid`;
  assert.equal(row!.severity, 'urgent');
  assert.equal(row!.source, 'override');
  assert.deepEqual(row!.audience_roles, ['owner', 'admin']);
  assert.match(String(row!.title), /^prod-.*@rawaroma\.test continued past a Ruh warning: plan SO-9 ahead of higher-ranked orders$/);
  const [audit] = await testClient()`select action, entity_type, entity_id::text, after from platform.audit_events where action = 'ruh.override' and entity_id = ${subject.id}::uuid`;
  assert.equal((audit!.after as Record<string, unknown>).reason, 'customer collecting today');
  const [sig] = await queued(r.dedupeKey);
  assert.deepEqual(sig!.payload!.override, {
    actorEmail: String(row!.title).split(' ')[0], action: 'plan SO-9 ahead of higher-ranked orders', reason: 'customer collecting today',
    risks: [{ code: 'HIGHER_PRIORITY_WAITING', title: '2 higher-ranked orders are waiting', detail: 'SO-1, SO-2' }],
  });
  assert.deepEqual(sig!.payload!.audienceRoles, ['admin']);
  assert.equal(sig!.payload!.severity, 'urgent');
  // Even with mirroring switched off, an override still reaches ALEMBIC (it emails the admins).
  await settings.update({ 'signals.enabled': false }, owner);
  const r2 = await store.recordOverride({ principal: prod, guard: 'g', actionLabel: 'x', reason: 'because reasons', risks: [], console: 'factory', deepLink: null, subject, route: 'r' });
  assert.equal((await queued(r2.dedupeKey)).length, 1);
});

test('settings: defaults, validated changes, audited; an unknown key or bad value changes nothing', async () => {
  const d = await settings.describe();
  assert.equal(d.find((x) => x.key === 'watch.intervalSeconds')!.value, RUH_DEFAULTS['watch.intervalSeconds']);
  await settings.update({ 'watch.intervalSeconds': 0, 'guard.coaEdgeMarginPct': 10 }, owner);
  assert.equal((await settings.get())['watch.intervalSeconds'], 0, '0 turns the engine off');
  await assert.rejects(settings.update({ 'nope.key': 1 }, owner), /no Ruh setting/);
  await assert.rejects(settings.update({ 'guard.coaEdgeMarginPct': 500, 'watch.intervalSeconds': 60 }, owner), /coaEdgeMarginPct/);
  assert.equal((await settings.get())['watch.intervalSeconds'], 0, 'a refused change changes nothing');
  await assert.rejects(settings.update({ 'links.vaultUrl': 'http://insecure.example' }, owner), /https/);
  const [a] = await testClient()`select action, after from platform.audit_events where action = 'ruh.settings.changed' order by occurred_at desc limit 1`;
  assert.ok(a);
});

test('routes: the panel is self-service (audience-checked in the service); settings and "check now" need their permission, held by owner and platform admin', () => {
  const r = new Reflector();
  const proto = RuhController.prototype as unknown as Record<string, () => unknown>;
  for (const m of ['list', 'snooze', 'done', 'dismiss']) assert.ok(r.get(META_ANY_AUTHENTICATED, proto[m]!), m);
  assert.deepEqual(r.get(META_PERMISSIONS, proto.putSettings!), ['platform:ruh_setting:write']);
  assert.deepEqual(r.get(META_PERMISSIONS, proto.runNow!), ['platform:ruh_setting:write']);
  assert.deepEqual(r.get(META_PERMISSIONS, proto.getSettings!), ['platform:ruh_setting:read']);
  for (const p of ['platform:ruh_setting:read', 'platform:ruh_setting:write']) assert.ok(RA_PERMISSIONS.includes(p), p);
  const holds = (role: string, p: string) => RA_ROLES.find((x) => x.code === role)!.select(p);
  assert.ok(holds('owner', 'platform:ruh_setting:write'));
  assert.ok(holds('platform_super_admin', 'platform:ruh_setting:write'));
  for (const role of ['production', 'qc', 'warehouse', 'formulator', 'vault_approver', 'showcase', 'admin', 'sales']) {
    assert.ok(!holds(role, 'platform:ruh_setting:write'), `${role} must not change Ruh's thresholds`);
  }
});
