/**
 * FEATURE-SWITCHES (owner, 26 Nov 2026: "nothing should be a stub"): EVERY SWITCH STOPS WHAT IT NAMES.
 *
 * For each registered key (packages/contracts FLAGS), the real route handlers it guards are listed
 * below by class and method. For each one this proves, through the real FlagGuard and the real
 * decorator metadata on that exact method:
 *   - off: the request is refused 503 FEATURE_DISABLED with the registry's own sentence (words, not a code);
 *   - on again: the guard lets it through.
 * And, so the list cannot drift from the code:
 *   - every key in the registry guards at least one route here, or is one of the two keys wired in a
 *     service instead (`all.auth` in AuthService, auth-service-assertion.test.ts; `admin.flags.write`
 *     in FlagsController, flags-admin.test.ts);
 *   - every `@RequiredFlag` in a mounted controller is listed here (a new one must be added);
 *   - every listed controller is mounted in AppModule, where FlagGuard is the global guard;
 *   - none of the template keys for another product survives anywhere in the code.
 * No database: the guard reads the in-memory snapshot, exactly as in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { FLAGS, flagOffSentence } from '@core/contracts';
import { FlagGuard } from '../../../backend-kernel/src/edge/flag.guard.js';
import { FlagsService } from '../../../backend-kernel/src/flags/flags.service.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import { DocumentsController } from '../documents/documents.controller.js';
import { FactoryDeskController } from '../factory-desk/factory-desk.controller.js';
import { FloorController } from '../floor/floor.controller.js';
import { PackagingQcController } from '../packaging-qc/packaging-qc.controller.js';
import { ProdfloorController } from '../prodfloor/prodfloor.controller.js';
import { SearchController } from '../search/search.controller.js';
import { BatchController } from '../../../cluster-inventory/src/batch/batch.controller.js';
import { GateController } from '../../../cluster-inventory/src/gate/gate.controller.js';
import { PoController } from '../../../cluster-procurement/src/po/po.controller.js';
import { CoaController } from '../../../cluster-production/src/coa/coa.controller.js';
import { InspectionsController } from '../../../cluster-quality/src/inspections/inspections.controller.js';
import { DocumentController } from '../../../cluster-reference/src/document/document.controller.js';

type Ctl = { prototype: object; name: string };
const handlerOf = (cls: Ctl, method: string): unknown => (cls.prototype as Record<string, unknown>)[method];
/* [controller, handler method, the switch, the route as the controller declares it] */
const WIRED: ReadonlyArray<readonly [Ctl, string, string, string]> = [
  [FloorController, 'create', 'production.batch.start', 'POST v1/floor/jobs'],
  [FloorController, 'pickLine', 'floor.kiosk.writes', 'POST v1/floor/jobs/:id/pick/lines/:line'],
  [FloorController, 'completePick', 'floor.kiosk.writes', 'POST v1/floor/jobs/:id/pick/complete'],
  [FloorController, 'verifyLine', 'floor.kiosk.writes', 'POST v1/floor/jobs/:id/verify/lines/:line'],
  [FloorController, 'resumeLine', 'floor.kiosk.writes', 'POST v1/floor/jobs/:id/stop/resume'],
  [FloorController, 'approveOverPick', 'floor.kiosk.writes', 'POST v1/floor/lines/:line/over-pick'],
  [FloorController, 'completeVerify', 'floor.kiosk.writes', 'POST v1/floor/jobs/:id/verify/complete'],
  [FloorController, 'leftover', 'floor.kiosk.writes', 'POST v1/floor/jobs/:id/leftover'],
  [FloorController, 'step', 'floor.kiosk.writes', 'POST v1/floor/jobs/:id/mix/steps/:seq'],
  [FloorController, 'assignMixer', 'floor.kiosk.writes', 'POST v1/floor/jobs/:id/mix/assign'],
  [FloorController, 'completeMix', 'floor.kiosk.writes', 'POST v1/floor/jobs/:id/mix/complete'],
  [InspectionsController, 'dispose', 'qc.release', 'POST v1/qc-inspections/:id/disposition'],
  [FactoryDeskController, 'decideQc', 'qc.release', 'POST v1/prodfloor/qc/batches/:id/rounds/:round/decision'],
  [PackagingQcController, 'create', 'qc.release', 'POST v1/packaging-qc'],
  [CoaController, 'release', 'qc.release', 'POST v1/batch-coas/:id/release'],
  [BatchController, 'releaseRmBatch', 'qc.release', 'POST v1/rm-batches/:id/release'],
  [PoController, 'approvePurchaseOrder', 'procurement.po.approve', 'POST v1/purchase-orders/:id/approve'],
  [ProdfloorController, 'payApprove', 'all.payments', 'POST v1/prodfloor/payments/:id/approve'],
  [ProdfloorController, 'payRelease', 'all.payments', 'POST v1/prodfloor/payments/:id/release'],
  [InspectionsController, 'createAttachment', 'all.uploads', 'POST v1/qc-attachments'],
  [GateController, 'createGateEntryDocument', 'all.uploads', 'POST v1/gate-entry-documents'],
  [DocumentsController, 'create', 'all.uploads', 'POST v1/document-registry'],
  [DocumentController, 'createDocument', 'all.uploads', 'POST v1/documents'],
  [SearchController, 'search', 'all.search', 'GET v1/search'],
];
const IN_A_SERVICE = new Set(['all.auth', 'admin.flags.write']);
const TEMPLATE_KEYS = ['buyer.search.ai', 'buyer.offers.counter', 'owner.listings.submit', 'builder.projects.import', 'ops.assignment.auto'];

const ctx = (cls: Ctl, method: string) => ({ getHandler: () => handlerOf(cls, method), getClass: () => cls }) as never;

test('every wired route is refused in the registry\'s words while its switch is off, and let through when it is on again', () => {
  for (const [cls, method, key, route] of WIRED) {
    assert.equal(typeof handlerOf(cls, method), 'function', `${cls.name}.${method} (${route}) is not a handler`);
    const flags = new FlagsService();
    const guard = new FlagGuard(new Reflector(), flags);
    flags.load(FLAGS.map((f) => ({ key: f.key, state: 'on' as const, targeting: null })));
    assert.equal(guard.canActivate(ctx(cls, method)), true, `${route} must pass while ${key} is on`);
    flags.set({ key, state: 'off', targeting: null });
    assert.throws(() => guard.canActivate(ctx(cls, method)),
      (e: unknown) => e instanceof DomainError && e.status === 503 && e.code === 'FEATURE_DISABLED' && e.message === flagOffSentence(key),
      `${route} must be refused, in words, while ${key} is off`);
    /* another switch off does not stop this route */
    flags.set({ key, state: 'on', targeting: null });
    for (const other of FLAGS.filter((f) => f.key !== key)) flags.set({ key: other.key, state: 'off', targeting: null });
    assert.equal(guard.canActivate(ctx(cls, method)), true, `${route} must be stopped by ${key} only`);
    /* degraded is "reachable but limited": the route still answers */
    flags.load([{ key, state: 'degraded', targeting: null }]);
    assert.equal(guard.canActivate(ctx(cls, method)), true);
  }
});

test('every switch in the registry guards real code, says what it stops, and has a sentence for a refusal', () => {
  const wiredKeys = new Set(WIRED.map((w) => w[2]));
  for (const f of FLAGS) {
    assert.ok(wiredKeys.has(f.key) || IN_A_SERVICE.has(f.key), `${f.key} guards nothing: wire it or remove it`);
    assert.ok(f.description.length > 10 && f.whenOff.length > 10 && f.guards.length > 5, `${f.key} must say what it stops`);
  }
  for (const k of ['production.batch.start', 'floor.kiosk.writes', 'qc.release', 'all.auth', 'all.payments', 'admin.flags.write']) {
    assert.equal(FLAGS.find((f) => f.key === k)?.critical, true, `${k} stops production, sign-in, money or the switches: it is critical`);
  }
});

const BACKEND = fileURLToPath(new URL('../../..', import.meta.url));
const REPO = join(BACKEND, '..');
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === '.next' || e === '__tests__') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|js|mjs)$/.test(e) && !/\.test\.ts$/.test(e)) out.push(p);
  }
  return out;
}

test('every @RequiredFlag in a mounted controller is in the list above, on the method it names', () => {
  const listed = new Set(WIRED.map((w) => `${w[2]} ${w[3]}`));
  const found: string[] = [];
  for (const f of sources(BACKEND)) {
    if (!f.endsWith('.controller.ts') || f.includes('cluster-identity')) continue; /* cluster-identity is the retired @core auth, not mounted */
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      const m = /@RequiredFlag\('([^']+)'\)/.exec(l);
      if (!m) return;
      const near = lines.slice(i, i + 6).join('\n');
      const r = /@(Get|Post|Put)\('([^']+)'\)/.exec(near);
      found.push(`${m[1]} ${r ? r[1]!.toUpperCase() + ' ' + r[2] : '?'}  (${relative(BACKEND, f)})`);
    });
  }
  assert.deepEqual(found.map((x) => x.split('  (')[0]).sort(), [...listed].sort(), found.join('\n'));
});

test('the guard is global on the main API, and every listed controller is mounted there', () => {
  const app = readFileSync(join(BACKEND, 'api/src/app.module.ts'), 'utf8');
  assert.match(app, /\{ provide: APP_GUARD, useClass: FlagGuard \}/);
  /* each controller's module is imported by AppModule (directly, or as a cluster module) */
  const MODULE_OF: Record<string, string> = {
    FloorController: 'FloorModule', InspectionsController: 'QualityModule', FactoryDeskController: 'FactoryDeskModule',
    PackagingQcController: 'PackagingQcModule', CoaController: 'ProductionModule', BatchController: 'ClusterInventoryModule',
    GateController: 'ClusterInventoryModule', PoController: 'ClusterProcurementModule', ProdfloorController: 'ProdfloorModule',
    DocumentsController: 'DocumentsModule', DocumentController: 'ReferenceModule', SearchController: 'SearchModule',
  };
  for (const [cls] of WIRED) assert.match(app, new RegExp(`\\b${MODULE_OF[cls.name]}\\b`), `${cls.name}'s module (${MODULE_OF[cls.name]}) is not imported by AppModule`);
});

test('the template keys of another product are gone from the code', () => {
  const hits: string[] = [];
  for (const f of [...sources(BACKEND), ...sources(join(REPO, 'packages')), ...sources(join(REPO, 'scripts'))]) {
    if (f.includes('/migrations/')) continue; /* the registering migration removes their rows by name */
    const s = readFileSync(f, 'utf8');
    for (const k of TEMPLATE_KEYS) if (s.includes(`'${k}'`) || s.includes(`"${k}"`)) hits.push(`${k} in ${relative(REPO, f)}`);
  }
  assert.deepEqual(hits, []);
});
