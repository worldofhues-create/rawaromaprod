/**
 * RP-FAC2 — CAPA closure + verification workflow (CapaService, backend/cluster-quality/src/capa/
 * capa.service.ts). Before this lane's change QC_CAPA was table-only CRUD: no workflow, no
 * closure/verification step, and a CAPA could even be inserted already "closed" in one shot.
 * Covers: happy path OPEN→IN_PROGRESS→CLOSED→VERIFIED, invalid transitions (start without an
 * action plan, close before start, verify before close), wrong role via segregation of duties
 * (creator can't verify their own CAPA; assignee can't verify their own remediation), duplicate/
 * concurrent transitions, and the generic-editor status bypass being closed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { CapaService } from '../../../cluster-quality/src/capa/capa.service.js';
import { EditService } from '../edit/edit.service.js';
import { ensureSchema, qualityDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let svc: CapaService;
let editSvc: EditService;

const CREATOR = '00000000-0000-7000-8000-000000000001';
const ASSIGNEE = '00000000-0000-7000-8000-000000000002';
const VERIFIER = '00000000-0000-7000-8000-000000000003';

before(async () => {
  await ensureSchema();
  svc = new CapaService(qualityDb());
  editSvc = new EditService(testClient());
});

after(async () => {
  await closeTestClient();
});

function code() {
  return 'CAPA-' + crypto.randomUUID().slice(0, 8);
}

test('capa: create starts OPEN, not the old create-only ACTIVE', async () => {
  const capa = await svc.createCapa({ capaCode: code() }, principal({ userId: CREATOR }));
  assert.equal(capa.status, 'OPEN');
});

test('capa: cannot start without an action plan', async () => {
  const capa = await svc.createCapa({ capaCode: code(), rootCause: 'root cause noted' }, principal({ userId: CREATOR }));
  await assert.rejects(() => svc.startCapa(capa.qcCapaId, principal({ userId: CREATOR })), ConflictException);
});

test('capa: happy path OPEN -> IN_PROGRESS -> CLOSED -> VERIFIED', async () => {
  const capa = await svc.createCapa(
    { capaCode: code(), rootCause: 'contamination', actionPlan: 'retrain + revalidate', assignedTo: ASSIGNEE },
    principal({ userId: CREATOR }),
  );
  const started = await svc.startCapa(capa.qcCapaId, principal({ userId: CREATOR }));
  assert.equal(started.status, 'IN_PROGRESS');

  const closed = await svc.closeCapa(capa.qcCapaId, { closureEvidence: 'retrain log attached' }, principal({ userId: ASSIGNEE }));
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.closureEvidence, 'retrain log attached');
  assert.ok(closed.closedDt);

  const verified = await svc.verifyCapa(capa.qcCapaId, {}, principal({ userId: VERIFIER }));
  assert.equal(verified.status, 'VERIFIED');
  assert.equal(verified.verifiedBy, VERIFIER);
  assert.ok(verified.verifiedDt);
});

test('capa: cannot close before starting (IN_PROGRESS required)', async () => {
  const capa = await svc.createCapa(
    { capaCode: code(), actionPlan: 'plan' },
    principal({ userId: CREATOR }),
  );
  await assert.rejects(
    () => svc.closeCapa(capa.qcCapaId, { closureEvidence: 'evidence' }, principal({ userId: CREATOR })),
    ConflictException,
  );
});

test('capa: cannot verify before closing (CLOSED required)', async () => {
  const capa = await svc.createCapa(
    { capaCode: code(), actionPlan: 'plan' },
    principal({ userId: CREATOR }),
  );
  await svc.startCapa(capa.qcCapaId, principal({ userId: CREATOR }));
  await assert.rejects(
    () => svc.verifyCapa(capa.qcCapaId, {}, principal({ userId: VERIFIER })),
    ConflictException,
  );
});

test('capa: segregation of duties — the creator cannot verify their own CAPA', async () => {
  const capa = await svc.createCapa(
    { capaCode: code(), actionPlan: 'plan' },
    principal({ userId: CREATOR }),
  );
  await svc.startCapa(capa.qcCapaId, principal({ userId: CREATOR }));
  await svc.closeCapa(capa.qcCapaId, { closureEvidence: 'evidence' }, principal({ userId: CREATOR }));
  await assert.rejects(
    () => svc.verifyCapa(capa.qcCapaId, {}, principal({ userId: CREATOR })),
    ForbiddenException,
  );
});

test('capa: segregation of duties — the assignee cannot verify their own remediation', async () => {
  const capa = await svc.createCapa(
    { capaCode: code(), actionPlan: 'plan', assignedTo: ASSIGNEE },
    principal({ userId: CREATOR }),
  );
  await svc.startCapa(capa.qcCapaId, principal({ userId: CREATOR }));
  await svc.closeCapa(capa.qcCapaId, { closureEvidence: 'evidence' }, principal({ userId: ASSIGNEE }));
  await assert.rejects(
    () => svc.verifyCapa(capa.qcCapaId, {}, principal({ userId: ASSIGNEE })),
    ForbiddenException,
  );
});

test('capa: duplicate/concurrent verify — only one of two concurrent verifications wins', async () => {
  const capa = await svc.createCapa(
    { capaCode: code(), actionPlan: 'plan' },
    principal({ userId: CREATOR }),
  );
  await svc.startCapa(capa.qcCapaId, principal({ userId: CREATOR }));
  await svc.closeCapa(capa.qcCapaId, { closureEvidence: 'evidence' }, principal({ userId: CREATOR }));

  const results = await Promise.allSettled([
    svc.verifyCapa(capa.qcCapaId, {}, principal({ userId: VERIFIER })),
    svc.verifyCapa(capa.qcCapaId, {}, principal({ userId: '00000000-0000-7000-8000-000000000004' })),
  ]);
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(succeeded.length, 1, 'exactly one concurrent verify should win');
  assert.equal(failed.length, 1);
  assert.ok((failed[0] as PromiseRejectedResult).reason instanceof ConflictException);
});

test('capa: the generic EditService editor can no longer PATCH status directly (bypass closed)', async () => {
  const capa = await svc.createCapa({ capaCode: code(), actionPlan: 'plan' }, principal({ userId: CREATOR }));
  const p = principal({ userId: CREATOR, permissions: ['quality:qc_capa:write'] });
  await assert.rejects(
    () => editSvc.update('capas', capa.qcCapaId, { status: 'VERIFIED' }, p),
    /No editable fields supplied/,
  );
});
